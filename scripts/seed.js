/**
 * Seeds the mock PayPal account with a small, realistic business.
 *
 * The fixtures are chosen so that every branch of the policy engine can be
 * demonstrated in a two-minute conversation:
 *
 *   Riya Menon   $180, 3 days old    -> a 20% refund sails through
 *   BigCo        $4,200, 10 days old -> too big, goes to the approval queue
 *   Juniper      $400, 12 days old   -> a 60% refund trips the percentage rule
 *   Old Order    $120, 210 days old  -> past the hard window, refused outright
 *
 * Only used in mock mode. With real sandbox credentials, your real sandbox
 * account is the fixture.
 */
import { store } from '../src/store.js';
import { config } from '../src/config.js';

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
const dateIn = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

export async function seed() {
  if (!config.paypal.mock) return { skipped: 'live mode' };

  store.data.mock.invoices = [
    {
      id: 'INV2-ACME-2401',
      status: 'SENT',
      number: '#1001',
      currency: 'USD',
      amount: 2400,
      recipient_email: 'ap@acmecorp.example',
      recipient_name: 'Acme Corp',
      invoice_date: dateIn(-9),
      due_date: dateIn(5),
      note: 'October brand identity work.',
      items: [{ name: 'Brand identity — October', quantity: 1, unit_amount: 2400 }],
      view_url: 'https://sandbox.paypal.com/invoice/p/#INV2-ACME-2401',
    },
    {
      id: 'INV2-ORBI-2402',
      status: 'SENT',
      number: '#1002',
      currency: 'USD',
      amount: 850,
      recipient_email: 'finance@orbitallabs.example',
      recipient_name: 'Orbital Labs',
      invoice_date: dateIn(-40),
      due_date: dateIn(-12),
      note: 'Landing page build.',
      items: [{ name: 'Landing page build', quantity: 1, unit_amount: 850 }],
      view_url: 'https://sandbox.paypal.com/invoice/p/#INV2-ORBI-2402',
    },
    {
      id: 'INV2-JUNI-2403',
      status: 'SENT',
      number: '#1003',
      currency: 'USD',
      amount: 540,
      recipient_email: 'accounts@juniperhealth.example',
      recipient_name: 'Juniper Health',
      invoice_date: dateIn(-30),
      due_date: dateIn(-3),
      note: 'Icon set and illustration.',
      items: [{ name: 'Icon set', quantity: 1, unit_amount: 540 }],
      view_url: 'https://sandbox.paypal.com/invoice/p/#INV2-JUNI-2403',
    },
    {
      id: 'INV2-MINT-2404',
      status: 'PAID',
      number: '#1004',
      currency: 'USD',
      amount: 3100,
      recipient_email: 'hello@mintandco.example',
      recipient_name: 'Mint & Co',
      invoice_date: dateIn(-22),
      due_date: dateIn(-8),
      note: 'Website refresh, phase one.',
      items: [{ name: 'Website refresh — phase 1', quantity: 1, unit_amount: 3100 }],
      view_url: 'https://sandbox.paypal.com/invoice/p/#INV2-MINT-2404',
    },
  ];

  store.data.mock.captures = [
    {
      capture_id: 'CAP-RIYA-0001',
      order_id: 'ORD-RIYA-0001',
      status: 'COMPLETED',
      amount: 180,
      refunded: 0,
      currency: 'USD',
      customer_email: 'riya.menon@example.com',
      description: 'Brand kit — rush delivery',
      created_at: daysAgo(3),
    },
    {
      capture_id: 'CAP-BIGCO-0002',
      order_id: 'ORD-BIGCO-0002',
      status: 'COMPLETED',
      amount: 4200,
      refunded: 0,
      currency: 'USD',
      customer_email: 'procurement@bigco.example',
      description: 'Annual design retainer — Q4',
      created_at: daysAgo(10),
    },
    {
      capture_id: 'CAP-JUNI-0003',
      order_id: 'ORD-JUNI-0003',
      status: 'COMPLETED',
      amount: 400,
      refunded: 0,
      currency: 'USD',
      customer_email: 'accounts@juniperhealth.example',
      description: 'Illustration add-on',
      created_at: daysAgo(12),
    },
    {
      capture_id: 'CAP-OLD-0004',
      order_id: 'ORD-OLD-0004',
      status: 'COMPLETED',
      amount: 120,
      refunded: 0,
      currency: 'USD',
      customer_email: 'sam.okafor@example.com',
      description: 'Logo touch-up (last year)',
      created_at: daysAgo(210),
    },
  ];

  store.data.mock.orders = [];
  store.data.mock.refunds = [];
  store.data.mock.seeded = true;
  store.save();

  return { ok: true, invoices: 4, captures: 4 };
}

// Allow `npm run seed`.
if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then((r) => console.log('Seeded:', r));
}
