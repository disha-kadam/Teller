/**
 * Tiny JSON-file persistence.
 *
 * Holds everything that is Teller's own state rather than PayPal's:
 * the approval queue, the audit trail, drafted messages, and (in mock mode)
 * the stand-in PayPal objects.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');

const EMPTY = {
  approvals: [],
  outbox: [],
  // Mock-mode PayPal objects live here so mock state survives a restart.
  mock: {
    invoices: [],
    captures: [],
    refunds: [],
    orders: [],
    seeded: false,
  },
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function read() {
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return { ...structuredClone(EMPTY), ...parsed };
  } catch {
    return structuredClone(EMPTY);
  }
}

let state = read();

function persist() {
  ensureDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
}

export const store = {
  get data() {
    return state;
  },
  save: persist,
  reset() {
    state = structuredClone(EMPTY);
    persist();
    if (fs.existsSync(AUDIT_FILE)) fs.rmSync(AUDIT_FILE);
  },
};

/**
 * Append-only audit trail.
 *
 * Every tool call the agent makes lands here -- what was asked, what the
 * policy engine decided and why, the exact arguments sent to PayPal, and what
 * PayPal sent back. This is the record you hand an accountant when they ask
 * why a refund went out.
 */
export function audit(entry) {
  ensureDir();
  const record = {
    id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...entry,
  };
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n');
  return record;
}

export function readAudit(limit = 100) {
  ensureDir();
  if (!fs.existsSync(AUDIT_FILE)) return [];
  return fs
    .readFileSync(AUDIT_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(-limit)
    .reverse();
}
