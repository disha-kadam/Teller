/**
 * Model access, behind one small interface.
 *
 * Teller keeps conversation history in its own neutral format and converts it
 * per provider, so swapping models is a config change rather than a rewrite.
 *
 *   history entry shapes
 *     { role: 'user',      text }
 *     { role: 'assistant', text, toolCalls: [{ id, name, args }] }
 *     { role: 'tool',      results: [{ id, name, content }] }
 *
 * Providers: Anthropic, anything OpenAI-compatible, and a rule-based planner
 * used only when no API key is configured, so the app still demonstrates the
 * payment and guardrail machinery with nothing set up.
 */
import { config } from './config.js';

export function activeProvider() {
  if (config.llm.anthropicKey) return 'anthropic';
  if (config.llm.openaiKey) return 'openai';
  return 'fallback';
}

/* ------------------------------------------------------------------ Anthropic */

function toAnthropic(history) {
  const messages = [];
  for (const entry of history) {
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: entry.text });
    } else if (entry.role === 'assistant') {
      const content = [];
      if (entry.text) content.push({ type: 'text', text: entry.text });
      for (const call of entry.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      if (content.length) messages.push({ role: 'assistant', content });
    } else if (entry.role === 'tool') {
      messages.push({
        role: 'user',
        content: entry.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: JSON.stringify(r.content),
        })),
      });
    }
  }
  return messages;
}

async function callAnthropic({ system, history, tools }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.llm.anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llm.anthropicModel,
      max_tokens: 2048,
      system,
      messages: toAnthropic(history),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${body?.error?.message ?? ''}`);
  }

  const text = (body.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const toolCalls = (body.content ?? [])
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));

  return { text, toolCalls };
}

/* --------------------------------------------------------------------- OpenAI */

function toOpenAI(system, history) {
  const messages = [{ role: 'system', content: system }];
  for (const entry of history) {
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: entry.text });
    } else if (entry.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: entry.text || null,
        ...(entry.toolCalls?.length
          ? {
              tool_calls: entry.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      });
    } else if (entry.role === 'tool') {
      for (const r of entry.results) {
        messages.push({
          role: 'tool',
          tool_call_id: r.id,
          content: JSON.stringify(r.content),
        });
      }
    }
  }
  return messages;
}

async function callOpenAI({ system, history, tools }) {
  const res = await fetch(`${config.llm.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.llm.openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llm.openaiModel,
      messages: toOpenAI(system, history),
      tools: tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${body?.error?.message ?? ''}`);
  }

  const message = body.choices?.[0]?.message ?? {};
  const toolCalls = (message.tool_calls ?? []).map((c) => {
    let args = {};
    try {
      args = JSON.parse(c.function.arguments || '{}');
    } catch {
      args = {};
    }
    return { id: c.id, name: c.function.name, args };
  });

  return { text: (message.content ?? '').trim(), toolCalls };
}

/* ------------------------------------------------------------------- Fallback */

/**
 * A small rule-based planner for when no model key is configured.
 *
 * This is not the product. It exists so that `npm start` with an empty .env
 * still shows the PayPal integration, the policy engine and the approval queue
 * working. With a key set, none of this code runs.
 */
function fallbackPlan(history) {
  const lastUser = [...history].reverse().find((h) => h.role === 'user')?.text ?? '';
  const text = lastUser.toLowerCase();
  const toolsRan = history.some((h) => h.role === 'tool');
  const id = () => `fb_${Math.random().toString(36).slice(2, 9)}`;

  const amountMatch = lastUser.match(/\$?\s?([\d,]+(?:\.\d{1,2})?)/);
  const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null;
  const emailMatch = lastUser.match(/[\w.+-]+@[\w-]+\.[\w.]+/);

  if (toolsRan) {
    const lastResults = [...history].reverse().find((h) => h.role === 'tool')?.results ?? [];

    // Second hop: a refund needs the capture_id the search just returned.
    const search = lastResults.find((r) => r.name === 'find_payments');
    if (search && /refund|money back|reimburse/.test(text)) {
      const payment = search.content?.result?.payments?.[0];
      if (payment) {
        const refundAmount = amount && amount <= payment.refundable ? amount : null;
        return {
          text: '',
          toolCalls: [
            {
              id: id(),
              name: 'refund_payment',
              args: {
                capture_id: payment.capture_id,
                ...(refundAmount ? { amount: refundAmount } : {}),
                reason: lastUser.slice(0, 180),
              },
            },
          ],
        };
      }
    }

    return {
      text:
        'Done. (Running without a model API key, so this summary is template text — ' +
        'set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env for real reasoning.) ' +
        'The tool results below are real.',
      toolCalls: [],
    };
  }

  if (/refund|money back|reimburse|late|complaint|sorry/.test(text)) {
    return {
      text: '',
      toolCalls: [
        {
          id: id(),
          name: 'find_payments',
          args: emailMatch ? { customer_email: emailMatch[0] } : {},
        },
      ],
    };
  }

  if (/invoice|bill|charge/.test(text) && emailMatch && amount) {
    return {
      text: '',
      toolCalls: [
        {
          id: id(),
          name: 'create_invoice',
          args: {
            recipient_email: emailMatch[0],
            items: [{ name: lastUser.slice(0, 60), quantity: 1, unit_amount: amount }],
            currency: 'USD',
            due_days: 14,
          },
        },
      ],
    };
  }

  if (/owe|outstanding|overdue|unpaid|receivab|who.*paid/.test(text)) {
    return { text: '', toolCalls: [{ id: id(), name: 'list_invoices', args: {} }] };
  }

  if (/policy|rules|limit/.test(text)) {
    return { text: '', toolCalls: [{ id: id(), name: 'get_policy', args: {} }] };
  }

  return {
    text:
      'No model API key is set, so I am running on a small rule-based planner and ' +
      'only understand a few phrasings. Try "who owes me money", "invoice ' +
      'someone@example.com $400 for design work", or "refund the customer who ' +
      'complained". Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env to use the real agent.',
    toolCalls: [],
  };
}

/* ----------------------------------------------------------------------- API */

export async function chat({ system, history, tools }) {
  switch (activeProvider()) {
    case 'anthropic':
      return callAnthropic({ system, history, tools });
    case 'openai':
      return callOpenAI({ system, history, tools });
    default:
      return fallbackPlan(history);
  }
}
