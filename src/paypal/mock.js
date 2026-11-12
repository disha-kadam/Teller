/**
 * In-memory stand-in for the PayPal APIs.
 *
 * Exposes exactly the same methods as ./live.js. It exists for one reason:
 * a judge should be able to clone this repo and see the whole thing work in
 * 60 seconds without creating a PayPal account first. Swap in real sandbox
 * credentials and the identical code path hits real PayPal instead.
 *
 * It is deliberately a *simulation*, not a fake -- it mirrors PayPal's real
 * object shapes, status transitions and error cases (you cannot refund more
 * than was captured, you cannot send an already-sent invoice, and so on).
 */
import { store } from '../store.js';

const money = (n) => Number(Number(n).toFixed(2));
const today = () => new Date().toISOString().slice(0, 10);
const daysFromNow = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const rid = (prefix) =>
  `${prefix}${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

function db() {
  return store.data.mock;
}

function findInvoice(id) {
  const invoice = db().invoices.find((i) => i.id === id);
  if (!invoice) {
    const err = new Error(`PayPal GET /v2/invoicing/invoices/${id} -> 404: INVOICE_NOT_FOUND`);
    err.status = 404;
    throw err;
  }
  return invoice;
}

function findCapture(id) {
  const capture = db().captures.find((c) => c.capture_id === id);
  if (!capture) {
    const err = new Error(
      `PayPal POST /v2/payments/captures/${id}/refund -> 404: RESOURCE_NOT_FOUND`
    );
    err.status = 404;
    throw err;
  }
  return capture;
}

export const mockClient = {
  mode: 'mock',
  environment: 'MOCK',

  async ping() {
    return { ok: true, environment: 'MOCK' };
  },

  // --- Invoicing ----------------------------------------------------------

  async createInvoice({
    recipient_email,
    recipient_name = '',
    items = [],
    currency = 'USD',
    due_days = 14,
    note = '',
  }) {
    if (!recipient_email || !recipient_email.includes('@')) {
      const err = new Error(
        'PayPal POST /v2/invoicing/invoices -> 400: INVALID_EMAIL_ADDRESS'
      );
      err.status = 400;
      throw err;
    }

    const amount = money(
      items.reduce((sum, i) => sum + Number(i.unit_amount) * Number(i.quantity ?? 1), 0)
    );

    const invoice = {
      id: rid('INV2-'),
      status: 'DRAFT',
      number: `#${String(db().invoices.length + 1001)}`,
      currency,
      amount,
      recipient_email,
      recipient_name: recipient_name || recipient_email,
      invoice_date: today(),
      due_date: daysFromNow(due_days),
      note,
      items,
      view_url: null,
    };

    db().invoices.push(invoice);
    store.save();
    return invoice;
  },

  async sendInvoice({ invoice_id }) {
    const invoice = findInvoice(invoice_id);
    if (invoice.status !== 'DRAFT') {
      const err = new Error(
        `PayPal POST /v2/invoicing/invoices/${invoice_id}/send -> 422: ` +
          `INVOICE_NOT_IN_DRAFT_STATE (current status ${invoice.status})`
      );
      err.status = 422;
      throw err;
    }
    invoice.status = 'SENT';
    invoice.view_url = `https://sandbox.paypal.com/invoice/p/#${invoice.id}`;
    store.save();
    return invoice;
  },

  async listInvoices() {
    // Overdue is derived, the way a real reconciliation pass would derive it.
    const now = today();
    return db().invoices.map((invoice) => ({
      ...invoice,
      status:
        invoice.status === 'SENT' && invoice.due_date < now ? 'OVERDUE' : invoice.status,
    }));
  },

  async getInvoice({ invoice_id }) {
    return findInvoice(invoice_id);
  },

  async remindInvoice({ invoice_id }) {
    const invoice = findInvoice(invoice_id);
    invoice.reminders = (invoice.reminders ?? 0) + 1;
    invoice.last_reminded_at = new Date().toISOString();
    store.save();
    return { invoice_id, reminded: true, reminders: invoice.reminders };
  },

  // --- Orders -------------------------------------------------------------

  async createOrder({ amount, currency = 'USD', description = '' }) {
    const order = {
      id: rid('ORD-'),
      status: 'CREATED',
      amount: money(amount),
      currency,
      description,
      approve_url: null,
    };
    order.approve_url = `https://sandbox.paypal.com/checkoutnow?token=${order.id}`;
    db().orders.push(order);
    store.save();
    return order;
  },

  async captureOrder({ order_id }) {
    const order = db().orders.find((o) => o.id === order_id);
    if (!order) {
      const err = new Error(
        `PayPal POST /v2/checkout/orders/${order_id}/capture -> 404: RESOURCE_NOT_FOUND`
      );
      err.status = 404;
      throw err;
    }
    order.status = 'COMPLETED';

    const capture = {
      capture_id: rid('CAP-'),
      order_id,
      status: 'COMPLETED',
      amount: order.amount,
      refunded: 0,
      currency: order.currency,
      customer_email: order.customer_email ?? 'buyer@example.com',
      description: order.description,
      created_at: new Date().toISOString(),
    };
    db().captures.push(capture);
    store.save();
    return { ...capture };
  },

  // --- Refunds ------------------------------------------------------------

  async refundCapture({ capture_id, amount, currency = 'USD', note = '' }) {
    const capture = findCapture(capture_id);
    const refundable = money(capture.amount - (capture.refunded ?? 0));
    const requested = amount === undefined || amount === null ? refundable : money(amount);

    if (requested > refundable) {
      const err = new Error(
        `PayPal POST /v2/payments/captures/${capture_id}/refund -> 422: ` +
          `REFUND_AMOUNT_EXCEEDED (refundable ${refundable.toFixed(2)} ${capture.currency})`
      );
      err.status = 422;
      throw err;
    }

    capture.refunded = money((capture.refunded ?? 0) + requested);
    const refund = {
      refund_id: rid('REF-'),
      capture_id,
      status: 'COMPLETED',
      amount: requested,
      currency: capture.currency || currency,
      note,
      created_at: new Date().toISOString(),
    };
    db().refunds.push(refund);
    store.save();
    return { ...refund };
  },

  async getCapture({ capture_id }) {
    const capture = findCapture(capture_id);
    return { ...capture };
  },

  // --- Mock-only helpers --------------------------------------------------

  async listCaptures() {
    return db().captures.map((c) => ({ ...c }));
  },
};
