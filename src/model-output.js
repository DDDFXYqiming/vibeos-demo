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

const STYLE_BLOCK_RE = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const STYLE_BUDGET_RATIO = 0.6; // up to 60% of maxHtmlChars may be reserved for <style> blocks
const STYLE_CLIP_NOTICE = '\n/* ... css clipped for size ... */\n';
const BODY_CLIP_NOTICE = '\n<!-- body clipped -->';

function splitStyleAndBody(html) {
  const blocks = [];
  const body = String(html || '').replace(STYLE_BLOCK_RE, (_, css) => {
    blocks.push(css);
    return '';
  });
  return { body, blocks };
}

// Public: extract the concatenated CSS contents of every <style> block in
// `html`. This is the canonical "all styles" view used by the eventPrompt
// to keep CSS continuity across LLM turns.
export function extractAllStyleBlocks(html) {
  return splitStyleAndBody(html).blocks.join('\n\n');
}

function styleBlockSize(css) {
  return css.length + '<style></style>'.length;
}

function clipStyleBlock(css, max) {
  if (css.length <= max) return css;
  const keep = Math.max(0, Math.floor(max - STYLE_CLIP_NOTICE.length));
  return css.slice(0, keep) + STYLE_CLIP_NOTICE;
}

export function stripUnsafeHtml(html, maxHtmlChars = DEFAULT_MAX_HTML_CHARS) {
  let out = String(html || '');
  // Strip <script> blocks. The [\s\S] wildcard with the i flag catches
  // <script> through </script> across newlines and case variants.
  out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  // Strip inline event handlers. The previous regexes missed a few edge
  // cases that attackers (and LLMs) commonly emit:
  //   - whitespace between attribute name and "=":  "on click ="
  //   - backtick-quoted values:                    onerror=`...`
  //   - unquoted values:                           onerror=foo()
  //   - uppercase / mixed-case attribute names:    OnClick=
  //   - newlines / tabs inside the attribute:      on\nerror=
  // The new regex handles all of these.
  // Strip inline event handlers. The leading whitespace pattern (`\s+` —
  // not `\b`) is intentional: it lets the regex consume the trailing
  // space that precedes the attribute, so we don't leave a stray " "
  // inside the tag. Common edge cases the previous regexes missed:
  //   - whitespace between attribute name and "=":  "on click ="
  //   - backtick-quoted values:                    onerror=`...`
  //   - unquoted values:                           onerror=foo()
  //   - uppercase / mixed-case attribute names:    OnClick=
  //   - newlines / tabs inside the attribute:      on\nerror=
  out = out.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\s+on[a-z]+\s*=\s*`[^`]*`/gi, '');
  // Unquoted attribute values terminate at the next whitespace or `>` per
  // the HTML5 spec. The character class stays narrow on purpose: a wider
  // class (e.g. excluding only `\s>`) would let quoted values fall through
  // and get partially eaten.
  out = out.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');
  // javascript: protocol — case-insensitive, also catches `JavaScript:` and
  // percent-encoded variants.
  out = out.replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, '');
  out = out.replace(/&#0*106;?|&#[xX]0*6[aA];?/gi, ''); // &#106; / &#x6A; → "j"

  // ── Style-preserving truncation ──
  // Strip all <style> blocks, compute the body budget that remains, then re-attach
  // the style blocks up front. This prevents the previous behavior of slicing the
  // entire string in the middle, which frequently cut <style> tags in half and
  // collapsed the app's visual style.
  const { body, blocks } = splitStyleAndBody(out);

  if (!blocks.length) {
    // No <style> blocks — behavior matches the old simple slice.
    if (body.length <= maxHtmlChars) return body;
    return body.slice(0, maxHtmlChars);
  }

  const styleBudget = Math.max(0, Math.floor(maxHtmlChars * STYLE_BUDGET_RATIO));
  const originalStyleSize = blocks.reduce((sum, css) => sum + styleBlockSize(css), 0);

  let styleHtml;
  if (originalStyleSize <= styleBudget) {
    styleHtml = blocks.map(css => `<style>${css}</style>`).join('\n');
  } else {
    // CSS itself is larger than budget — clip each block proportionally.
    const perBlockCssBudget = Math.max(0, Math.floor(styleBudget / blocks.length) - '<style></style>'.length);
    styleHtml = blocks.map(css => `<style>${clipStyleBlock(css, perBlockCssBudget)}</style>`).join('\n');
  }

  const bodyBudget = Math.max(0, maxHtmlChars - styleHtml.length);
  const clippedBody = body.length > bodyBudget
    ? body.slice(0, bodyBudget) + BODY_CLIP_NOTICE
    : body;

  return styleHtml + clippedBody;
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
  // Short-circuit: the most common case is that the raw candidate already
  // parses cleanly. Only fall back to repair variants when JSON.parse rejects.
  // Repair variants are sorted cheapest-first so we never pay for expensive
  // transforms (control-char sweep, escape repair) when a simple comma
  // removal would have done the job.
  const variants = [
    candidate,
    candidate.replace(/,\s*([}\]])/g, '$1'),
    removeControlChars(candidate),
    repairInvalidJsonEscapes(candidate),
    repairInvalidJsonEscapes(removeControlChars(candidate).replace(/,\s*([}\]])/g, '$1'))
  ];
  let lastError = null;
  for (const variant of variants) {
    try {
      return { parsed: JSON.parse(variant), error: null };
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

// Module-level cache for the field-extraction regexes used by looseExtractModelObject.
// Re-creating a RegExp on every call is wasted work for hot event handlers.
const FIELD_RE_CACHE = Object.create(null);
function getFieldRe(field) {
  if (!FIELD_RE_CACHE[field]) {
    FIELD_RE_CACHE[field] = new RegExp(`"${field}"\\s*:\\s*"`, 'i');
  }
  return FIELD_RE_CACHE[field];
}
const FIELD_OBJECT_RE_CACHE = Object.create(null);
function getFieldObjectRe(field) {
  if (!FIELD_OBJECT_RE_CACHE[field]) {
    FIELD_OBJECT_RE_CACHE[field] = new RegExp(`"${field}"\\s*:\\s*`, 'i');
  }
  return FIELD_OBJECT_RE_CACHE[field];
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
  const match = getFieldRe(field).exec(text);
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
  const match = getFieldObjectRe(field).exec(text);
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
    // Serialise the Error to a plain string — Error objects don't survive
    // JSON.stringify() and clients only ever need the message anyway.
    parseError: parsedResult.error ? String(parsedResult.error.message || parsedResult.error) : null
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
