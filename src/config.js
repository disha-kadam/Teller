/**
 * Loads configuration from .env (if present) and process.env.
 *
 * Deliberately dependency-free: a 20-line .env parser beats adding dotenv
 * when the whole point is that `npm install && npm start` just works.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment variables always win over the file.
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const env = (key, fallback = '') => (process.env[key] ?? '').trim() || fallback;

const paypalClientId = env('PAYPAL_CLIENT_ID');
const paypalClientSecret = env('PAYPAL_CLIENT_SECRET');
const forceMock = env('PAYPAL_MOCK') === '1';
const hasPayPalCreds = Boolean(paypalClientId && paypalClientSecret);

const paypalEnv = env('PAYPAL_ENV', 'SANDBOX').toUpperCase();
const liveConfirmed = env('PAYPAL_I_UNDERSTAND_THIS_IS_REAL_MONEY') === 'yes';

// Guardrail zero: never let a hackathon demo point at production by accident.
if (paypalEnv === 'LIVE' && !liveConfirmed) {
  throw new Error(
    'PAYPAL_ENV is LIVE but PAYPAL_I_UNDERSTAND_THIS_IS_REAL_MONEY is not "yes". ' +
      'Refusing to start. Set PAYPAL_ENV=SANDBOX.'
  );
}

export const config = {
  root: ROOT,
  port: Number(env('PORT', '3000')),

  paypal: {
    clientId: paypalClientId,
    clientSecret: paypalClientSecret,
    env: paypalEnv,
    baseUrl:
      paypalEnv === 'LIVE'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com',
    // Mock mode is the automatic fallback, not a hidden flag: if you have no
    // credentials the app still runs, which is what makes it judgeable.
    mock: forceMock || !hasPayPalCreds,
    mockReason: forceMock
      ? 'PAYPAL_MOCK=1 was set explicitly.'
      : hasPayPalCreds
        ? ''
        : 'No PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET found.',
  },

  llm: {
    anthropicKey: env('ANTHROPIC_API_KEY'),
    anthropicModel: env('ANTHROPIC_MODEL', 'claude-sonnet-4-5'),
    openaiKey: env('OPENAI_API_KEY'),
    openaiModel: env('OPENAI_MODEL', 'gpt-4o-mini'),
    openaiBaseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  },
};

export function describeRuntime() {
  const llmProvider = config.llm.anthropicKey
    ? `Anthropic (${config.llm.anthropicModel})`
    : config.llm.openaiKey
      ? `OpenAI-compatible (${config.llm.openaiModel})`
      : 'rule-based fallback planner (no API key set)';

  return {
    paypalMode: config.paypal.mock
      ? `mock (${config.paypal.mockReason})`
      : `${config.paypal.env} via ${config.paypal.baseUrl}`,
    paypalMock: config.paypal.mock,
    llmProvider,
    llmLive: Boolean(config.llm.anthropicKey || config.llm.openaiKey),
  };
}
