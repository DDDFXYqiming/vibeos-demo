import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.join(__dirname, '..', 'logs');

const LEVELS = { perf: 0, info: 1, warn: 2, err: 3 };
let cfg = {
  enabled: true,
  minLevel: 'perf',
  toStdout: true,
  toFile: true,
  maxDays: 7,
};

function ensureDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

function logFilePath() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `vibeos-${y}${m}${day}.ndjson`);
}

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[cfg.minLevel];
}

// ── Async write stream cache (one open file handle per day) ────────────────
// Replaces the old per-line fs.appendFileSync() calls. Async writes don't
// block the Event Loop, eliminating 3-4 sync I/O round-trips per LLM call.
let _stream = null;
let _streamPath = '';

function getStream(targetPath) {
  if (_stream && _streamPath === targetPath) return _stream;
  if (_stream) {
    try { _stream.end(); } catch {}
    _stream = null;
  }
  try {
    _stream = fs.createWriteStream(targetPath, { flags: 'a' });
    _stream.on('error', () => { _stream = null; });
    _streamPath = targetPath;
  } catch {
    _stream = null;
  }
  return _stream;
}

// Best-effort synchronous flush on process exit so the last few log lines
// aren't lost when the server is killed.
function flushOnExit() {
  if (!_stream) return;
  try { _stream.write = _stream.write.bind(_stream); } catch {}
  // Drain whatever the OS buffer is holding.
  try {
    if (typeof _stream.cork === 'function') _stream.cork();
  } catch {}
  if (_stream && typeof _stream.destroy === 'function') {
    try { _stream.destroy(); } catch {}
  }
  _stream = null;
}
process.on('exit', flushOnExit);
process.on('SIGINT', () => { flushOnExit(); process.exit(0); });
process.on('SIGTERM', () => { flushOnExit(); process.exit(0); });

function write(entry) {
  if (!cfg.enabled) return;
  const line = JSON.stringify(entry) + '\n';
  if (cfg.toStdout) {
    const color = entry.lvl === 'err' ? '\x1b[31m' : entry.lvl === 'warn' ? '\x1b[33m' : entry.lvl === 'perf' ? '\x1b[36m' : '\x1b[32m';
    process.stdout.write(`${color}[${entry.cat}]\x1b[0m ${line}`);
  }
  if (cfg.toFile) {
    ensureDir();
    const stream = getStream(logFilePath());
    if (stream && stream.writable) {
      try { stream.write(line); return; } catch {}
    }
    // Fallback: sync append if the stream is unavailable (e.g. fd exhausted).
    try { fs.appendFileSync(logFilePath(), line); } catch {}
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function configure(opts) {
  cfg = { ...cfg, ...opts };
}

/**
 * Log a performance event.
 * @param {string} cat - category: llm|evt|http|sess|sys
 * @param {Object} fields - payload fields (merged into log entry)
 */
export function perf(cat, fields) {
  if (!shouldLog('perf')) return;
  write({ t: Date.now(), lvl: 'perf', cat, ...fields });
}

export function info(cat, fields) {
  if (!shouldLog('info')) return;
  write({ t: Date.now(), lvl: 'info', cat, ...fields });
}

export function warn(cat, fields) {
  if (!shouldLog('warn')) return;
  write({ t: Date.now(), lvl: 'warn', cat, ...fields });
}

export function err(cat, fields) {
  if (!shouldLog('err')) return;
  write({ t: Date.now(), lvl: 'err', cat, ...fields });
}

/**
 * Create a timer that logs duration when stopped.
 * @param {string} cat
 * @param {Object} baseFields - fields to include in the final log
 * @returns {{stop: (extra?: Object) => void}}
 */
export function timer(cat, baseFields = {}) {
  const start = process.hrtime.bigint();
  return {
    stop(extra = {}) {
      const durMs = Number(process.hrtime.bigint() - start) / 1e6;
      perf(cat, { ...baseFields, dur: Math.round(durMs * 100) / 100, ...extra });
    },
  };
}

/**
 * Estimate token count from text. Rough heuristic that distinguishes CJK
 * characters (≈1.5 chars/token) from ASCII (≈4 chars/token) for a better
 * ballpark than the previous length/4 flat heuristic.
 */
export function estTok(text) {
  const str = String(text || '');
  if (!str) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // CJK Unified Ideographs + Hiragana/Katakana/Fullwidth ranges
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3040 && code <= 0x30FF) ||
        (code >= 0xFF00 && code <= 0xFFEF) ||
        (code >= 0x3400 && code <= 0x4DBF)) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/**
 * Cleanup old log files older than maxDays.
 */
export function cleanup() {
  try {
    const cutoff = Date.now() - cfg.maxDays * 86400000;
    const files = fs.readdirSync(LOG_DIR);
    for (const f of files) {
      if (!f.startsWith('vibeos-') || !f.endsWith('.ndjson')) continue;
      const fp = path.join(LOG_DIR, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        // Close cached stream if we're about to delete the active file.
        if (fp === _streamPath && _stream) {
          try { _stream.end(); } catch {}
          _stream = null;
        }
        fs.unlinkSync(fp);
      }
    }
  } catch {}
}
