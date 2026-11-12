/**
 * The tools the agent is allowed to use, and the single chokepoint every one
 * of them passes through.
 *
 * `execute()` is the only way a tool call reaches PayPal. It always:
 *   1. gathers ground truth from PayPal (never trusts amounts the model made up)
 *   2. runs the policy engine
 *   3. executes, queues for approval, or refuses
 *   4. writes the whole story to the audit log
 *
 * There is no second path. If you want to know everything Teller can do to
 * your money, you read this file.
 */
import { paypal } from './paypal/index.js';
import { evaluate, ALLOW, NEEDS_APPROVAL, DENY, policySummary } from './policy.js';
import { store, audit } from './store.js';

const money = (n) => Number(Number(n ?? 0).toFixed(2));

/* ---------------------------------------------------------------------------
 * Tool schemas, in a neutral shape that both the Anthropic and OpenAI
 * tool-calling formats are generated from (see src/llm.js).
 * ------------------------------------------------------------------------- */

export const TOOLS = [
  {
    name: 'list_invoices',
    description:
      'List all invoices with their status (DRAFT, SENT, PAID, OVERDUE), amount, customer and due date. Use this to answer questions about who owes money.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_invoice',
    description:
      'Create a draft invoice in PayPal. Does not send it. Line items must be itemised; put the total in unit_amount x quantity.',
    parameters: {
      type: 'object',
      properties: {
        recipient_email: { type: 'string', description: 'Customer email address.' },
        recipient_name: { type: 'string', description: 'Customer name.' },
        items: {
          type: 'array',
          description: 'Line items on the invoice.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              quantity: { type: 'number' },
              unit_amount: { type: 'number' },
            },
            required: ['name', 'unit_amount'],
          },
        },
        currency: { type: 'string', description: 'ISO currency code, e.g. USD.' },
        due_days: { type: 'number', description: 'Days until payment is due, e.g. 15 for net 15.' },
        note: { type: 'string', description: 'Note shown to the customer.' },
      },
      required: ['recipient_email', 'items'],
    },
  },
  {
    name: 'send_invoice',
    description: 'Send a draft invoice to the customer by email.',
    parameters: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string' },
        note: { type: 'string', description: 'Optional note to include.' },
      },
      required: ['invoice_id'],
    },
  },
  {
    name: 'remind_invoice',
    description: 'Send a payment reminder for an invoice that has already been sent.',
    parameters: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['invoice_id'],
    },
  },
  {
    name: 'find_payments',
    description:
      'Search payments the business has received. Filter by customer email, by text in the order description, or by amount. Call this before any refund to find the payment being talked about.',
    parameters: {
      type: 'object',
      properties: {
        customer_email: { type: 'string' },
        query: { type: 'string', description: 'Text to match against the order description.' },
        amount: { type: 'number', description: 'Approximate amount paid.' },
      },
      required: [],
    },
  },
  {
    name: 'refund_payment',
    description:
      'Refund a payment, fully or partially. Requires a capture_id from find_payments. Omit amount for a full refund. This moves real money and is checked against the business refund policy.',
    parameters: {
      type: 'object',
      properties: {
        capture_id: { type: 'string', description: 'The capture_id from find_payments.' },
        amount: {
          type: 'number',
          description: 'Amount to refund. Omit for a full refund.',
        },
        currency: { type: 'string' },
        reason: {
          type: 'string',
          description: 'Why this refund is being issued. Required, and recorded in the audit log.',
        },
      },
      required: ['capture_id', 'reason'],
    },
  },
  {
    name: 'create_payment_link',
    description:
      'Create a PayPal checkout link for a one-off amount, for example to charge a customer for something that is not on an invoice. Creating a link does not move money.',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number' },
        currency: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['amount', 'description'],
    },
  },
  {
    name: 'send_payment',
    description:
      'Send money OUT of the business account to someone, for example paying a contractor. Always requires human approval.',
    parameters: {
      type: 'object',
      properties: {
        recipient_email: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['recipient_email', 'amount', 'reason'],
    },
  },
  {
    name: 'draft_message',
    description:
      'Write a message to a customer and put it in the outbox for the owner to review. Use this for apologies, payment chasers and explanations. Does not send anything by itself.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'get_policy',
    description:
      'Read the business money policy: refund limits, invoicing limits and what needs human approval.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

/* ---------------------------------------------------------------------------
 * Ground truth gathering.
 *
 * The policy engine must never be handed numbers the model invented. For a
 * refund that means fetching the actual capture from PayPal first.
 * ------------------------------------------------------------------------- */

async function gatherContext(tool, args) {
  if (tool === 'refund_payment') {
    try {
      const capture = await paypal.getCapture({ capture_id: args.capture_id });
      return { capture };
    } catch {
      return { capture: null };
    }
  }

  if (tool === 'create_invoice') {
    const amount = (args.items ?? []).reduce(
      (sum, item) => sum + Number(item.unit_amount ?? 0) * Number(item.quantity ?? 1),
      0
    );
    return { invoiceAmount: money(amount) };
  }

  if (tool === 'send_invoice') {
    try {
      const invoice = await paypal.getInvoice({ invoice_id: args.invoice_id });
      return { invoiceAmount: money(invoice.amount), invoice };
    } catch {
      return { invoiceAmount: 0 };
    }
  }

  return {};
}

/* ---------------------------------------------------------------------------
 * The actual PayPal calls, once policy has said yes.
 * ------------------------------------------------------------------------- */

async function perform(tool, args, context) {
  switch (tool) {
    case 'list_invoices': {
      const invoices = await paypal.listInvoices();
      const outstanding = invoices
        .filter((i) => i.status === 'SENT' || i.status === 'OVERDUE')
        .reduce((sum, i) => sum + Number(i.amount), 0);
      return {
        count: invoices.length,
        total_outstanding: money(outstanding),
        invoices: invoices.map((i) => ({
          id: i.id,
          number: i.number,
          customer: i.recipient_name,
          email: i.recipient_email,
          amount: i.amount,
          currency: i.currency,
          status: i.status,
          due_date: i.due_date,
        })),
      };
    }

    case 'create_invoice':
      return paypal.createInvoice({
        recipient_email: args.recipient_email,
        recipient_name: args.recipient_name ?? '',
        items: args.items ?? [],
        currency: (args.currency ?? 'USD').toUpperCase(),
        due_days: args.due_days ?? 14,
        note: args.note ?? '',
      });

    case 'send_invoice':
      return paypal.sendInvoice({ invoice_id: args.invoice_id, note: args.note });

    case 'remind_invoice':
      return paypal.remindInvoice({ invoice_id: args.invoice_id, note: args.note });

    case 'find_payments': {
      const captures = await paypal.listCaptures();
      const needle = String(args.query ?? '').toLowerCase();

      const matches = captures.filter((c) => {
        if (args.customer_email && c.customer_email !== args.customer_email) return false;
        if (needle && !String(c.description ?? '').toLowerCase().includes(needle)) return false;
        if (args.amount !== undefined && Math.abs(c.amount - Number(args.amount)) > 0.5) {
          return false;
        }
        return true;
      });

      return {
        count: matches.length,
        payments: matches.map((c) => ({
          capture_id: c.capture_id,
          customer_email: c.customer_email,
          description: c.description,
          amount: c.amount,
          already_refunded: money(c.refunded ?? 0),
          refundable: money(c.amount - (c.refunded ?? 0)),
          currency: c.currency,
          paid_at: c.created_at,
        })),
      };
    }

    case 'refund_payment':
      return paypal.refundCapture({
        capture_id: args.capture_id,
        amount: args.amount,
        currency: context?.capture?.currency ?? args.currency ?? 'USD',
        note: args.reason ?? '',
      });

    case 'create_payment_link':
      return paypal.createOrder({
        amount: args.amount,
        currency: (args.currency ?? 'USD').toUpperCase(),
        description: args.description ?? '',
      });

    case 'send_payment':
      // Intentionally not wired to the Payouts API: an unattended hackathon
      // demo should not be able to push money out even once. The approval
      // queue is where this stops, and that is the honest behaviour to show.
      return {
        status: 'NOT_EXECUTED',
        note: 'Outgoing payments are approval-only in this build and are not sent.',
      };

    case 'draft_message': {
      const draft = {
        id: `msg_${Date.now()}`,
        to: args.to,
        subject: args.subject,
        body: args.body,
        created_at: new Date().toISOString(),
        status: 'awaiting_review',
      };
      store.data.outbox.unshift(draft);
      store.save();
      return draft;
    }

    case 'get_policy':
      return policySummary();

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

/* ---------------------------------------------------------------------------
 * The chokepoint.
 * ------------------------------------------------------------------------- */

/**
 * Run a tool call through policy and, if allowed, through to PayPal.
 *
 * @param {string}  tool
 * @param {object}  args
 * @param {object}  options
 * @param {string}  options.userRequest  what the human originally asked for
 * @param {string}  options.reasoning    the model's stated reason for this call
 * @param {boolean} options.preApproved  set only when replaying an approved action
 * @returns {object} a result safe to hand back to the model
 */
export async function execute(tool, args = {}, options = {}) {
  const { userRequest = '', reasoning = '', preApproved = false } = options;
  const context = await gatherContext(tool, args);
  const verdict = evaluate(tool, args, context);

  // A human approving something never unlocks a hard DENY. Approval overrides
  // "needs a person", not "this is forbidden".
  if (verdict.decision === DENY) {
    audit({
      tool,
      args,
      userRequest,
      reasoning,
      policy: verdict,
      outcome: 'refused',
    });
    return {
      ok: false,
      refused: true,
      reason: verdict.reason,
      policy_rule: verdict.rule,
      message: `Refused by business policy: ${verdict.reason}`,
    };
  }

  if (verdict.decision === NEEDS_APPROVAL && !preApproved) {
    const approval = {
      id: `apr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tool,
      args,
      context_summary: summariseContext(tool, args, context),
      userRequest,
      reasoning,
      policy: verdict,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    store.data.approvals.unshift(approval);
    store.save();

    audit({
      tool,
      args,
      userRequest,
      reasoning,
      policy: verdict,
      outcome: 'queued_for_approval',
      approval_id: approval.id,
    });

    return {
      ok: false,
      queued_for_approval: true,
      approval_id: approval.id,
      reason: verdict.reason,
      policy_rule: verdict.rule,
      message:
        `Not executed. This needs human approval: ${verdict.reason} ` +
        `It is now waiting in the approval queue. Tell the user plainly that you did not do it ` +
        `and that it is waiting for them to approve.`,
    };
  }

  // Allowed (or approved by a human). Execute for real.
  try {
    const response = await perform(tool, args, context);
    audit({
      tool,
      args,
      userRequest,
      reasoning,
      policy: verdict,
      outcome: 'executed',
      approved_by_human: preApproved,
      response: redact(response),
    });
    return { ok: true, result: response, policy_rule: verdict.rule };
  } catch (error) {
    audit({
      tool,
      args,
      userRequest,
      reasoning,
      policy: verdict,
      outcome: 'error',
      error: error.message,
    });
    return {
      ok: false,
      error: true,
      message: `PayPal rejected this: ${error.message}`,
    };
  }
}

/** Keep the raw PayPal payload out of the audit log; keep the useful parts. */
function redact(response) {
  if (!response || typeof response !== 'object') return response;
  const { raw, ...rest } = response;
  return rest;
}

function summariseContext(tool, args, context) {
  if (tool === 'refund_payment' && context.capture) {
    return (
      `Refunding ${args.amount ?? 'the full remaining balance'} of a ` +
      `${context.capture.amount} ${context.capture.currency} payment from ` +
      `${context.capture.customer_email || 'a customer'} ` +
      `(${context.capture.description || 'no description'}).`
    );
  }
  if (tool === 'create_invoice') {
    return `Invoice for ${context.invoiceAmount} ${args.currency ?? 'USD'} to ${args.recipient_email}.`;
  }
  if (tool === 'send_payment') {
    return `Send ${args.amount} ${args.currency ?? 'USD'} out to ${args.recipient_email}.`;
  }
  return '';
}

/* ---------------------------------------------------------------------------
 * Approvals
 * ------------------------------------------------------------------------- */

export function listApprovals() {
  return store.data.approvals;
}

export async function resolveApproval(id, decision, approver = 'owner') {
  const approval = store.data.approvals.find((a) => a.id === id);
  if (!approval) return { ok: false, message: 'No such approval.' };
  if (approval.status !== 'pending') {
    return { ok: false, message: `That was already ${approval.status}.` };
  }

  if (decision === 'reject') {
    approval.status = 'rejected';
    approval.resolved_at = new Date().toISOString();
    store.save();
    audit({
      tool: approval.tool,
      args: approval.args,
      userRequest: approval.userRequest,
      policy: approval.policy,
      outcome: 'rejected_by_human',
      approver,
      approval_id: id,
    });
    return { ok: true, approval };
  }

  // Approved: replay the exact stored call, with DENY rules still in force.
  const outcome = await execute(approval.tool, approval.args, {
    userRequest: approval.userRequest,
    reasoning: `Replayed after human approval by ${approver}.`,
    preApproved: true,
  });

  approval.status = outcome.ok ? 'approved' : 'failed';
  approval.resolved_at = new Date().toISOString();
  approval.outcome = outcome;
  store.save();

  return { ok: outcome.ok, approval, outcome };
}
