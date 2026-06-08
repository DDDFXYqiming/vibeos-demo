import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as logger from './logger.js';

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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
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

function stripUnsafeHtml(html) {
  let out = String(html || '');
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  out = out.replace(/javascript:/gi, '');
  return out.slice(0, CONFIG.maxHtmlChars);
}

function tryParseJson(text) {
  const raw = String(text || '').trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(unfenced); } catch {}
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(unfenced.slice(first, last + 1)); } catch {}
  }
  return null;
}

function normalizeModelResult(result, fallbackTitle = 'Vibe App') {
  const parsed = typeof result === 'string' ? tryParseJson(result) : result;
  if (!parsed || typeof parsed !== 'object') {
    return {
      title: fallbackTitle,
      html: fallbackHtml('Model returned non-JSON output', clip(result, 2500)),
      state: {},
      narration: 'The model response was not valid JSON, so VibeOS rendered it as diagnostic text.'
    };
  }
  const state = parsed.state || {};
  return {
    title: clip(parsed.title || fallbackTitle, 80),
    html: stripUnsafeHtml(parsed.html || fallbackHtml('Empty response', 'The model returned no HTML.')),
    state: typeof state === 'object' && !Array.isArray(state) ? state : {},
    narration: clip(parsed.narration || parsed.explanation || '', 800)
  };
}

function fallbackHtml(title, detail) {
  return `<main class="app app-diagnostic"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main>`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function systemPrompt() {
  return `You are the UI renderer for VibeOS, a desktop operating system. Each app is an isolated iframe session, and you generate the next UI from user events.

Return ONLY a strict JSON object with exactly these fields:
{
  "title": "short window title",
  "html": "complete HTML fragment for the iframe body; no <html>, no <body>, no <script>",
  "state": { "arbitrary": "JSON object representing the app's internal state" },
  "narration": "one short internal note"
}

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
- Do not add any banners, warnings, or disclaimers about content being generated, simulated, or artificial. Present all content as real.
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

Make the UI complete enough for interaction. Include obvious controls the user can click or submit.

CRITICAL: You must also define an initial "state" object that represents the app's starting data:
- Calculator: { expression: "", result: "", history: [] }
- Terminal: { history: [] }
- Browser: { url: "", query: "", bookmarks: [] }
- Files: { path: "/home/user", selected: [] }
- Tasks: { tasks: [] }
- Notepad: { text: "", title: "Untitled" }
- Custom app: design an appropriate state structure

The state must capture ALL data that the user can modify through interactions.
Do not add banners or disclaimers about content being generated.`;
}

function eventPrompt(session, event) {
  const target = event.target || {};
  const tag = target.tag || 'element';
  const role = target.role || '';
  const name = target.accessibleName || target.ariaLabel || target.name || '';
  const selector = event.clickedSelector || '';
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

  // P1: Send trace + state + action, not full HTML dump
  return `The user interacted with this VibeOS app. Generate the next HTML and updated state.

App context:
- appId: ${session.appId || 'custom'}
- title: ${session.title || 'Vibe App'}
- intent: ${session.intent || 'none'}

User action:
${actionDesc}

Current application state (JSON):
${stateStr}

${trace ? `Recent user interaction trace (newest first):\n${trace}\n` : ''}
Current form/input values snapshot:
${JSON.stringify(allInputs, null, 2).slice(0, 2000)}

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
3. Keep the UI layout and style consistent. Only modify what the action changes.
4. For input_snapshot events: do NOT regenerate the full page — only update state to capture the typed text.
5. Return strict JSON with title, html, state, and narration fields.`;
}

async function generateInitialHtml(app) {
  const title = app.title || 'Vibe App';
  const t = logger.timer('llm', { prv: CONFIG.provider, mdl: providerStatus().model, typ: 'init', aid: app.appId });
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: initialUserPrompt(app) }
  ];
  try {
    const raw = await callConfiguredLlm(messages);
    const result = normalizeModelResult(raw, title);
    t.stop({ ok: 1, hlen: result.html.length });
    return result;
  } catch (e) {
    t.stop({ ok: 0, err: e.message.slice(0, 80) });
    throw e;
  }
}

async function generateNextHtml(session, event) {
  const t = logger.timer('llm', { prv: CONFIG.provider, mdl: providerStatus().model, typ: 'next', aid: session.appId, etp: event.eventType });
  const userMessage = { role: 'user', content: eventPrompt(session, event) };
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...session.messages.slice(-CONFIG.maxSessionMessages),
    userMessage
  ];
  try {
    const raw = await callConfiguredLlm(messages);
    const result = normalizeModelResult(raw, session.title);
    session.appState = result.state;
    session.messages.push(userMessage, { role: 'assistant', content: JSON.stringify({ title: result.title, narration: result.narration, htmlExcerpt: clip(result.html, 6000) }) });
    // P2: Preserve the first user message (initial intent) — only prune middle pairs
    while (session.messages.length > CONFIG.maxSessionMessages) {
      // Skip index 0 (initial intent) — start pruning from index 2
      if (session.messages.length > 4 && session.messages[2].role === 'user' && session.messages[3]?.role === 'assistant') {
        session.messages.splice(2, 2);
      } else if (session.messages.length > 2) {
        session.messages.splice(2, 1);
      } else {
        break;
      }
    }
    t.stop({ ok: 1, hlen: result.html.length, mcnt: session.messages.length });
    return result;
  } catch (e) {
    t.stop({ ok: 0, err: e.message.slice(0, 80) });
    throw e;
  }
}

async function callConfiguredLlm(messages) {
  if (CONFIG.provider === 'openai') return callOpenAi(messages);
  if (CONFIG.provider === 'anthropic') return callAnthropic(messages);
  throw new Error(`Unsupported LLM_PROVIDER: ${CONFIG.provider}`);
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

async function callOpenAi(messages) {
  const t = logger.timer('llm', { prv: 'openai', mdl: CONFIG.openaiModel, thk: CONFIG.thinkingLevel });
  const totalChars = messages.reduce((sum, m) => sum + String(m.content).length, 0);
  try {
    const result = await withTimeout(async (signal) => {
      const resp = await fetch(`${CONFIG.openaiBaseUrl}/chat/completions`, {
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
          if (CONFIG.thinkingLevel !== 'off') {
            payload.extra_body = {
              enable_thinking: true,
              thinking_budget: THINKING_BUDGET_MAP[CONFIG.thinkingLevel] || 4096
            };
          }
          return payload;
        })())
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`OpenAI-compatible API error ${resp.status}: ${clip(text, 1500)}`);
      const data = JSON.parse(text);
      return data.choices?.[0]?.message?.content || '';
    }, CONFIG.timeoutMs);
    t.stop({ tin: logger.estTok(totalChars), tou: logger.estTok(result), ok: 1 });
    return result;
  } catch (e) {
    t.stop({ tin: logger.estTok(totalChars), ok: 0, err: e.message.slice(0, 80) });
    throw e;
  }
}

async function callAnthropic(messages) {
  const t = logger.timer('llm', { prv: 'anthropic', mdl: CONFIG.anthropicModel, thk: CONFIG.thinkingLevel });
  const totalChars = messages.reduce((sum, m) => sum + String(m.content).length, 0);
  try {
    const result = await withTimeout(async (signal) => {
      const system = messages.find(m => m.role === 'system')?.content || systemPrompt();
      const filtered = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }));
      const resp = await fetch(`${CONFIG.anthropicBaseUrl}/v1/messages`, {
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
            messages: filtered
          };
          if (CONFIG.thinkingLevel !== 'off') {
            payload.thinking = {
              type: 'enabled',
              budget_tokens: THINKING_BUDGET_MAP[CONFIG.thinkingLevel] || 4096
            };
            payload.max_tokens = Math.max(payload.max_tokens, (THINKING_BUDGET_MAP[CONFIG.thinkingLevel] || 4096) + 1024);
          }
          return payload;
        })())
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`Anthropic API error ${resp.status}: ${clip(text, 1500)}`);
      const data = JSON.parse(text);
      return (data.content || []).map(part => part.type === 'text' ? part.text : '').join('\n');
    }, CONFIG.timeoutMs);
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
    updatedAt: new Date().toISOString()
  };
  const result = await generateInitialHtml(payload);
  session.title = result.title || session.title;
  session.html = result.html;
  session.appState = result.state;
  session.messages.push({ role: 'user', content: initialUserPrompt(payload) });
  session.messages.push({ role: 'assistant', content: JSON.stringify({ title: result.title, narration: result.narration, htmlExcerpt: clip(result.html, 6000) }) });
  sessions.set(session.id, session);
  logger.info('sess', { act: 'create', sid: session.id, aid: session.appId, cnt: sessions.size });
  return { session, result };
}

async function handleApi(req, res, url) {
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
    const payload = await readJson(req);
    const { session, result } = await createSession(payload);
    logs.push({ t: Date.now(), type: 'session:create', id: session.id, appId: session.appId });
    return send(res, 200, { id: session.id, title: result.title, html: result.html, narration: result.narration, provider: providerStatus() });
  }
  const eventMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/event$/);
  if (req.method === 'POST' && eventMatch) {
    const session = sessions.get(eventMatch[1]);
    if (!session) {
      logger.warn('evt', { act: 'drop', sid: eventMatch[1], why: 'session_not_found' });
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
      return send(res, 200, { id: session.id, title: session.title, html: session.html, narration: '', provider: providerStatus(), silent: true });
    }

    const result = await generateNextHtml(session, event);
    session.title = result.title || session.title;
    session.html = result.html;
    session.updatedAt = new Date().toISOString();
    logs.push({ t: Date.now(), type: 'session:event', id: session.id, appId: session.appId, eventType: event.eventType });
    return send(res, 200, { id: session.id, title: result.title, html: result.html, narration: result.narration, provider: providerStatus() });
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    return send(res, 200, logs.slice(-100));
  }
  return notFound(res);
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
