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
  maxFileSizeMB: 50,
  logFormat: 'ndjson', // 'ndjson' | 'pretty' | 'both'
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
let _stream = null;
let _streamPath = '';
let _bytesWritten = 0;

function getStream(targetPath) {
  if (_stream && _streamPath === targetPath) return _stream;
  if (_stream) {
    try { _stream.end(); } catch {}
    _stream = null;
    _bytesWritten = 0;
  }
  try {
    _stream = fs.createWriteStream(targetPath, { flags: 'a' });
    _stream.on('error', () => { _stream = null; });
    _streamPath = targetPath;
    // Check existing file size for rotation
    try {
      const stat = fs.statSync(targetPath);
      _bytesWritten = stat.size;
    } catch { _bytesWritten = 0; }
  } catch {
    _stream = null;
  }
  return _stream;
}

function rotateIfNeeded() {
  const maxBytes = cfg.maxFileSizeMB * 1024 * 1024;
  if (_bytesWritten > maxBytes) {
    const oldPath = _streamPath;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedPath = oldPath.replace('.ndjson', `-${ts}.ndjson`);
    try {
      if (_stream) { _stream.end(); _stream = null; }
      fs.renameSync(oldPath, rotatedPath);
      _bytesWritten = 0;
    } catch {}
  }
}

// Best-effort synchronous flush on process exit
function flushOnExit() {
  if (!_stream) return;
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

function formatPretty(entry) {
  const ts = new Date(entry.t).toISOString();
  const lvl = entry.lvl.toUpperCase().padStart(4);
  const cat = entry.cat.padStart(4);
  const rest = { ...entry };
  delete rest.t; delete rest.lvl; delete rest.cat;
  const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
  return `[${ts}] ${lvl} [${cat}]${extra}`;
}

function write(entry) {
  if (!cfg.enabled) return;
  const line = JSON.stringify(entry) + '\n';
  const pretty = formatPretty(entry) + '\n';

  if (cfg.toStdout) {
    const color = entry.lvl === 'err' ? '\x1b[31m' : entry.lvl === 'warn' ? '\x1b[33m' : entry.lvl === 'perf' ? '\x1b[36m' : '\x1b[32m';
    const out = cfg.logFormat === 'pretty' || cfg.logFormat === 'both'
      ? pretty
      : line;
    process.stdout.write(`${color}[${entry.cat}]\x1b[0m ${out}`);
  }

  if (cfg.toFile) {
    ensureDir();
    rotateIfNeeded();
    const stream = getStream(logFilePath());
    if (stream && stream.writable) {
      try {
        stream.write(line);
        _bytesWritten += Buffer.byteLength(line, 'utf8');
        return;
      } catch {}
    }
    // Fallback: sync append
    try { fs.appendFileSync(logFilePath(), line); } catch {}
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function configure(opts) {
  cfg = { ...cfg, ...opts };
}

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
 * Estimate token count from text (CJK-aware).
 */
export function estTok(text) {
  const str = String(text || '');
  if (!str) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
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
        if (fp === _streamPath && _stream) {
          try { _stream.end(); } catch {}
          _stream = null;
        }
        fs.unlinkSync(fp);
      }
    }
  } catch {}
}

/**
 * Query recent logs (in-memory + file). Returns last N lines.
 * @param {number} n - number of lines
 * @param {string} levelFilter - optional level to filter ('err'|'warn'|'info'|'perf')
 */
export function query(n = 100, levelFilter = null) {
  const results = [];
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('vibeos-') && f.endsWith('.ndjson'))
      .sort().reverse();
    for (const f of files) {
      if (results.length >= n) break;
      const fp = path.join(LOG_DIR, f);
      const lines = fs.readFileSync(fp, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines.reverse()) {
        if (results.length >= n) break;
        try {
          const entry = JSON.parse(line);
          if (!levelFilter || entry.lvl === levelFilter) {
            results.push(entry);
          }
        } catch {}
      }
    }
  } catch {}
  return results.reverse();
}

/**
 * Get log stats: total files, total size, oldest/newest.
 */
export function stats() {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('vibeos-') && f.endsWith('.ndjson'));
    let totalSize = 0;
    let oldest = Infinity;
    let newest = 0;
    for (const f of files) {
      const stat = fs.statSync(path.join(LOG_DIR, f));
      totalSize += stat.size;
      oldest = Math.min(oldest, stat.mtimeMs);
      newest = Math.max(newest, stat.mtimeMs);
    }
    return {
      files: files.length,
      totalSize,
      totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
      oldest: oldest === Infinity ? null : new Date(oldest).toISOString(),
      newest: newest === 0 ? null : new Date(newest).toISOString(),
    };
  } catch {
    return { files: 0, totalSize: 0, totalSizeMB: 0, oldest: null, newest: null };
  }
}
