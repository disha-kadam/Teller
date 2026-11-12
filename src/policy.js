/**
 * The guardrail layer.
 *
 * This is the heart of Teller, and the reason it is different from "an LLM
 * that can call the PayPal API".
 *
 * Three ideas:
 *
 *  1. ENFORCEMENT IS NOT PROMPTING. The model is shown the policy so it
 *     behaves sensibly, but every money-moving tool call is run through
 *     `evaluate()` *after* the model has chosen its arguments. Prompt
 *     injection in a customer email, a jailbreak, or a plain hallucination
 *     cannot widen these limits, because the limits are not implemented in
 *     the model's head. They are implemented here, in `if` statements.
 *
 *  2. THE INTERESTING ANSWER IS "ASK A HUMAN". A guardrail that only says yes
 *     or no is a blunt instrument. Most real decisions are "fine, do it" /
 *     "fine, but a person signs off" / "absolutely not". So `evaluate()`
 *     returns one of three decisions, and `needs_approval` routes the action
 *     into a queue instead of throwing it away.
 *
 *  3. EVERY DECISION EXPLAINS ITSELF. Each result carries the rule that
 *     fired and a sentence a non-technical owner can read. That sentence goes
 *     into the audit log and onto the approval card in the UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { readAudit } from './store.js';

const POLICY_FILE = path.join(ROOT, 'policy.json');

export function loadPolicy() {
  return JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
}

export const ALLOW = 'allow';
export const NEEDS_APPROVAL = 'needs_approval';
export const DENY = 'deny';

/** Tool calls that move money. Everything else is read-only or a draft. */
export const MONEY_MOVING_TOOLS = new Set([
  'refund_payment',
  'create_invoice',
  'send_invoice',
  'send_payment',
]);

const money = (n) => Number(Number(n ?? 0).toFixed(2));
const daysBetween = (iso) =>
  !iso ? 0 : Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

function result(decision, rule, reason, extra = {}) {
  return { decision, rule, reason, ...extra };
}

/** How much Teller has already auto-approved in refunds today. */
function autoRefundedToday() {
  const todayPrefix = new Date().toISOString().slice(0, 10);
  return readAudit(1000)
    .filter(
      (entry) =>
        entry.tool === 'refund_payment' &&
        entry.outcome === 'executed' &&
        entry.policy?.decision === ALLOW &&
        String(entry.at).startsWith(todayPrefix)
    )
    .reduce((sum, entry) => sum + money(entry.args?.amount ?? 0), 0);
}

/**
 * Decide whether a proposed tool call may proceed.
 *
 * @param {string} tool    tool name the agent wants to call
 * @param {object} args    arguments the agent chose
 * @param {object} context extra facts the policy needs that the agent cannot
 *                         be trusted to supply -- notably the *actual* capture
 *                         fetched from PayPal, not the amount the model claimed
 * @returns {{decision: string, rule: string, reason: string}}
 */
export function evaluate(tool, args = {}, context = {}) {
  const policy = loadPolicy();

  if (!MONEY_MOVING_TOOLS.has(tool)) {
    return result(ALLOW, 'read_only', 'This action does not move money.');
  }

  const currency = (args.currency || policy.currency || 'USD').toUpperCase();
  if (!policy.allowed_currencies.includes(currency)) {
    return result(
      DENY,
      'allowed_currencies',
      `${currency} is not an allowed currency. Policy allows ${policy.allowed_currencies.join(', ')}.`
    );
  }

  // --- Refunds ------------------------------------------------------------
  if (tool === 'refund_payment') {
    const rules = policy.refunds;
    const capture = context.capture;

    if (!capture) {
      return result(
        DENY,
        'unknown_payment',
        'That payment could not be found in PayPal, so it cannot be refunded.'
      );
    }

    // Note: amount is taken from the REAL capture, never from the model.
    const alreadyRefunded = money(capture.refunded ?? 0);
    const paid = money(capture.amount);
    const refundable = money(paid - alreadyRefunded);
    const requested =
      args.amount === undefined || args.amount === null ? refundable : money(args.amount);
    const ageDays = daysBetween(capture.created_at);

    if (requested <= 0) {
      return result(DENY, 'invalid_amount', 'A refund must be greater than zero.');
    }

    if (requested > refundable) {
      return result(
        DENY,
        'over_refund',
        `That payment only has ${refundable.toFixed(2)} ${currency} left to refund` +
          (alreadyRefunded > 0
            ? ` (${alreadyRefunded.toFixed(2)} was already refunded).`
            : '.')
      );
    }

    if (ageDays > rules.hard_deny_after_days) {
      return result(
        DENY,
        'refund_window_closed',
        `That payment is ${ageDays} days old. Policy blocks all refunds after ${rules.hard_deny_after_days} days, with no override.`
      );
    }

    const percent = paid > 0 ? (requested / paid) * 100 : 100;

    if (requested > rules.auto_approve_max_amount) {
      return result(
        NEEDS_APPROVAL,
        'refund_amount_limit',
        `${requested.toFixed(2)} ${currency} is above the ${rules.auto_approve_max_amount} ${currency} automatic limit, so a human needs to approve it.`
      );
    }

    if (percent > rules.auto_approve_max_percent_of_payment) {
      return result(
        NEEDS_APPROVAL,
        'refund_percent_limit',
        `That is ${percent.toFixed(0)}% of what the customer paid, above the ${rules.auto_approve_max_percent_of_payment}% automatic limit, so a human needs to approve it.`
      );
    }

    if (ageDays > rules.auto_approve_within_days_of_payment) {
      return result(
        NEEDS_APPROVAL,
        'refund_age_limit',
        `That payment is ${ageDays} days old, past the ${rules.auto_approve_within_days_of_payment}-day automatic window, so a human needs to approve it.`
      );
    }

    const spentToday = autoRefundedToday();
    if (spentToday + requested > rules.daily_auto_approve_total) {
      return result(
        NEEDS_APPROVAL,
        'daily_refund_cap',
        `Teller has already auto-approved ${spentToday.toFixed(2)} ${currency} of refunds today. This one would cross the ${rules.daily_auto_approve_total} ${currency} daily cap, so a human needs to approve it.`
      );
    }

    return result(
      ALLOW,
      'within_refund_policy',
      `${requested.toFixed(2)} ${currency} is ${percent.toFixed(0)}% of a ${ageDays}-day-old payment. Inside every automatic limit.`
    );
  }

  // --- Invoices -----------------------------------------------------------
  if (tool === 'create_invoice' || tool === 'send_invoice') {
    const rules = policy.invoices;
    const amount = money(context.invoiceAmount ?? args.amount ?? 0);

    if (args.due_days !== undefined && Number(args.due_days) > rules.max_due_days) {
      return result(
        NEEDS_APPROVAL,
        'invoice_terms',
        `${args.due_days}-day payment terms are longer than the ${rules.max_due_days}-day maximum, so a human needs to approve it.`
      );
    }

    if (amount > rules.auto_send_max_amount) {
      return result(
        NEEDS_APPROVAL,
        'invoice_amount_limit',
        `${amount.toFixed(2)} ${currency} is above the ${rules.auto_send_max_amount} ${currency} automatic invoicing limit, so a human needs to approve it.`
      );
    }

    return result(
      ALLOW,
      'within_invoice_policy',
      `${amount.toFixed(2)} ${currency} is inside the automatic invoicing limit.`
    );
  }

  // --- Money leaving the account -----------------------------------------
  if (tool === 'send_payment') {
    const limit = money(policy.outgoing_payments.auto_approve_max_amount);
    const amount = money(args.amount);

    if (amount > limit) {
      return result(
        NEEDS_APPROVAL,
        'outgoing_payment',
        limit === 0
          ? 'Teller never sends money out of the account on its own. This needs a human.'
          : `${amount.toFixed(2)} ${currency} is above the ${limit} ${currency} automatic limit for outgoing payments.`
      );
    }
    return result(ALLOW, 'within_outgoing_policy', 'Inside the outgoing payment limit.');
  }

  // Unknown money-moving tool: refuse rather than guess.
  return result(
    NEEDS_APPROVAL,
    'unclassified_action',
    'This action moves money and has no policy rule, so it needs a human by default.'
  );
}

/** The policy rendered for the model's system prompt and for the UI. */
export function policySummary() {
  const policy = loadPolicy();
  return {
    business_name: policy.business_name,
    currency: policy.currency,
    rules: policy.plain_english,
    raw: policy,
    auto_refunded_today: autoRefundedToday(),
  };
}
