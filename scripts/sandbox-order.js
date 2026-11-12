/**
 * `node scripts/sandbox-order.js 180 "Brand kit — rush delivery"`
 *
 * Only useful once you have real PayPal sandbox credentials in .env.
 *
 * Refunds need a real captured payment, and a captured payment needs a buyer
 * to approve a checkout. This script creates a sandbox order and prints the
 * approval link. Open it, pay with your sandbox personal account, come back,
 * press Enter, and the order is captured and indexed so the agent can find
 * and refund it like any other payment.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { paypal } from '../src/paypal/index.js';
import { config } from '../src/config.js';

const amount = Number(process.argv[2] ?? 180);
const description = process.argv[3] ?? 'Sandbox test order';
const email = process.argv[4] ?? 'buyer@example.com';

if (config.paypal.mock) {
  console.log('Running in mock mode — `npm run seed` already gives you refundable');
  console.log('payments. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env to use this.');
  process.exit(0);
}

const order = await paypal.createOrder({ amount, currency: 'USD', description });

console.log('\n  Order created:', order.id);
console.log('  Approve it as a sandbox buyer here:\n');
console.log('   ', order.approve_url, '\n');
console.log('  Sign in with a sandbox PERSONAL account from');
console.log('  https://developer.paypal.com/dashboard/accounts and complete the payment.');

const rl = readline.createInterface({ input: stdin, output: stdout });
await rl.question('\n  Press Enter once you have paid… ');
rl.close();

try {
  const capture = await paypal.captureOrder({
    order_id: order.id,
    customer_email: email,
    description,
  });
  console.log('\n  Captured:', capture.capture_id, `(${capture.amount} ${capture.currency})`);
  console.log('  Teller can now find and refund this payment. Try:');
  console.log(`  "refund the ${description} order"\n`);
} catch (error) {
  console.error('\n  Capture failed:', error.message);
  console.error('  Did the approval actually complete in the browser?\n');
  process.exit(1);
}
