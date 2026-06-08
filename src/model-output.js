import { normalizePatch } from './vibe-runtime.js';

const DEFAULT_MAX_HTML_CHARS = 16_000;

export function clip(value, max = 8000) {
  const str = String(value ?? '');
  return str.length > max ? `${str.slice(0, max)}\n...[clipped ${str.length - max} chars]` : str;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function stripUnsafeHtml(html, maxHtmlChars = DEFAULT_MAX_HTML_CHARS) {
  let out = String(html || '');
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  out = out.replace(/javascript:/gi, '');
  return out.slice(0, maxHtmlChars);
}

export function fallbackHtml(title, detail) {
  return `<main class="app app-diagnostic"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main>`;
}

function stripMarkdownFences(text) {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function repairInvalidJsonEscapes(text) {
  // JSON only permits: \" \\ \/ \b \f \n \r \t \uXXXX.
  // Some LLMs emit CSS/HTML snippets with stray escapes such as \★, \-, \'.
  // Drop the stray backslash while preserving valid JSON escapes.
  return String(text).replace(/\\(?!["\\/bfnrtu])/g, '');
}

function removeControlChars(text) {
  return String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function findOutermostJsonObject(text) {
  const first = text.indexOf('{');
  if (first === -1) return '';
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = first; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(first, i + 1);
    }
  }
  return text.slice(first);
}

function parseJsonCandidate(candidate) {
  const attempts = [
    candidate,
    candidate.replace(/,\s*([}\]])/g, '$1'),
    removeControlChars(candidate),
    repairInvalidJsonEscapes(candidate),
    repairInvalidJsonEscapes(removeControlChars(candidate).replace(/,\s*([}\]])/g, '$1'))
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      return { parsed: JSON.parse(attempt), error: null };
    } catch (error) {
      lastError = error;
    }
  }
  return { parsed: null, error: lastError };
}

export function parseModelOutput(text) {
  const unfenced = stripMarkdownFences(text);
  const whole = parseJsonCandidate(unfenced);
  if (whole.parsed) return { parsed: whole.parsed, source: 'json', error: null };

  const objectCandidate = findOutermostJsonObject(unfenced);
  if (objectCandidate && objectCandidate !== unfenced) {
    const objectResult = parseJsonCandidate(objectCandidate);
    if (objectResult.parsed) return { parsed: objectResult.parsed, source: 'json_object', error: null };
  }

  const loose = looseExtractModelObject(unfenced);
  if (loose) return { parsed: loose, source: 'loose', error: whole.error };
  return { parsed: null, source: 'none', error: whole.error };
}

export function tryParseJson(text) {
  return parseModelOutput(text).parsed;
}

function looseExtractModelObject(text) {
  const title = extractJsonStringField(text, 'title');
  const html = extractJsonStringField(text, 'html');
  if (!html) return null;
  const narration = extractJsonStringField(text, 'narration') || extractJsonStringField(text, 'explanation') || '';
  const state = extractJsonObjectField(text, 'state') || {};
  return {
    title: title || 'Vibe App',
    html,
    state: typeof state === 'object' && !Array.isArray(state) ? state : {},
    narration
  };
}

function extractJsonStringField(text, field) {
  const marker = new RegExp(`"${field}"\\s*:\\s*"`, 'i');
  const match = marker.exec(text);
  if (!match) return '';
  let i = match.index + match[0].length;
  let out = '';
  let escape = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      out += decodeJsonEscape(ch, text, i);
      if (ch === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) i += 4;
      escape = false;
      continue;
    }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') return out;
    out += ch;
  }
  return out;
}

function decodeJsonEscape(ch, text, index) {
  if (ch === 'n') return '\n';
  if (ch === 'r') return '\r';
  if (ch === 't') return '\t';
  if (ch === 'b') return '\b';
  if (ch === 'f') return '\f';
  if (ch === 'u') {
    const hex = text.slice(index + 1, index + 5);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) return String.fromCharCode(Number.parseInt(hex, 16));
  }
  // For invalid JSON escapes, keep the escaped character and discard only the backslash.
  return ch;
}

function extractJsonObjectField(text, field) {
  const marker = new RegExp(`"${field}"\\s*:\\s*`, 'i');
  const match = marker.exec(text);
  if (!match) return null;
  const start = text.indexOf('{', match.index + match[0].length);
  if (start === -1) return null;
  const candidate = findOutermostJsonObject(text.slice(start));
  if (!candidate) return null;
  const result = parseJsonCandidate(candidate);
  return result.parsed;
}

export function normalizeModelResult(result, fallbackTitle = 'Vibe App', options = {}) {
  const maxHtmlChars = options.maxHtmlChars || DEFAULT_MAX_HTML_CHARS;
  const logger = options.logger;
  const parsedResult = typeof result === 'string'
    ? parseModelOutput(result)
    : { parsed: result, source: 'object', error: null };
  const parsed = parsedResult.parsed;

  if (!parsed || typeof parsed !== 'object') {
    logger?.warn?.('llm', { act: 'parse_fail', raw: clip(result, 300), err: parsedResult.error?.message?.slice(0, 120) || '' });
    return {
      title: fallbackTitle,
      html: fallbackHtml('Model returned non-JSON output', clip(result, 2500)),
      state: {},
      narration: 'The model response was not valid JSON, so VibeOS rendered it as diagnostic text.',
      parseSource: 'none',
      parseError: parsedResult.error
    };
  }

  if (parsedResult.source === 'loose') {
    logger?.warn?.('llm', { act: 'loose_extract', err: parsedResult.error?.message?.slice(0, 120) || '' });
  }

  const state = parsed.state || {};
  const html = parsed.html || '';
  if (!html) {
    logger?.warn?.('llm', { act: 'empty_html', keys: Object.keys(parsed).join(','), narration: clip(parsed.narration || '', 100) });
  }

  return {
    title: clip(parsed.title || fallbackTitle, 80),
    html: stripUnsafeHtml(html || fallbackHtml('Empty response', 'The model returned no HTML.'), maxHtmlChars),
    patch: normalizePatch(parsed.patch, maxHtmlChars),
    state: typeof state === 'object' && !Array.isArray(state) ? state : {},
    narration: clip(parsed.narration || parsed.explanation || '', 800),
    parseSource: parsedResult.source,
    parseError: parsedResult.error
  };
}

export async function generateWithParseRetry({ messages, callLlm, fallbackTitle, retryPrompt, normalizeOptions = {} }) {
  const raw = await callLlm(messages);
  const first = normalizeModelResult(raw, fallbackTitle, normalizeOptions);
  if (first.parseSource !== 'none' && first.parseSource !== 'loose') return first;

  const retryMessages = [
    ...messages,
    {
      role: 'user',
      content: `${retryPrompt}\n\nPrevious parse problem: ${first.parseError?.message || 'invalid JSON'}\nReturn ONLY one strict JSON object with exactly these fields: title, html, state, narration. Do not use markdown fences. Escape double quotes and newlines correctly. Do not use invalid backslash escapes such as \\' or \\-.`
    }
  ];
  const retryRaw = await callLlm(retryMessages);
  return normalizeModelResult(retryRaw, fallbackTitle, normalizeOptions);
}

export function timeoutForModel({ model = '', thinkingLevel = 'off', baseTimeoutMs = 45_000 } = {}) {
  const explicit = Number.parseInt(baseTimeoutMs, 10);
  const base = Number.isFinite(explicit) ? explicit : 45_000;
  const slowModel = /(?:^|[-_.])(pro|max|reason|thinking)(?:$|[-_.])/i.test(model);
  const slowThinking = !['', 'off', 'low'].includes(String(thinkingLevel || '').toLowerCase());
  return slowModel || slowThinking ? Math.max(base, 120_000) : base;
}
