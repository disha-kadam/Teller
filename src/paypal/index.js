/**
 * Chooses the PayPal client and adds the one thing neither client gives us:
 * a local index of captures Teller knows about.
 *
 * PayPal has no "list every payment I ever received" endpoint available to a
 * fresh sandbox app, so Teller records each capture it performs. That index is
 * what the agent searches when a customer writes in about an order.
 */
import { config } from '../config.js';
import { store } from '../store.js';
import { liveClient } from './live.js';
import { mockClient } from './mock.js';

const client = config.paypal.mock ? mockClient : liveClient;

function liveIndex() {
  if (!store.data.liveCaptures) store.data.liveCaptures = [];
  return store.data.liveCaptures;
}

export const paypal = {
  ...client,

  async captureOrder(args) {
    const result = await client.captureOrder(args);
    if (client.mode === 'live' && result.capture_id) {
      liveIndex().push({
        capture_id: result.capture_id,
        order_id: result.order_id,
        amount: result.amount,
        currency: result.currency,
        refunded: 0,
        customer_email: args.customer_email ?? '',
        description: args.description ?? '',
        created_at: new Date().toISOString(),
      });
      store.save();
    }
    return result;
  },

  /** Every capture Teller can see, in either mode. */
  async listCaptures() {
    if (client.mode === 'mock') return mockClient.listCaptures();
    return liveIndex().map((c) => ({ ...c }));
  },

  /** Record a capture that happened outside Teller (e.g. a paid invoice). */
  async indexCapture(capture) {
    if (client.mode === 'mock') {
      store.data.mock.captures.push(capture);
    } else {
      liveIndex().push(capture);
    }
    store.save();
    return capture;
  },
};

export const paypalMode = client.mode;
