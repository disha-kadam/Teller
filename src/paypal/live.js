/**
 * Live PayPal REST client (sandbox or production).
 *
 * Covers the surface Teller needs:
 *   - OAuth2 client-credentials token (cached until shortly before expiry)
 *   - Invoicing v2      : create, send, list, get, remind
 *   - Orders v2         : create, capture
 *   - Payments v2       : refund a capture
 *
 * Every method returns plain objects in the same shape as the mock client in
 * ./mock.js, so the rest of the app never knows which one it is talking to.
 */
import { config } from '../config.js';

const BASE = config.paypal.baseUrl;

let cachedToken = null; // { value, expiresAt }

async function accessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const basic = Buffer.from(
    `${config.paypal.clientId}:${config.paypal.clientSecret}`
  ).toString('base64');

  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `PayPal auth failed (${res.status}). Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET. ${
        body.error_description || ''
      }`
    );
  }

  cachedToken = {
    value: body.access_token,
    // Refresh a minute early rather than discovering expiry mid-refund.
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}

async function call(method, path, { body, headers = {} } = {}) {
  const token = await accessToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!res.ok) {
    const detail =
      parsed?.details?.map((d) => `${d.issue}: ${d.description}`).join('; ') ||
      parsed?.message ||
      parsed?.error_description ||
      text ||
      'unknown error';
    const err = new Error(`PayPal ${method} ${path} -> ${res.status}: ${detail}`);
    err.status = res.status;
    err.paypal = parsed;
    throw err;
  }

  return parsed;
}

/** Pull the invoice id out of the Location/href PayPal returns on create. */
function idFromHref(href = '') {
  const parts = href.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function normalizeInvoice(inv) {
  const amount = inv?.amount?.value ?? inv?.due_amount?.value ?? '0.00';
  const currency = inv?.amount?.currency_code ?? inv?.due_amount?.currency_code ?? 'USD';
  const recipient = inv?.primary_recipients?.[0]?.billing_info ?? {};

  return {
    id: inv.id,
    status: inv.status,
    number: inv?.detail?.invoice_number ?? '',
    currency,
    amount: Number(amount),
    recipient_email: recipient.email_address ?? '',
    recipient_name:
      [recipient?.name?.given_name, recipient?.name?.surname].filter(Boolean).join(' ') ||
      recipient.email_address ||
      'Unknown',
    due_date: inv?.detail?.payment_term?.due_date ?? inv?.detail?.invoice_date ?? null,
    invoice_date: inv?.detail?.invoice_date ?? null,
    note: inv?.detail?.note ?? '',
    view_url:
      inv?.detail?.metadata?.recipient_view_url ??
      inv?.links?.find((l) => l.rel === 'self')?.href ??
      null,
    raw: inv,
  };
}

export const liveClient = {
  mode: 'live',
  environment: config.paypal.env,

  async ping() {
    await accessToken();
    return { ok: true, environment: config.paypal.env };
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
    const [given_name, ...rest] = String(recipient_name || '').trim().split(/\s+/);
    const invoiceDate = new Date().toISOString().slice(0, 10);
    const dueDate = new Date(Date.now() + due_days * 86400000)
      .toISOString()
      .slice(0, 10);

    const payload = {
      detail: {
        currency_code: currency,
        invoice_date: invoiceDate,
        note,
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: dueDate },
      },
      primary_recipients: [
        {
          billing_info: {
            email_address: recipient_email,
            ...(given_name
              ? { name: { given_name, surname: rest.join(' ') || given_name } }
              : {}),
          },
        },
      ],
      items: items.map((item) => ({
        name: item.name,
        quantity: String(item.quantity ?? 1),
        unit_amount: {
          currency_code: currency,
          value: Number(item.unit_amount).toFixed(2),
        },
      })),
    };

    const created = await call('POST', '/v2/invoicing/invoices', { body: payload });
    const id = created.id || idFromHref(created.href);
    const full = await call('GET', `/v2/invoicing/invoices/${id}`);
    return normalizeInvoice(full);
  },

  async sendInvoice({ invoice_id, subject, note }) {
    await call('POST', `/v2/invoicing/invoices/${invoice_id}/send`, {
      body: {
        send_to_recipient: true,
        ...(subject ? { subject } : {}),
        ...(note ? { note } : {}),
      },
    });
    const full = await call('GET', `/v2/invoicing/invoices/${invoice_id}`);
    return normalizeInvoice(full);
  },

  async listInvoices({ page_size = 50 } = {}) {
    const res = await call(
      'GET',
      `/v2/invoicing/invoices?page_size=${page_size}&total_required=true`
    );
    return (res.items || []).map(normalizeInvoice);
  },

  async getInvoice({ invoice_id }) {
    return normalizeInvoice(await call('GET', `/v2/invoicing/invoices/${invoice_id}`));
  },

  async remindInvoice({ invoice_id, subject, note }) {
    await call('POST', `/v2/invoicing/invoices/${invoice_id}/remind`, {
      body: {
        send_to_recipient: true,
        subject: subject || 'Payment reminder',
        note: note || 'A friendly reminder that this invoice is now due.',
      },
    });
    return { invoice_id, reminded: true };
  },

  // --- Orders -------------------------------------------------------------

  async createOrder({ amount, currency = 'USD', description = '' }) {
    const order = await call('POST', '/v2/checkout/orders', {
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            amount: { currency_code: currency, value: Number(amount).toFixed(2) },
            description,
          },
        ],
      },
    });
    return {
      id: order.id,
      status: order.status,
      approve_url: order.links?.find((l) => l.rel === 'approve')?.href ?? null,
      amount: Number(amount),
      currency,
      raw: order,
    };
  },

  async captureOrder({ order_id }) {
    const result = await call('POST', `/v2/checkout/orders/${order_id}/capture`, {
      body: {},
    });
    const capture = result?.purchase_units?.[0]?.payments?.captures?.[0] ?? {};
    return {
      order_id,
      capture_id: capture.id,
      status: capture.status ?? result.status,
      amount: Number(capture?.amount?.value ?? 0),
      currency: capture?.amount?.currency_code ?? 'USD',
      raw: result,
    };
  },

  // --- Refunds ------------------------------------------------------------

  async refundCapture({ capture_id, amount, currency = 'USD', note = '' }) {
    const body = {};
    if (amount !== undefined && amount !== null) {
      body.amount = { value: Number(amount).toFixed(2), currency_code: currency };
    }
    if (note) body.note_to_payer = note.slice(0, 255);

    const refund = await call('POST', `/v2/payments/captures/${capture_id}/refund`, {
      body,
    });
    return {
      refund_id: refund.id,
      capture_id,
      status: refund.status,
      amount: Number(refund?.amount?.value ?? amount ?? 0),
      currency: refund?.amount?.currency_code ?? currency,
      raw: refund,
    };
  },

  async getCapture({ capture_id }) {
    const capture = await call('GET', `/v2/payments/captures/${capture_id}`);
    return {
      capture_id,
      status: capture.status,
      amount: Number(capture?.amount?.value ?? 0),
      currency: capture?.amount?.currency_code ?? 'USD',
      created_at: capture.create_time,
      raw: capture,
    };
  },
};
