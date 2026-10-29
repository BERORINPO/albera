import { PLANNER_OUTPUT_SCHEMA } from './desktop-planner.mjs';
import { ANTHROPIC_API_URL } from './anthropic-computer-use-client.mjs';

/**
 * Anthropic Messages API client for the planner (spec/architecture.md external boundary). No tools: the reply is
 * constrained to PLANNER_OUTPUT_SCHEMA with structured outputs (`output_config.format`), and the planner module still
 * checks it as untrusted text. Key handling and retries follow anthropic-computer-use-client.mjs: the API key lives in
 * a closure, is sent only in the `x-api-key` header and never appears in an error, an event or a log; 429/5xx are
 * retried at most 3 times. Returns just `{ content, stopReason, usage }`.
 */

export const DEFAULT_PLANNER_MODEL = 'claude-sonnet-5-5';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 8192;
const MAX_RETRIES = 3;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 529]);
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const SAFE_ERROR_TYPE_RE = /^[a-z_]{1,40}$/;
const EFFORTS = new Set(['low', 'medium', 'high']);

export class PlannerClientError extends Error {
  constructor(code, { status } = {}) {
    super(code);
    this.name = 'PlannerClientError';
    this.code = code;
    this.status = status;
  }
}

export function createAnthropicPlannerClient({
  apiKey,
  model = DEFAULT_PLANNER_MODEL,
  effort = 'medium',
  fetchImpl = fetch,
  apiUrl = ANTHROPIC_API_URL,
  timeoutMs = 300_000,
  retryDelayMs = 2000,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 1) throw new TypeError('anthropic_api_key_required');
  if (typeof model !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(model)) throw new TypeError('invalid_planner_model');
  if (!EFFORTS.has(effort)) throw new TypeError('invalid_planner_effort');
  if (typeof fetchImpl !== 'function') throw new TypeError('invalid_fetch');

  async function attempt(body, signal) {
    // A referenced timer keeps the process alive until the deadline, so a hung upstream always ends as anthropic_timeout.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      let response;
      try {
        response = await fetchImpl(apiUrl, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
          body,
          signal: combined,
        });
      }
      catch {
        if (signal?.aborted) throw new PlannerClientError('planner_aborted');
        if (timeout.signal.aborted) throw new PlannerClientError('anthropic_timeout');
        return { retry: true, error: new PlannerClientError('anthropic_network_error') };
      }
      if (response.ok) return { value: await parseSuccess(response) };
      const type = await readErrorType(response);
      const error = new PlannerClientError(`anthropic_http_${response.status}${type ? `_${type}` : ''}`, { status: response.status });
      return RETRY_STATUSES.has(response.status) ? { retry: true, error } : { error, fatal: true };
    }
    finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    model,
    async send(messages, system, { signal } = {}) {
      const body = JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system,
        output_config: { effort, format: { type: 'json_schema', schema: PLANNER_OUTPUT_SCHEMA } },
        messages,
      });
      let last;
      for (let i = 0; i <= MAX_RETRIES; i++) {
        if (signal?.aborted) throw new PlannerClientError('planner_aborted');
        const result = await attempt(body, signal);
        if (result.value) return result.value;
        last = result.error;
        if (result.fatal || i === MAX_RETRIES) break;
        await sleep(retryDelayMs * (i + 1));
      }
      throw last;
    },
  });
}

async function parseSuccess(response) {
  let json;
  try { json = await response.json(); }
  catch { throw new PlannerClientError('anthropic_bad_response'); }
  if (!json || !Array.isArray(json.content) || typeof json.stop_reason !== 'string') throw new PlannerClientError('anthropic_bad_response');
  return { content: json.content, stopReason: json.stop_reason, usage: json.usage && typeof json.usage === 'object' ? json.usage : {} };
}

// Only a short, pattern-checked error type is surfaced; the free-text message is dropped.
async function readErrorType(response) {
  try {
    const text = (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);
    const type = JSON.parse(text)?.error?.type;
    return typeof type === 'string' && SAFE_ERROR_TYPE_RE.test(type) ? type : '';
  }
  catch { return ''; }
}
