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

function write(entry) {
  if (!cfg.enabled) return;
  const line = JSON.stringify(entry) + '\n';
  if (cfg.toStdout) {
    const color = entry.lvl === 'err' ? '\x1b[31m' : entry.lvl === 'warn' ? '\x1b[33m' : entry.lvl === 'perf' ? '\x1b[36m' : '\x1b[32m';
    process.stdout.write(`${color}[${entry.cat}]\x1b[0m ${line}`);
  }
  if (cfg.toFile) {
    ensureDir();
    try {
      fs.appendFileSync(logFilePath(), line);
    } catch {}
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
 * Estimate token count from text (rough heuristic: ~4 chars per token).
 */
export function estTok(text) {
  return Math.ceil(String(text || '').length / 4);
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
      if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch {}
}
