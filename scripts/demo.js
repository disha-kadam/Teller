/**
 * `npm run demo`
 *
 * Drives the tool layer directly, with no model involved, so you can see the
 * guardrails behave on their own. This is the proof that the policy engine is
 * real: the same four refund requests get four different answers, and the
 * answers come from code, not from a prompt.
 *
 * Run it before or after playing with the UI. `npm run seed` resets the data.
 */
import { seed } from './seed.js';
import { store } from '../src/store.js';
import { execute, listApprovals, resolveApproval } from '../src/tools.js';
import { describeRuntime } from '../src/config.js';

const line = (char = '-') => console.log('  ' + char.repeat(66));
const money = (n) => `$${Number(n).toFixed(2)}`;

function show(title, outcome) {
  const verdict = outcome.refused
    ? 'REFUSED'
    : outcome.queued_for_approval
      ? 'NEEDS APPROVAL'
      : outcome.error
        ? 'ERROR'
        : 'EXECUTED';

  console.log(`\n  ${title}`);
  console.log(`    verdict : ${verdict}`);
  console.log(`    rule    : ${outcome.policy_rule ?? '—'}`);
  if (outcome.reason) console.log(`    because : ${outcome.reason}`);
  if (outcome.result?.refund_id) {
    console.log(
      `    paypal  : refund ${outcome.result.refund_id} for ${money(outcome.result.amount)}`
    );
  }
  if (outcome.result?.id) console.log(`    paypal  : created ${outcome.result.id}`);
}

async function main() {
  store.reset();
  await seed();

  const runtime = describeRuntime();
  console.log('');
  line('=');
  console.log('  Teller — guardrail demonstration (no model involved)');
  console.log(`  PayPal: ${runtime.paypalMode}`);
  line('=');

  console.log('\n  Four refund requests. Same code path. Four different answers.');

  show(
    '1. Riya, $36 back on a $180 order from 3 days ago (20%)',
    await execute('refund_payment', {
      capture_id: 'CAP-RIYA-0001',
      amount: 36,
      reason: 'Delivered two days late; goodwill gesture.',
    })
  );

  show(
    '2. BigCo, full $4,200 refund on a 10-day-old retainer',
    await execute('refund_payment', {
      capture_id: 'CAP-BIGCO-0002',
      reason: 'Customer cancelled the retainer.',
    })
  );

  show(
    '3. Juniper, $240 back on a $400 order (60% — under the dollar cap, over the share cap)',
    await execute('refund_payment', {
      capture_id: 'CAP-JUNI-0003',
      amount: 240,
      reason: 'Partial dissatisfaction with the add-on.',
    })
  );

  show(
    '4. Sam, $120 refund on an order from 210 days ago',
    await execute('refund_payment', {
      capture_id: 'CAP-OLD-0004',
      reason: 'Customer asked nicely.',
    })
  );

  console.log('\n  And the one nobody thinks to test:');

  show(
    '5. Refund $500 on a payment where only $180 was ever taken',
    await execute('refund_payment', {
      capture_id: 'CAP-RIYA-0001',
      amount: 500,
      reason: 'Model hallucinated the order value.',
    })
  );

  show(
    '6. Send $2,000 out of the account to a contractor',
    await execute('send_payment', {
      recipient_email: 'contractor@example.com',
      amount: 2000,
      reason: 'Invoice from subcontractor.',
    })
  );

  show(
    '7. Invoice Acme $1,200, net 15',
    await execute('create_invoice', {
      recipient_email: 'ap@acmecorp.example',
      recipient_name: 'Acme Corp',
      items: [{ name: 'October design work', quantity: 1, unit_amount: 1200 }],
      currency: 'USD',
      due_days: 15,
    })
  );

  line();
  const pending = listApprovals().filter((a) => a.status === 'pending');
  console.log(`\n  Approval queue: ${pending.length} waiting for a human.`);
  for (const approval of pending) {
    console.log(`    • ${approval.tool} — ${approval.policy.reason}`);
  }

  if (pending.length) {
    const first = pending[pending.length - 1];
    console.log(`\n  Owner approves "${first.tool}"...`);
    const resolved = await resolveApproval(first.id, 'approve');
    console.log(
      `    -> ${resolved.ok ? 'executed after approval' : 'still blocked: ' + resolved.outcome?.message}`
    );
  }

  console.log('\n  Note what did NOT reach the queue: scenarios 4 and 5 were refused');
  console.log('  outright and there is no button anywhere that undoes that. A human');
  console.log('  approval overrides "ask a person first", never "this is forbidden".');

  line('=');
  console.log('  Every line above is in data/audit.jsonl, with full arguments.');
  line('=');
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
