import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

loadEnv(path.join(ROOT, '.env'));

const CONFIG = {
  port: readInt(process.env.PORT, 8765),
  provider: (process.env.LLM_PROVIDER || 'mock').trim().toLowerCase(),
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
  const ready = provider === 'mock' ||
    (provider === 'openai' && Boolean(CONFIG.openaiApiKey)) ||
    (provider === 'anthropic' && Boolean(CONFIG.anthropicApiKey));
  const model = provider === 'anthropic' ? CONFIG.anthropicModel : provider === 'openai' ? CONFIG.openaiModel : 'deterministic-mock';
  return { provider, model, ready, allowLocalTools: CONFIG.allowLocalTools };
}

function clientConfig() {
  const status = providerStatus();
  return {
    ...status,
    port: CONFIG.port,
    mode: status.ready ? 'ready' : 'missing_key',
    note: status.ready ? 'runtime ready' : 'provider selected but API key missing; set .env or switch LLM_PROVIDER=mock'
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
      narration: 'The model response was not valid JSON, so VibeOS rendered it as diagnostic text.'
    };
  }
  return {
    title: clip(parsed.title || fallbackTitle, 80),
    html: stripUnsafeHtml(parsed.html || fallbackHtml('Empty response', 'The model returned no HTML.')),
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
  "narration": "one short internal note"
}

Hard rules:
- Do not emit markdown fences.
- Do not include <script>, external network resources, iframes, object/embed, or inline event handlers.
- You may include <style> inside the HTML fragment.
- Use semantic HTML, forms, buttons, inputs, tables, and CSS. The host runtime captures user events.
- Keep the UI self-contained and visually close to Ubuntu/Yaru style: aubergine, orange accents, rounded panels, clean sans-serif typography.
- Keep continuity from the previous HTML/state. Do not reset the app unless requested.
- For calculators and simple deterministic operations, compute exactly.
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

Make the UI complete enough for interaction. Include obvious controls the user can click or submit. Do not add banners or disclaimers about content being generated.`;
}

function eventPrompt(session, event) {
  const target = event.target || {};
  const actionDesc = event.eventType === 'click'
    ? `Clicked: ${target.tag || 'element'} with text "${clip(target.text || '', 80)}" (selector: ${event.clickedSelector || 'unknown'})`
    : event.eventType === 'submit'
    ? `Submitted form with data: ${JSON.stringify(event.formData || {})}`
    : event.eventType === 'enter'
    ? `Pressed Enter in ${target.tag || 'input'} with value "${clip(target.value || '', 200)}"`
    : `Event: ${event.eventType}`;
  const currentButtons = extractInteractiveTags(session.html || '');
  return `The user interacted with this VibeOS iframe app. Generate the next full HTML fragment.

App context:
- appId: ${session.appId || 'custom'}
- title: ${session.title || 'Vibe App'}
- intent: ${session.intent || 'none'}

User action:
${actionDesc}

Current interactive elements on the page:
${currentButtons.slice(0, 30).join('\n')}${currentButtons.length > 30 ? '\n...' : ''}

Previous HTML:
${clip(session.html || '', 12000)}

IMPORTANT RULES:
1. Keep the UI layout, style, and all existing elements as close to the Previous HTML as possible.
2. ONLY modify the part of the UI that should change as a result of this user action.
3. Preserve all user-entered values, form data, and visible state unless the action explicitly changes them.
4. If a button was clicked, perform the action that button is supposed to do (e.g., search, calculate, navigate, add item).
5. For calculators: compute the exact result and update the display.
6. For browsers/search: update the content area with relevant results, keep the address bar and search box.
7. For terminals: append the command and its output to the terminal history.
8. Return strict JSON with title, html, and narration fields only.`;
}

async function generateInitialHtml(app) {
  const title = app.title || 'Vibe App';
  if (CONFIG.provider === 'mock' || !providerStatus().ready) {
    return mockInitial(app);
  }
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: initialUserPrompt(app) }
  ];
  const raw = await callConfiguredLlm(messages);
  return normalizeModelResult(raw, title);
}

async function generateNextHtml(session, event) {
  if (CONFIG.provider === 'mock' || !providerStatus().ready) {
    return mockNext(session, event);
  }
  const userMessage = { role: 'user', content: eventPrompt(session, event) };
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...session.messages.slice(-CONFIG.maxSessionMessages),
    userMessage
  ];
  const raw = await callConfiguredLlm(messages);
  const result = normalizeModelResult(raw, session.title);
  session.messages.push(userMessage, { role: 'assistant', content: JSON.stringify({ title: result.title, narration: result.narration, htmlExcerpt: clip(result.html, 6000) }) });
  while (session.messages.length > CONFIG.maxSessionMessages) {
    const first = session.messages[0];
    if (first.role === 'user' && session.messages.length > 2 && session.messages[1].role === 'assistant') {
      session.messages.splice(0, 2);
    } else {
      session.messages.shift();
    }
  }
  return result;
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
  return withTimeout(async (signal) => {
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
}

async function callAnthropic(messages) {
  return withTimeout(async (signal) => {
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
}

function mockInitial(app) {
  const appId = app.appId || 'custom';
  const title = app.title || appId;
  const intent = app.intent || '';
  const map = {
    calculator: mockCalculator(''),
    browser: mockBrowser('', 'home'),
    terminal: mockTerminal([]),
    notepad: mockNotepad('', 'Untitled note'),
    files: mockFiles(),
    settings: mockSettings(),
    tasks: mockTasks(),
    about: mockAbout(),
    prompt: mockPrompt(),
    custom: mockCustom(title, intent)
  };
  return normalizeModelResult(map[appId] || mockCustom(title, intent), title);
}

function mockNext(session, event) {
  const appId = session.appId;
  const form = event.formData || {};
  const value = event.value || event.text || '';
  if (appId === 'calculator') return normalizeModelResult(mockCalculator(calcExpressionFromEvent(event)), 'Calculator');
  if (appId === 'browser') return normalizeModelResult(mockBrowser(form.q || form.url || value || 'Ubuntu VibeOS', 'results'), 'Vibe Browser');
  if (appId === 'terminal') return normalizeModelResult(mockTerminal(updateTerminalHistory(session, event)), 'Terminal');
  if (appId === 'notepad') return normalizeModelResult(mockNotepad(form.note || event.allInputs?.note || value || '', form.title || 'Untitled note'), 'Text Editor');
  if (appId === 'settings') return normalizeModelResult(mockSettings(value), 'Settings');
  if (appId === 'tasks') return normalizeModelResult(mockTasks(form.task || value), 'Tasks');
  if (appId === 'prompt') return normalizeModelResult(mockPrompt(form.intent || value), 'Vibe Prompt');
  return normalizeModelResult(mockCustom(session.title, `Interaction: ${event.eventType} ${value}`), session.title);
}

function calcExpressionFromEvent(event) {
  const form = event.formData || {};
  const current = form.expression || event.allInputs?.expression || '';
  const text = event.text || event.value || '';
  if (['=', 'Enter'].includes(text)) return current;
  if (text === 'C' || text === 'Clear') return '';
  if (text === '⌫') return current.slice(0, -1);
  if (/^[0-9.+\-*/()%]$/.test(text)) return current + text;
  return current || text;
}

function safeEvalExpression(expression) {
  const expr = String(expression || '').replace(/×/g, '*').replace(/÷/g, '/').trim();
  if (!expr) return '';
  if (!/^[0-9+\-*/().%\s]+$/.test(expr)) return 'Invalid expression';
  try {
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict"; return (${expr})`)();
    if (!Number.isFinite(value)) return String(value);
    return Number(value.toFixed(12)).toString();
  } catch {
    return 'Syntax error';
  }
}

function mockCalculator(expression) {
  const result = safeEvalExpression(expression);
  const buttons = ['7','8','9','/','4','5','6','*','1','2','3','-','0','.','=','+','C','⌫','(',')'];
  return {
    title: 'Calculator',
    html: `<style>
      .calc{height:100%;display:grid;place-items:center;background:linear-gradient(135deg,#2c001e,#77216f);color:#fff;font-family:Ubuntu,Segoe UI,sans-serif}.panel{width:min(340px,92%);background:#241f31;border-radius:18px;padding:18px;box-shadow:0 24px 60px #0007}.display{background:#111;border-radius:12px;padding:14px;margin-bottom:14px}.display input{width:100%;font-size:28px;background:transparent;border:0;color:#fff;outline:0;text-align:right}.result{text-align:right;color:#f6a25b;min-height:24px}.keys{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.keys button{border:0;border-radius:12px;padding:14px;font-size:18px;background:#3d3846;color:#fff}.keys button:hover{background:#e95420}</style>
      <main class="calc"><form class="panel"><div class="display"><input name="expression" value="${escapeHtml(expression)}" placeholder="0" autofocus><div class="result">${escapeHtml(result)}</div></div><div class="keys">${buttons.map(b => `<button type="submit" name="key" value="${escapeHtml(b)}">${escapeHtml(b)}</button>`).join('')}</div></form></main>`,
    narration: 'mock calculator rendered'
  };
}

function mockBrowser(query, mode) {
  const q = query || '';
  const content = mode === 'results' && q ? `
    <section class="notice">Simulated results generated locally. This demo is not browsing the real web.</section>
    <article><h2>${escapeHtml(q)} — simulated overview</h2><p>This hallucinated page demonstrates how a VibeOS-style app can create plausible interface states from intent. Treat all content here as fictional unless you provided it.</p></article>
    <article><h3>Result 1: Ubuntu-style generative desktop</h3><p>A fake result describing a local iframe-based operating environment where each app has its own model session.</p></article>
    <article><h3>Result 2: Agent-driven UI pattern</h3><p>The runtime captures clicks and form submissions, sends event context to a model, and replaces the iframe body with the generated HTML fragment.</p></article>` : `
    <section class="hero"><h1>Vibe Browser</h1><p>Type a query or URL. Results are simulated by the local runtime.</p></section>`;
  return {
    title: 'Vibe Browser',
    html: `<style>
      .browser{font-family:Ubuntu,Segoe UI,sans-serif;background:#f6f5f4;min-height:100%;color:#241f31}.bar{display:flex;gap:8px;padding:10px;background:#3d3846}.bar input{flex:1;border:0;border-radius:999px;padding:10px 14px}.bar button{border:0;border-radius:999px;padding:0 16px;background:#e95420;color:white}.page{padding:22px;max-width:880px;margin:auto}.hero{background:white;border-radius:18px;padding:42px;text-align:center;box-shadow:0 12px 30px #0001}.notice{background:#fff4e5;border-left:5px solid #e95420;padding:12px;border-radius:10px;margin-bottom:16px}article{background:white;border-radius:16px;padding:18px;margin:14px 0;box-shadow:0 8px 24px #00000012}h2,h3{color:#77216f}</style>
      <main class="browser"><form class="bar"><input name="q" value="${escapeHtml(q)}" placeholder="Search or enter address"><button type="submit">Go</button></form><div class="page">${content}</div></main>`,
    narration: 'mock browser rendered'
  };
}

function updateTerminalHistory(session, event) {
  const history = session.mockState?.terminalHistory || [];
  const cmd = event.formData?.cmd || event.allInputs?.cmd || event.value || '';
  const next = [...history];
  if (cmd.trim()) next.push({ cmd: cmd.trim(), output: terminalOutput(cmd.trim()) });
  session.mockState = { ...(session.mockState || {}), terminalHistory: next.slice(-20) };
  return session.mockState.terminalHistory;
}

function terminalOutput(cmd) {
  if (cmd === 'help') return 'Available fake commands: help, neofetch, ls, pwd, date, echo <text>, open <app>, clear';
  if (cmd === 'neofetch') return 'VibeOS Demo 1.0\nHost: Windows-native Node.js runtime\nShell: hallucinated terminal\nUI: Ubuntu/Yaru-inspired';
  if (cmd === 'ls') return 'Desktop  Documents  Downloads  Pictures  vibe-notes.txt';
  if (cmd === 'pwd') return '/home/vibe';
  if (cmd === 'date') return new Date().toString();
  if (cmd.startsWith('echo ')) return cmd.slice(5);
  if (cmd.startsWith('open ')) return `Request noted: ${cmd}. Use the dock to open apps in this demo.`;
  if (cmd === 'clear') return '__CLEAR__';
  return `${cmd}: command simulated, not executed. Type help.`;
}

function mockTerminal(history = []) {
  const visible = history.some(h => h.cmd === 'clear') ? history.slice(history.findLastIndex?.(h => h.cmd === 'clear') + 1 || 0) : history;
  return {
    title: 'Terminal',
    html: `<style>
      .term{height:100%;background:#300a24;color:#f7f7f7;font-family:Cascadia Mono,Consolas,monospace;padding:14px;box-sizing:border-box}.line{white-space:pre-wrap;line-height:1.45}.prompt{color:#8ff0a4}.out{color:#deddda;margin-bottom:8px}.cmd{display:flex;gap:8px;align-items:center}.cmd input{flex:1;background:transparent;border:0;border-bottom:1px solid #5e2750;color:#fff;font:inherit;outline:0;padding:6px}</style>
      <main class="term"><div class="line">VibeOS Terminal — simulated shell. Type <b>help</b>.</div>${visible.map(h => `<div class="line"><span class="prompt">vibe@demo:~$</span> ${escapeHtml(h.cmd)}</div><div class="line out">${escapeHtml(h.output === '__CLEAR__' ? '' : h.output)}</div>`).join('')}<form class="cmd"><span class="prompt">vibe@demo:~$</span><input name="cmd" autofocus autocomplete="off"><button type="submit" hidden>Run</button></form></main>`,
    narration: 'mock terminal rendered'
  };
}

function mockNotepad(note, title) {
  return {
    title: 'Text Editor',
    html: `<style>
      .note{height:100%;display:flex;flex-direction:column;background:#f6f5f4;font-family:Ubuntu,Segoe UI,sans-serif}.toolbar{display:flex;gap:8px;background:#deddda;padding:8px}.toolbar input{border:0;border-radius:8px;padding:8px;min-width:220px}.toolbar button{border:0;border-radius:8px;background:#e95420;color:white;padding:8px 12px}textarea{flex:1;border:0;resize:none;padding:18px;font:16px/1.5 "Segoe UI",sans-serif;outline:0}.status{padding:6px 12px;background:#fff;color:#5e5c64}</style>
      <form class="note"><div class="toolbar"><input name="title" value="${escapeHtml(title)}"><button type="submit">Save in session</button></div><textarea name="note" placeholder="Write notes here...">${escapeHtml(note)}</textarea><div class="status">Session-only note. No disk writes.</div></form>`,
    narration: 'mock editor rendered'
  };
}

function mockFiles() {
  const rows = [
    ['Desktop', 'Folder', 'Today'], ['Documents', 'Folder', 'Today'], ['Downloads', 'Folder', 'Yesterday'], ['vibe-notes.txt', 'Text document', 'Today'], ['demo-screenshot.png', 'Image', 'Simulated']
  ];
  return {
    title: 'Files',
    html: `<style>
      .files{display:grid;grid-template-columns:180px 1fr;height:100%;font-family:Ubuntu,Segoe UI,sans-serif;background:#fff}.side{background:#f6f5f4;border-right:1px solid #deddda;padding:14px}.side button{display:block;width:100%;text-align:left;border:0;background:transparent;border-radius:8px;padding:9px}.side button:hover{background:#e9542030}.main{padding:18px}.crumb{color:#77216f;font-weight:700;margin-bottom:14px}table{width:100%;border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #eee;text-align:left}tr:hover{background:#fff4e5}.tag{background:#deddda;border-radius:999px;padding:4px 8px}</style>
      <main class="files"><aside class="side"><button>Home</button><button>Desktop</button><button>Documents</button><button>Downloads</button><button>Trash</button></aside><section class="main"><div class="crumb">Home / vibe</div><table><thead><tr><th>Name</th><th>Type</th><th>Modified</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHtml(r[0])}</td><td><span class="tag">${escapeHtml(r[1])}</span></td><td>${escapeHtml(r[2])}</td></tr>`).join('')}</tbody></table><p>This file manager is simulated and cannot read your disk.</p></section></main>`,
    narration: 'mock files rendered'
  };
}

function mockSettings(selected = '') {
  return {
    title: 'Settings',
    html: `<style>
      .settings{height:100%;display:grid;grid-template-columns:210px 1fr;font-family:Ubuntu,Segoe UI,sans-serif;background:#fff}.nav{background:#f6f5f4;padding:12px;border-right:1px solid #deddda}.nav button{display:block;width:100%;border:0;background:transparent;text-align:left;padding:10px;border-radius:10px}.nav button:hover,.nav .active{background:#e95420;color:white}.pane{padding:24px}.card{border:1px solid #deddda;border-radius:16px;padding:18px;margin:0 0 14px;box-shadow:0 8px 22px #0000000d}.switch{float:right;background:#e95420;color:#fff;border-radius:999px;padding:4px 10px}</style>
      <main class="settings"><aside class="nav"><button class="active">Appearance</button><button>Network</button><button>Privacy</button><button>LLM Runtime</button><button>About</button></aside><section class="pane"><h1>Settings</h1><div class="card"><b>Theme</b><span class="switch">Yaru Dark/Light</span><p>Ubuntu-inspired desktop shell with aubergine panels and orange accents.</p></div><div class="card"><b>LLM provider</b><p>Configured by the local .env file. Current selection: ${escapeHtml(CONFIG.provider)}.</p></div><div class="card"><b>Security</b><p>Apps are sandboxed iframes. Generated script and inline event handlers are stripped by the server.</p></div><p>${escapeHtml(selected)}</p></section></main>`,
    narration: 'mock settings rendered'
  };
}

function mockTasks(task = '') {
  const items = ['Wire iframe event bridge', 'Keep app sessions isolated', 'Render Ubuntu-style shell'];
  if (task) items.unshift(task);
  return {
    title: 'Tasks',
    html: `<style>
      .tasks{font-family:Ubuntu,Segoe UI,sans-serif;background:#f6f5f4;height:100%;padding:24px;box-sizing:border-box}.board{max-width:640px;margin:auto;background:white;border-radius:18px;padding:20px;box-shadow:0 18px 50px #0002}form{display:flex;gap:8px}input{flex:1;border:1px solid #deddda;border-radius:10px;padding:10px}button{border:0;background:#e95420;color:#fff;border-radius:10px;padding:10px 14px}li{padding:11px;margin:8px 0;background:#fff4e5;border-radius:12px}</style>
      <main class="tasks"><section class="board"><h1>Tasks</h1><form><input name="task" placeholder="Add a simulated task"><button>Add</button></form><ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul></section></main>`,
    narration: 'mock task app rendered'
  };
}

function mockPrompt(intent = '') {
  const preview = intent ? `<div class="preview"><h2>Generated app idea</h2><p>${escapeHtml(intent)}</p><p>In real LLM mode, describe the app here and the model will transform this window into that app after submission.</p></div>` : '';
  return {
    title: 'Vibe Prompt',
    html: `<style>
      .prompt{font-family:Ubuntu,Segoe UI,sans-serif;min-height:100%;background:linear-gradient(135deg,#2c001e,#77216f);color:white;display:grid;place-items:center}.box{width:min(680px,92%);background:#ffffff12;border:1px solid #ffffff25;border-radius:22px;padding:28px;backdrop-filter:blur(10px)}textarea{width:100%;height:130px;border:0;border-radius:14px;padding:14px;font:16px Segoe UI,sans-serif}button{border:0;border-radius:999px;padding:12px 18px;background:#e95420;color:#fff;margin-top:10px}.preview{background:#0002;border-radius:16px;margin-top:16px;padding:16px}</style>
      <main class="prompt"><form class="box"><h1>Describe an app</h1><p>The current iframe session will be regenerated from your prompt.</p><textarea name="intent" placeholder="Example: make a kanban board for app launch tasks">${escapeHtml(intent)}</textarea><br><button type="submit">Generate inside this window</button>${preview}</form></main>`,
    narration: 'mock prompt rendered'
  };
}

function mockAbout() {
  return {
    title: 'About VibeOS',
    html: `<style>
      .about{font-family:Ubuntu,Segoe UI,sans-serif;background:#f6f5f4;min-height:100%;display:grid;place-items:center}.card{max-width:720px;background:white;border-radius:24px;padding:30px;box-shadow:0 24px 70px #0002}.logo{width:74px;height:74px;border-radius:20px;background:linear-gradient(135deg,#e95420,#77216f);display:grid;place-items:center;color:#fff;font-size:38px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.pill{background:#fff4e5;border-radius:14px;padding:12px}</style>
      <main class="about"><section class="card"><div class="logo">◆</div><h1>VibeOS Demo</h1><p>Local experimental hallucinated desktop: Node.js server, browser shell, iframe apps, independent LLM sessions.</p><div class="grid"><div class="pill">Provider: ${escapeHtml(CONFIG.provider)}</div><div class="pill">Model: ${escapeHtml(providerStatus().model)}</div><div class="pill">Scripts stripped</div><div class="pill">No local shell execution</div></div></section></main>`,
    narration: 'mock about rendered'
  };
}

function mockCustom(title, intent) {
  return {
    title: title || 'Vibe App',
    html: `<style>
      .custom{font-family:Ubuntu,Segoe UI,sans-serif;min-height:100%;background:#f6f5f4;padding:24px;box-sizing:border-box}.card{background:white;border-radius:20px;padding:24px;box-shadow:0 18px 50px #0002}button{border:0;border-radius:10px;background:#e95420;color:white;padding:10px 14px}input{border:1px solid #deddda;border-radius:10px;padding:10px}</style>
      <main class="custom"><section class="card"><h1>${escapeHtml(title || 'Vibe App')}</h1><p>${escapeHtml(intent || 'This is a generated placeholder app. Configure an LLM provider for richer behavior.')}</p><form><input name="message" placeholder="Interact with this app"><button>Send</button></form></section></main>`,
    narration: 'mock custom app rendered'
  };
}

async function createSession(payload) {
  const session = {
    id: id('session'),
    appId: payload.appId || 'custom',
    title: payload.title || 'Vibe App',
    intent: payload.intent || '',
    messages: [],
    html: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mockState: {}
  };
  const result = await generateInitialHtml(payload);
  session.title = result.title || session.title;
  session.html = result.html;
  session.messages.push({ role: 'user', content: initialUserPrompt(payload) });
  session.messages.push({ role: 'assistant', content: JSON.stringify({ title: result.title, narration: result.narration, htmlExcerpt: clip(result.html, 6000) }) });
  sessions.set(session.id, session);
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
    if (!session) return send(res, 404, { error: 'session_not_found' });
    const event = await readJson(req);
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
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || (error.name === 'AbortError' ? 504 : 500);
    send(res, status, { error: error.name || 'error', message: error.message || String(error) });
  }
});

server.listen(CONFIG.port, '127.0.0.1', () => {
  const status = providerStatus();
  console.log(`VibeOS demo running at http://127.0.0.1:${CONFIG.port}`);
  console.log(`LLM_PROVIDER=${status.provider}; model=${status.model}; ready=${status.ready}`);
  if (!status.ready) console.log('Provider selected but API key is missing. Edit .env or use LLM_PROVIDER=mock.');
  console.log('No local OS commands are executed by this demo.');
});
