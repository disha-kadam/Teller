import express from 'express';
import path from 'node:path';
import { config, describeRuntime, ROOT } from './config.js';
import { run, resetSession } from './agent.js';
import { listApprovals, resolveApproval } from './tools.js';
import { policySummary } from './policy.js';
import { paypal } from './paypal/index.js';
import { store, readAudit } from './store.js';
import { seed } from '../scripts/seed.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

/** Everything the dashboard needs, in one call. */
app.get('/api/state', async (_req, res) => {
  try {
    const [invoices, captures] = await Promise.all([
      paypal.listInvoices().catch(() => []),
      paypal.listCaptures().catch(() => []),
    ]);

    const outstanding = invoices
      .filter((i) => i.status === 'SENT' || i.status === 'OVERDUE')
      .reduce((sum, i) => sum + Number(i.amount), 0);

    res.json({
      runtime: describeRuntime(),
      policy: policySummary(),
      invoices,
      captures,
      outstanding: Number(outstanding.toFixed(2)),
      approvals: listApprovals(),
      outbox: store.data.outbox,
      audit: readAudit(60),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { sessionId = 'default', message = '' } = req.body ?? {};
  if (!message.trim()) return res.status(400).json({ error: 'Empty message.' });

  try {
    res.json(await run(sessionId, message));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/approvals/:id', async (req, res) => {
  const { decision = 'approve' } = req.body ?? {};
  try {
    res.json(await resolveApproval(req.params.id, decision));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Wipe local state and reseed, so a demo can be run twice. */
app.post('/api/reset', async (_req, res) => {
  store.reset();
  resetSession('default');
  await seed();
  res.json({ ok: true });
});

const server = app.listen(config.port, async () => {
  const runtime = describeRuntime();

  if (config.paypal.mock && !store.data.mock.seeded) await seed();

  console.log('');
  console.log('  Teller — the AI money desk, running on PayPal');
  console.log('  ' + '-'.repeat(52));
  console.log(`  Open      http://localhost:${config.port}`);
  console.log(`  PayPal    ${runtime.paypalMode}`);
  console.log(`  Model     ${runtime.llmProvider}`);
  if (config.paypal.mock) {
    console.log('');
    console.log('  Running against a local mock of PayPal. Add sandbox credentials');
    console.log('  to .env and restart to hit the real PayPal sandbox instead.');
  }
  if (!runtime.llmLive) {
    console.log('');
    console.log('  No model API key set — using the rule-based fallback planner.');
    console.log('  Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env for the real agent.');
  }
  console.log('');
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
