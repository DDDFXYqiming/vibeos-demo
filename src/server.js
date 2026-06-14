import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as logger from './logger.js';
import {
  appContractText,
  getCachedInitialResult,
  getStaticAppResult,
  normalizeAppState,
  selectThinkingLevel,
  stateSchemaText,
  storeCachedInitialResult
} from './vibe-runtime.js';
import {
  generateWithParseRetry,
  normalizeModelResult as normalizeModelResultRobust,
  timeoutForModel
} from './model-output.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

loadEnv(path.join(ROOT, '.env'));

const CONFIG = {
  port: readInt(process.env.PORT, 8765),
  provider: (process.env.LLM_PROVIDER || 'openai').trim().toLowerCase(),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
  anthropicBaseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  timeoutMs: readInt(process.env.LLM_TIMEOUT_MS, 45_000),
  maxSessionMessages: readInt(process.env.MAX_SESSION_MESSAGES, 10),
  maxHtmlChars: readInt(process.env.MAX_HTML_CHARS, 16_000),
  allowLocalTools: String(process.env.VIBEOS_ALLOW_LOCAL_TOOLS || 'false').toLowerCase() === 'true',
  thinkingLevel: (process.env.LLM_THINKING_LEVEL || 'off').trim().toLowerCase()
};

const THINKING_BUDGET_MAP = {
  low: 1024,
  medium: 4096,
  high: 8192,
  max: 16384
};

const sessions = new Map();
const logs = [];

// Session idle GC: a setInterval that drops sessions that haven't been
// touched in SESSION_TTL_MS. The Map is mutated in place so the runtime
// state stays consistent.
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_GC_INTERVAL_MS = 60 * 1000; // 1 minute
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - (session.lastActivityAt || 0) > SESSION_TTL_MS) {
      sessions.delete(id);
      logger.info('sess', { act: 'gc', sid: id, ageMs: now - session.lastActivityAt });
    }
  }
}, SESSION_GC_INTERVAL_MS).unref?.();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function readInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(payload);
}

function notFound(res) {
  send(res, 404, { error: 'not_found' });
}

function safeJoin(base, requestedPath) {
  const resolved = path.resolve(base, requestedPath.replace(/^\/+/, ''));
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

// Maximum JSON request body size (1 MB). A LLM-driven demo should never
// legitimately exceed this; rejecting early protects the server from
// accidental or hostile unbounded reads.
const MAX_JSON_BYTES = 1_000_000;

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) {
      const err = new Error('Request body too large.');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('Invalid JSON request body.');
    err.status = 400;
    throw err;
  }
}

function providerStatus() {
  const provider = CONFIG.provider;
  const ready = (provider === 'openai' && Boolean(CONFIG.openaiApiKey)) ||
    (provider === 'anthropic' && Boolean(CONFIG.anthropicApiKey));
  const model = provider === 'anthropic' ? CONFIG.anthropicModel : CONFIG.openaiModel;
  return { provider, model, ready, allowLocalTools: CONFIG.allowLocalTools };
}

function clientConfig() {
  const status = providerStatus();
  return {
    ...status,
    port: CONFIG.port,
    mode: status.ready ? 'ready' : 'missing_key',
    note: status.ready ? 'runtime ready' : 'provider selected but API key missing; set .env'
  };
}

function id(prefix = 's') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function extractStyleBlock(html) {
  const match = String(html || '').match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return match ? match[1].trim() : '';
}

function extractStructureOutline(html) {
  // Extract a skeleton of the DOM structure (tags + key attributes only, no text content)
  const out = [];
  const stack = [];
  const tagRe = /<\/?([a-z0-9]+)([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const isClose = m[0].startsWith('</');
    const isSelfClose = m[0].endsWith('/>') || ['br','hr','img','input','meta','link'].includes(tag);
    if (isClose) {
      if (stack.length > 0 && stack[stack.length - 1] === tag) stack.pop();
      continue;
    }
    // Skip style/script content
    if (tag === 'style' || tag === 'script') continue;
    // Extract key structural attributes
    const keyAttrs = [];
    const idMatch = attrs.match(/\sid=["']([^"']+)["']/i);
    if (idMatch) keyAttrs.push('#' + idMatch[1]);
    const clsMatch = attrs.match(/\sclass=["']([^"']+)["']/i);
    if (clsMatch) keyAttrs.push('.' + clsMatch[1].split(/\s+/).slice(0, 2).join('.'));
    const nameMatch = attrs.match(/\sname=["']([^"']+)["']/i);
    if (nameMatch) keyAttrs.push('@' + nameMatch[1]);
    const indent = '  '.repeat(stack.length);
    out.push(indent + '<' + tag + (keyAttrs.length ? ' ' + keyAttrs.join(' ') : '') + '>');
    if (!isSelfClose) stack.push(tag);
    // Prevent infinite stack growth on malformed HTML
    if (stack.length > 50) break;
  }
  return out.slice(0, 60).join('\n');
}

function extractInteractiveTags(html) {
  const tags = [];
  const btnRe = /<button[^>]*>([\s\S]*?)<\/button>/gi;
  const inputRe = /<input[^>]*>/gi;
  const aRe = /<a[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = btnRe.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim().slice(0, 40);
    if (text) tags.push(`- button: "${text}"`);
  }
  while ((m = inputRe.exec(html)) !== null) {
    const type = (m[0].match(/type=["']([^"']+)["']/) || [])[1] || 'text';
    const name = (m[0].match(/name=["']([^"']+)["']/) || [])[1] || '';
    const value = (m[0].match(/value=["']([^"']+)["']/) || [])[1] || '';
    const placeholder = (m[0].match(/placeholder=["']([^"']+)["']/) || [])[1] || '';
    if (type === 'submit' || type === 'button') tags.push(`- input[type=${type}]${name ? ' name=' + name : ''}${value ? ' value="' + value + '"' : ''}`);
    else if (name || placeholder) tags.push(`- input[type=${type}]${name ? ' name=' + name : ''}${placeholder ? ' placeholder="' + placeholder + '"' : ''}`);
  }
  while ((m = aRe.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim().slice(0, 40);
    if (text) tags.push(`- a: "${text}"`);
  }
  return tags;
}

function clip(value, max = 8000) {
  const str = String(value ?? '');
  return str.length > max ? `${str.slice(0, max)}\n...[clipped ${str.length - max} chars]` : str;
}


function systemPrompt() {
  return `You are the UI renderer for VibeOS, a desktop operating system. Each app is an isolated iframe session, and you generate the next UI from user events.

You MUST return a strict JSON object with at least these 4 fields:
{
  "title": "short window title",
  "html": "complete HTML fragment for the iframe body",
  "state": { "arbitrary": "JSON object representing the app's internal state" },
  "narration": "one short internal note"
}

You MAY also include a "patch" field when only a local region changed:
{
  "patch": { "selector": "#stable-element", "mode": "replaceInnerHTML", "html": "safe replacement HTML" }
}

CRITICAL: Your response MUST contain the field "html" with the full HTML content even when patch is present. Do not omit it or use any other field name.

The "state" field is CRITICAL. It must be a valid JSON object that captures all mutable data of the app:
- Calculator: current expression, display value, calculation history
- Terminal: command history array [{cmd, output}]
- Browser: current URL, search query, page content data
- Files: current directory, selected items
- Tasks: task list array [{text, done}]
- Notepad: document text, title
- Custom apps: whatever data the app needs to function

Hard rules:
- Do not emit markdown fences.
- Do not include <script>, external network resources, iframes, object/embed, or inline event handlers.
- You may include <style> inside the HTML fragment.
- Use semantic HTML, forms, buttons, inputs, tables, and CSS. The host runtime captures user events.
- Keep the UI self-contained and visually close to Ubuntu/Yaru style: aubergine, orange accents, rounded panels, clean sans-serif typography.
- Keep continuity from the previous HTML/state. Do not reset the app unless requested.
- For calculators and simple deterministic operations, compute exactly.
- When responding to user actions: FIRST update the "state" object, THEN render the HTML based on the updated state.
- The state object should be complete enough that if the page were reloaded, the same HTML could be regenerated from state alone.
- NEVER add banners, warnings, disclaimers, or notices about content being "simulated", "generated", "artificial", "hallucinated", "for demonstration", "AI-generated", or "not real". Do not use the ⚠ symbol for this purpose. Present ALL content as real. This is the single most important rule — violating it breaks the user experience.
- If the user asks for dangerous, private, destructive, or credential-related behavior, render a safe refusal inside the app UI.`;
}

function initialUserPrompt(app) {
  const appId = app.appId || 'custom';
  const title = app.title || 'Vibe App';
  const intent = app.intent || '';
  return `Create the initial UI for this VibeOS app.
App id: ${appId}
Window title: ${title}
User intent: ${intent || 'A useful desktop app.'}

${appContractText(appId)}
${stateSchemaText(appId)}

Make the UI complete enough for interaction. Include obvious controls the user can click or submit, and add stable data-vibe-action attributes for important controls such as browser.search, task.add, task.toggle, note.save, calculator.input, recovery.retry, recovery.simplify, and recovery.reset.

CRITICAL: You must also define an initial "state" object that represents the app's starting data:
- Calculator: { expression: "", result: "", history: [] }
- Terminal: { history: [] }
- Browser: { url: "", query: "", bookmarks: [] }
- Files: { path: "/home/user", selected: [] }
- Tasks: { tasks: [] }
- Notepad: { text: "", title: "Untitled" }
- Custom app: design an appropriate state structure

The state must capture ALL data that the user can modify through interactions.
Use a consistent visual style across all generated HTML: dark terminal apps should use a dark background (#1e1e2e or similar) with monospace fonts and syntax highlighting. Light apps should use clean white/light-gray backgrounds. All apps should feel like native Ubuntu desktop software.
NEVER add banners, warnings, or disclaimers about simulated/generated/AI content. Present everything as real.`;
}

function eventPrompt(session, event) {
  const target = event.target || {};
  const tag = target.tag || 'element';
  const role = target.role || '';
  const name = target.accessibleName || target.ariaLabel || target.name || '';
  const selector = event.clickedSelector || '';
  const semanticAction = event.semanticAction || `${session.appId || 'custom'}.${event.eventType || 'event'}`;
  const allInputs = event.allInputs || (session.appState?._liveInputs) || {};

  // P0: Rich event descriptions for every event type
  let actionDesc;
  switch (event.eventType) {
    case 'click':
      actionDesc = `Clicked: [${role || tag}] "${clip(target.text || name || '', 80)}" (selector: ${selector})`;
      break;
    case 'submit':
      actionDesc = `Submitted form with data: ${JSON.stringify(event.formData || {})}`;
      break;
    case 'enter':
      actionDesc = `Typed "${clip(target.value || '', 200)}" in [${role || tag}] "${name || target.id || 'input'}", then pressed Enter`;
      break;
    case 'change': {
      const val = target.type === 'checkbox'
        ? (target.value === 'true' || target.value === true ? 'checked' : 'unchecked')
        : `"${clip(target.value || '', 100)}"`;
      actionDesc = `Changed: [${role || tag}] "${name || target.id || 'input'}" → ${val}`;
      break;
    }
    case 'input_snapshot':
      actionDesc = `User is typing in [${role || tag}] "${name || target.id || 'input'}" — current value: "${clip(target.value || '', 200)}"`;
      break;
    default:
      actionDesc = `Event: ${event.eventType}`;
  }

  // Clean internal tracking fields before sending to LLM
  const cleanState = session.appState ? { ...session.appState } : {};
  delete cleanState._liveInputs;
  const stateStr = Object.keys(cleanState).length ? JSON.stringify(cleanState, null, 2) : '{}';
  const trace = event.interactionTrace || '';

  // Style preservation: extract CSS and structural skeleton from previous HTML
  const prevStyle = extractStyleBlock(session.html || '');
  const prevStructure = extractStructureOutline(session.html || '');

  // P1: Send trace + state + action + style contract, not full HTML dump
  return `The user interacted with this VibeOS app. Generate the next HTML and updated state.

App context:
- appId: ${session.appId || 'custom'}
- title: ${session.title || 'Vibe App'}
- intent: ${session.intent || 'none'}

${appContractText(session.appId || 'custom')}
${stateSchemaText(session.appId || 'custom')}

User action:
${actionDesc}
Semantic action: ${semanticAction}

Current application state (JSON):
${stateStr}

${trace ? `Recent user interaction trace (newest first):\n${trace}\n` : ''}
Current form/input values snapshot:
${JSON.stringify(allInputs, null, 2).slice(0, 2000)}

${prevStyle ? `PREVIOUS CSS STYLES (MUST reuse these exact styles in your <style> block — do NOT change colors, fonts, spacing, or layout):\n<style>\n${clip(prevStyle, 4000)}\n</style>\n` : ''}
${prevStructure ? `PREVIOUS PAGE STRUCTURE (MUST maintain this exact DOM structure — only update content inside existing elements, do NOT add/remove/reorder major sections):\n${prevStructure}\n` : ''}

CRITICAL INSTRUCTIONS:
1. FIRST, update the "state" object based on the user's action:
   - Calculator: append digit/operator to expression, compute on =, clear on C
   - Terminal: append {cmd, output} to history array
   - Browser: update url/query, generate results content
   - Tasks: add new task to tasks array, toggle done status
   - Notepad: update text/title from form data, preserve all typed content
   - Files: update path, selected items
   - For input_snapshot: preserve all current input values in state, do NOT reset the page
2. THEN, render HTML that reflects the UPDATED state. All input fields must retain their current values.
3. STYLE CONTRACT: Reuse the PREVIOUS CSS STYLES exactly. Only change content, never the visual style.
4. STRUCTURE CONTRACT: Maintain the PREVIOUS PAGE STRUCTURE. Do NOT add/remove/reorder sections.
5. For input_snapshot events: do NOT regenerate the full page — only update state to capture the typed text.
6. NEVER add banners, warnings, or disclaimers about simulated/generated/AI content. Present everything as real.
7. Prefer a patch field for small localized updates: { selector, mode: "replaceInnerHTML", html }. Keep full html valid as fallback.
8. Return strict JSON with title, html, state, narration, and optional patch fields.${event.lastPatchFailed ? `\n9. PATCH FEEDBACK: Your previous "patch" was rejected by the client because its selector did not match the live DOM. For THIS turn you MUST return a complete "html" field that fully recreates the app body (you may omit the "patch" field entirely, or include one for a known-stable selector such as "#results" / "#history"). Do not rely on patch-only updates until at least one full-HTML render has succeeded.` : ''}`;
}

async function generateInitialHtml(app) {
  const title = app.title || 'Vibe App';
  const staticResult = getStaticAppResult(app);
  if (staticResult) return staticResult;
  const provider = providerStatus();
  const thinkingLevel = selectThinkingLevel({ appId: app.appId || 'custom', eventType: 'init', configured: CONFIG.thinkingLevel });
  const cached = getCachedInitialResult(app, provider, thinkingLevel);
  if (cached) {
    logger.info('llm', { act: 'template_cache_hit', aid: app.appId || 'custom', thk: thinkingLevel });
    return cached;
  }
  const t = logger.timer('llm', { prv: CONFIG.provider, mdl: provider.model, typ: 'init', aid: app.appId, thk: thinkingLevel });
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: initialUserPrompt(app) }
  ];
  try {
    let result = await generateWithParseRetry({
      messages,
      callLlm: (nextMessages) => callConfiguredLlm(nextMessages, { thinkingLevel }),
      fallbackTitle: title,
      retryPrompt: 'Your previous response was not strict parseable JSON for the VibeOS renderer.',
      normalizeOptions: { logger, maxHtmlChars: CONFIG.maxHtmlChars }
    });
    // Retry once more if LLM returned parseable JSON but omitted usable HTML.
    if (!result.html || result.html.includes('The model returned no HTML')) {
      logger.warn('llm', { act: 'retry_empty_html', aid: app.appId, typ: 'init' });
      const retryMessages = [
        ...messages,
        { role: 'user', content: 'Your previous response was missing the "html" field. You MUST return a JSON object with EXACTLY these fields: "title", "html", "state", "narration". Do NOT use "htmlExcerpt" or "_htmlSummary" — use the field name "html" with the full HTML content. Return the complete JSON again.' }
      ];
      result = normalizeModelResultRobust(await callConfiguredLlm(retryMessages, { thinkingLevel }), title, { logger, maxHtmlChars: CONFIG.maxHtmlChars });
    }
    result.state = normalizeAppState(app.appId || 'custom', {}, result.state);
    storeCachedInitialResult(app, provider, thinkingLevel, result);
    t.stop({ ok: 1, hlen: result.html.length, prs: result.parseSource || '' });
    return result;
  } catch (e) {
    t.stop({ ok: 0, err: e.message.slice(0, 80) });
    throw e;
  }
}

async function generateNextHtml(session, event) {
  const thinkingLevel = selectThinkingLevel({ appId: session.appId || 'custom', eventType: event.eventType || 'event', configured: CONFIG.thinkingLevel });
  const t = logger.timer('llm', { prv: CONFIG.provider, mdl: providerStatus().model, typ: 'next', aid: session.appId, etp: event.eventType, thk: thinkingLevel });
  const userMessage = { role: 'user', content: eventPrompt(session, event) };
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...session.messages.slice(-CONFIG.maxSessionMessages),
    userMessage
  ];
  try {
    let result = await generateWithParseRetry({
      messages,
      callLlm: (nextMessages) => callConfiguredLlm(nextMessages, { thinkingLevel }),
      fallbackTitle: session.title,
      retryPrompt: 'Your previous response was not strict parseable JSON for the VibeOS renderer.',
      normalizeOptions: { logger, maxHtmlChars: CONFIG.maxHtmlChars }
    });
    // Retry once more if LLM returned parseable JSON but omitted usable HTML.
    if (!result.html || result.html.includes('The model returned no HTML')) {
      logger.warn('llm', { act: 'retry_empty_html', aid: session.appId, etp: event.eventType });
      const retryMessages = [
        ...messages,
        { role: 'user', content: 'Your previous response was missing the "html" field. You MUST return a JSON object with EXACTLY these fields: "title", "html", "state", "narration". Do NOT use "htmlExcerpt" or "_htmlSummary" — use the field name "html" with the full HTML content. Return the complete JSON again.' }
      ];
      result = normalizeModelResultRobust(await callConfiguredLlm(retryMessages, { thinkingLevel }), session.title, { logger, maxHtmlChars: CONFIG.maxHtmlChars });
    }
    session.appState = normalizeAppState(session.appId || 'custom', session.appState, result.state);
    result.state = session.appState;
    session.messages.push(userMessage, { role: 'assistant', content: `Rendered "${result.title}". ${result.narration} State: ${JSON.stringify(result.state).slice(0, 800)}` });
    // P2: Preserve the first user message (initial intent) — only prune middle pairs.
    // Single O(1) splice instead of an O(n) while-loop with repeated splice() calls.
    // messages[0] is the initial intent; pruning starts at index 2 to keep that anchor.
    if (session.messages.length > CONFIG.maxSessionMessages) {
      const overflow = session.messages.length - CONFIG.maxSessionMessages;
      // Keep at least the initial intent (index 0) and the new pair at the tail.
      const maxPrunable = Math.max(0, session.messages.length - 2);
      const pruneCount = Math.min(overflow, maxPrunable - 1);
      if (pruneCount > 0) session.messages.splice(2, pruneCount);
    }
    t.stop({ ok: 1, hlen: result.html.length, mcnt: session.messages.length, prs: result.parseSource || '' });
    return result;
  } catch (e) {
    t.stop({ ok: 0, err: e.message.slice(0, 80) });
    throw e;
  }
}

async function callConfiguredLlm(messages, options = {}) {
  if (CONFIG.provider === 'openai') return callOpenAi(messages, options);
  if (CONFIG.provider === 'anthropic') return callAnthropic(messages, options);
  throw new Error(`Unsupported LLM_PROVIDER: ${CONFIG.provider}`);
}

// Enforce Anthropic's strict user/assistant alternation. Two consecutive
// user turns get folded into a single turn separated by '\n\n' so the wire
// payload remains valid even when the conversation history skips a turn.
function enforceAlternation(messages) {
  const out = [];
  for (const msg of messages) {
    const last = out[out.length - 1];
    if (last && last.role === msg.role) {
      last.content = `${last.content}\n\n${msg.content}`;
    } else {
      out.push({ ...msg });
    }
  }
  // Anthropic requires the first message to be a user turn.
  if (out.length && out[0].role === 'assistant') {
    out.unshift({ role: 'user', content: '(continuation)' });
  }
  return out;
}

async function withTimeout(promiseFactory, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await promiseFactory(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// ── Provider retry + circuit breaker ────────────────────────────────────────
// Classify an HTTP error so we know whether to retry, wait, or give up.
function classifyHttpError(status) {
  if (status === 429) return { retry: true, wait: 'retry-after' };
  if (status >= 500 && status < 600) return { retry: true, wait: 'backoff' };
  if (status === 408 || status === 425) return { retry: true, wait: 'backoff' };
  return { retry: false };
}

// Per-provider circuit breaker: opens after N consecutive failures, then
// short-circuits subsequent calls for a cooldown window so we don't
// hammer a downed provider.
const CIRCUIT_STATE = new Map(); // name -> { failures, openedAt, threshold, cooldownMs }
function circuitRecord(name) {
  return CIRCUIT_STATE.get(name) || (CIRCUIT_STATE.set(name, { failures: 0, openedAt: 0, threshold: 5, cooldownMs: 30_000 }).get(name));
}
function circuitAllow(name) {
  const c = circuitRecord(name);
  if (!c.openedAt) return true;
  if (Date.now() - c.openedAt > c.cooldownMs) {
    // Half-open: allow a single probe.
    c.openedAt = 0;
    c.failures = 0;
    return true;
  }
  return false;
}
function circuitRecordSuccess(name) {
  const c = circuitRecord(name);
  c.failures = 0;
  c.openedAt = 0;
}
function circuitRecordFailure(name) {
  const c = circuitRecord(name);
  c.failures += 1;
  if (c.failures >= c.threshold) c.openedAt = Date.now();
}

// Sleep with abort signal awareness so a circuit-breaker / client disconnect
// can interrupt the backoff window.
function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Generic fetch-based retry wrapper used by both OpenAI and Anthropic
// providers. Classifies status codes, honours Retry-After, and updates the
// circuit breaker state.
async function withFetchRetry(name, url, init, { attempts = 3, baseDelayMs = 400, signal } = {}) {
  if (!circuitAllow(name)) {
    const err = new Error(`Provider "${name}" is in cooldown. Try again shortly.`);
    err.status = 503;
    throw err;
  }
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, { ...init, signal });
      if (resp.ok) {
        circuitRecordSuccess(name);
        return resp;
      }
      const decision = classifyHttpError(resp.status);
      const text = await resp.text();
      if (!decision.retry) {
        // Non-retryable: surface immediately.
        circuitRecordFailure(name);
        throw new Error(`${name} API error ${resp.status}: ${clip(text, 1500)}`);
      }
      lastError = new Error(`${name} API error ${resp.status}: ${clip(text, 1500)}`);
      if (i === attempts - 1) break; // last attempt, don't sleep
      let waitMs = baseDelayMs * Math.pow(2, i);
      if (decision.wait === 'retry-after') {
        const ra = Number.parseFloat(resp.headers.get('retry-after') || '');
        if (Number.isFinite(ra)) waitMs = Math.max(waitMs, ra * 1000);
      }
      await sleep(waitMs, signal);
    } catch (e) {
      if (e?.name === 'AbortError') { circuitRecordFailure(name); throw e; }
      // Network errors (DNS, ECONNRESET, etc.) — retry once.
      lastError = e;
      if (i === attempts - 1) break;
      await sleep(baseDelayMs * Math.pow(2, i), signal);
    }
  }
  circuitRecordFailure(name);
  throw lastError;
}

async function callOpenAi(messages, options = {}) {
  const thinkingLevel = options.thinkingLevel || CONFIG.thinkingLevel;
  const t = logger.timer('llm', { prv: 'openai', mdl: CONFIG.openaiModel, thk: thinkingLevel });
  const totalChars = messages.reduce((sum, m) => sum + String(m.content).length, 0);
  try {
    const result = await withTimeout(async (signal) => {
      const resp = await withFetchRetry('openai', `${CONFIG.openaiBaseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${CONFIG.openaiApiKey}`
        },
        body: JSON.stringify((() => {
          const payload = {
            model: CONFIG.openaiModel,
            messages,
            temperature: 0.45,
            response_format: { type: 'json_object' }
          };
          if (thinkingLevel !== 'off') {
            payload.extra_body = {
              enable_thinking: true,
              thinking_budget: THINKING_BUDGET_MAP[thinkingLevel] || 4096
            };
          }
          return payload;
        })())
      }, { signal });
      const text = await resp.text();
      const data = JSON.parse(text);
      return data.choices?.[0]?.message?.content || '';
    }, timeoutForModel({ model: CONFIG.openaiModel, thinkingLevel, baseTimeoutMs: CONFIG.timeoutMs }));
    t.stop({ tin: logger.estTok(totalChars), tou: logger.estTok(result), ok: 1 });
    return result;
  } catch (e) {
    t.stop({ tin: logger.estTok(totalChars), ok: 0, err: e.message.slice(0, 80) });
    throw e;
  }
}

async function callAnthropic(messages, options = {}) {
  const thinkingLevel = options.thinkingLevel || CONFIG.thinkingLevel;
  const t = logger.timer('llm', { prv: 'anthropic', mdl: CONFIG.anthropicModel, thk: thinkingLevel });
  const totalChars = messages.reduce((sum, m) => sum + String(m.content).length, 0);
  try {
    const result = await withTimeout(async (signal) => {
      const system = messages.find(m => m.role === 'system')?.content || systemPrompt();
      const filtered = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }));
      // Anthropic's API requires strict user→assistant alternation. If two
      // user messages sit next to each other, fold them into a single user
      // turn so the request is well-formed even when the conversation
      // history hits a state machine edge case.
      const normalized = enforceAlternation(filtered);
      const resp = await withFetchRetry('anthropic', `${CONFIG.anthropicBaseUrl}/v1/messages`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': CONFIG.anthropicApiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify((() => {
          const payload = {
            model: CONFIG.anthropicModel,
            max_tokens: 4096,
            temperature: 0.45,
            system,
            messages: normalized
          };
          if (thinkingLevel !== 'off') {
            payload.thinking = {
              type: 'enabled',
              budget_tokens: THINKING_BUDGET_MAP[thinkingLevel] || 4096
            };
            payload.max_tokens = Math.max(payload.max_tokens, (THINKING_BUDGET_MAP[thinkingLevel] || 4096) + 1024);
          }
          return payload;
        })())
      }, { signal });
      const text = await resp.text();
      const data = JSON.parse(text);
      return (data.content || []).map(part => part.type === 'text' ? part.text : '').join('\n');
    }, timeoutForModel({ model: CONFIG.anthropicModel, thinkingLevel, baseTimeoutMs: CONFIG.timeoutMs }));
    t.stop({ tin: logger.estTok(totalChars), tou: logger.estTok(result), ok: 1 });
    return result;
  } catch (e) {
    t.stop({ tin: logger.estTok(totalChars), ok: 0, err: e.message.slice(0, 80) });
    throw e;
  }
}

async function createSession(payload) {
  const session = {
    id: id('session'),
    appId: payload.appId || 'custom',
    title: payload.title || 'Vibe App',
    intent: payload.intent || '',
    messages: [],
    html: '',
    appState: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: Date.now(),
    // Inflight chain: each subsequent LLM call on this session awaits the
    // previous one so we never race two generateNextHtml() on the same state.
    inflight: Promise.resolve()
  };
  const result = await generateInitialHtml(payload);
  session.title = result.title || session.title;
  session.html = result.html;
  session.appState = result.state;
  session.messages.push({ role: 'user', content: initialUserPrompt(payload) });
  session.messages.push({ role: 'assistant', content: `Rendered "${result.title}". ${result.narration} State: ${JSON.stringify(result.state).slice(0, 800)}` });
  sessions.set(session.id, session);
  logger.info('sess', { act: 'create', sid: session.id, aid: session.appId, cnt: sessions.size });
  return { session, result };
}

async function handleApi(req, res, url) {
  // Lightweight route table: each entry is [method, path-matcher, handler].
  // path-matcher can be a string (exact) or { regex, param } for parametric
  // routes. First match wins, falling through to 404 if nothing matches.
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    const session = sessions.get(m[1]);
    if (!session) return send(res, 404, { error: 'session_not_found' });
    return send(res, 200, { id: session.id, appId: session.appId, title: session.title, intent: session.intent, html: session.html, state: session.appState, provider: providerStatus() });
  }
  const e = url.pathname.match(/^\/api\/sessions\/([^/]+)\/event$/);
  if (req.method === 'POST' && e) {
    return handleSessionEvent(req, res, e[1]);
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true, time: new Date().toISOString(), sessions: sessions.size });
  }
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, clientConfig());
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    return send(res, 200, Array.from(sessions.values()).map(s => ({ id: s.id, appId: s.appId, title: s.title, intent: s.intent, updatedAt: s.updatedAt })));
  }
  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    return handleCreateSession(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    return send(res, 200, logs.slice(-100));
  }
  return notFound(res);
}

async function handleCreateSession(req, res) {
  const payload = await readJson(req);
  const { session, result } = await createSession(payload);
  logs.push({ t: Date.now(), type: 'session:create', id: session.id, appId: session.appId });
  return send(res, 200, { id: session.id, title: result.title, html: result.html, patch: result.patch || null, narration: result.narration, provider: providerStatus() });
}

async function handleSessionEvent(req, res, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    logger.warn('evt', { act: 'drop', sid: sessionId, why: 'session_not_found' });
    return send(res, 404, { error: 'session_not_found' });
  }
  const event = await readJson(req);
  logger.perf('evt', { etp: event.eventType, aid: session.appId, sid: session.id, sel: event.clickedSelector?.slice(0, 40) || '' });

  // input_snapshot: update state silently, no LLM call
  if (event.eventType === 'input_snapshot') {
    if (event.allInputs) {
      session.appState = { ...session.appState, _liveInputs: event.allInputs };
    }
    session.updatedAt = new Date().toISOString();
    session.lastActivityAt = Date.now();
    return send(res, 200, { id: session.id, title: session.title, html: session.html, narration: '', provider: providerStatus(), silent: true });
  }

  // Serialize concurrent events on the same session so two LLM calls can't
  // race over session.html / session.appState. Each new chain awaits the
  // previous one (mirroring the front-end record.queue pattern).
  const prevInflight = session.inflight || Promise.resolve();
  const work = prevInflight.then(() => generateNextHtml(session, event));
  session.inflight = work.catch(() => {}); // never let a rejection poison the chain
  const result = await work;
  session.title = result.title || session.title;
  session.html = result.html;
  session.updatedAt = new Date().toISOString();
  session.lastActivityAt = Date.now();
  logs.push({ t: Date.now(), type: 'session:event', id: session.id, appId: session.appId, eventType: event.eventType });
  return send(res, 200, { id: session.id, title: result.title, html: result.html, patch: result.patch || null, narration: result.narration, provider: providerStatus() });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = safeJoin(PUBLIC_DIR, pathname);
  if (!file) return notFound(res);
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=60',
      'x-content-type-options': 'nosniff'
    });
    const stream = fs.createReadStream(file);
    stream.on('error', () => notFound(res));
    stream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const t = logger.timer('http', { m: req.method, p: url.pathname });
  try {
    if (url.pathname.startsWith('/api/')) {
      const result = await handleApi(req, res, url);
      t.stop({ st: res.statusCode || 200 });
      return result;
    }
    const result = serveStatic(req, res, url);
    t.stop({ st: res.statusCode || 200 });
    return result;
  } catch (error) {
    const status = error.status || (error.name === 'AbortError' ? 504 : 500);
    t.stop({ st: status, err: error.message.slice(0, 60) });
    send(res, status, { error: error.name || 'error', message: error.message || String(error) });
  }
});

server.listen(CONFIG.port, '127.0.0.1', () => {
  const status = providerStatus();
  console.log(`VibeOS demo running at http://127.0.0.1:${CONFIG.port}`);
  console.log(`LLM_PROVIDER=${status.provider}; model=${status.model}; ready=${status.ready}`);
  if (!status.ready) console.log('Provider selected but API key is missing. Edit .env.');
  console.log('No local OS commands are executed by this demo.');
  logger.info('sys', { act: 'start', port: CONFIG.port, prv: status.provider, mdl: status.model, ready: status.ready });

  // Periodic system stats every 60s
  setInterval(() => {
    const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 10) / 10;
    logger.info('sys', { act: 'tick', mem: memMB, sess: sessions.size });
  }, 60000);

  // Daily log cleanup
  setInterval(() => logger.cleanup(), 86400000);
});

// Prevent silent crashes from unhandled async errors
process.on('unhandledRejection', (reason) => {
  logger.err('sys', { act: 'unhandled_rejection', err: String(reason).slice(0, 200) });
});
process.on('uncaughtException', (err) => {
  logger.err('sys', { act: 'uncaught_exception', err: err.message?.slice(0, 200) });
});
