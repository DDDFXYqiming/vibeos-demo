const TEMPLATE_CACHE = new Map();
const LEVELS = ['off', 'low', 'medium', 'high', 'max'];

export const APP_CONTRACTS = {
  browser: {
    summary: 'Simulate a local browser UI with fictional/search-result content managed in session state.',
    allowed: ['simulate browsing', 'maintain fake history/bookmarks', 'render local generated search results'],
    forbidden: ['must not claim real network fetches', 'must not claim access to real cookies/history/passwords']
  },
  terminal: {
    summary: 'Simulate a terminal emulator transcript inside the iframe session.',
    allowed: ['render plausible command output', 'maintain command history in state'],
    forbidden: ['must not execute local commands', 'must not claim real filesystem/process access']
  },
  files: {
    summary: 'Simulate a file manager with session-only virtual folders and files.',
    allowed: ['navigate virtual folders', 'select virtual items', 'render fictional file metadata'],
    forbidden: ['must not read the real disk', 'must not claim access to private files']
  },
  tasks: {
    summary: 'Maintain a session-local task list with add/toggle/delete/filter operations.',
    allowed: ['update tasks from form and click events'],
    forbidden: ['must not claim external sync']
  },
  notepad: {
    summary: 'Maintain session-local document text and title.',
    allowed: ['edit text', 'track word count', 'simulate save inside session state'],
    forbidden: ['must not claim writing to disk']
  },
  calculator: {
    summary: 'Perform deterministic calculator updates exactly in state before rendering.',
    allowed: ['compute arithmetic exactly', 'keep calculation history'],
    forbidden: ['must not invent unavailable scientific functions unless present in UI']
  }
};

const DEFAULT_STATES = {
  browser: { currentUrl: '', query: '', bookmarks: [], history: [], pageTitle: 'Home', pageKind: 'home' },
  terminal: { history: [], cwd: '~', prompt: '$' },
  files: { path: '/home/user', selected: [], items: [] },
  tasks: { tasks: [], filter: 'all', draft: '' },
  notepad: { text: '', title: 'Untitled', saved: false, wordCount: 0 },
  calculator: { expression: '', result: '', history: [] },
  settings: { section: 'appearance', theme: 'yaru', accent: 'orange' },
  prompt: { draft: '', generatedApps: [] },
  about: { section: 'about' }
};

export function appContractText(appId = 'custom') {
  const contract = APP_CONTRACTS[appId];
  if (!contract) return 'Custom app: stay within the local iframe/session runtime. Do not claim real OS, network, file, credential, or command access.';
  return [
    `Capability contract for ${appId}: ${contract.summary}`,
    `Allowed: ${contract.allowed.join('; ')}.`,
    `Forbidden: ${contract.forbidden.join('; ')}.`
  ].join('\n');
}

export function stateSchemaText(appId = 'custom') {
  const state = DEFAULT_STATES[appId];
  if (!state) return 'State schema: choose a stable JSON object and preserve its keys across turns.';
  return `State schema for ${appId}: ${JSON.stringify(state)}`;
}

export function normalizeAppState(appId = 'custom', previous = {}, next = {}) {
  const defaults = DEFAULT_STATES[appId] || {};
  const merged = { ...defaults, ...(isPlainObject(previous) ? previous : {}), ...(isPlainObject(next) ? next : {}) };
  delete merged._liveInputs;
  if (appId === 'tasks') {
    merged.tasks = Array.isArray(merged.tasks) ? merged.tasks.map((task, index) => ({
      id: String(task.id || `task_${index + 1}`),
      text: String(task.text || task.title || ''),
      done: Boolean(task.done)
    })).filter(task => task.text) : [];
    merged.filter = ['all', 'active', 'done'].includes(merged.filter) ? merged.filter : 'all';
  }
  if (appId === 'browser') {
    merged.bookmarks = Array.isArray(merged.bookmarks) ? merged.bookmarks : [];
    merged.history = Array.isArray(merged.history) ? merged.history : [];
    merged.pageKind = ['home', 'search', 'article', 'error'].includes(merged.pageKind) ? merged.pageKind : 'home';
  }
  if (appId === 'notepad') {
    merged.text = String(merged.text || '');
    merged.title = String(merged.title || 'Untitled');
    merged.wordCount = merged.text.trim() ? merged.text.trim().split(/\s+/).length : 0;
  }
  if (appId === 'calculator') {
    merged.history = Array.isArray(merged.history) ? merged.history : [];
  }
  return merged;
}

export function getStaticAppResult(app = {}) {
  if ((app.appId || '') !== 'about') return null;
  return {
    title: app.title || 'About VibeOS',
    html: `<main class="about-app" data-vibe-app="about">
      <style>
        .about-app{height:100%;padding:28px;background:linear-gradient(135deg,#2c001e,#77216f);color:white;font-family:Ubuntu,"Segoe UI",sans-serif;}
        .about-card{max-width:720px;background:#ffffff12;border:1px solid #ffffff26;border-radius:24px;padding:26px;box-shadow:0 24px 80px #0005;}
        .about-card h1{margin:0 0 12px;font-size:34px}.about-card p{line-height:1.7;color:#f6f5f4}.about-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:18px}.about-pill{background:#ffffff18;border-radius:16px;padding:14px}.about-pill b{display:block;color:#ffb084;margin-bottom:6px}
      </style>
      <section class="about-card">
        <h1>VibeOS</h1>
        <p>Local Node.js + browser desktop shell with Ubuntu-style windows. Apps run as sandboxed iframe sessions; user events are sent to the runtime and rendered back as HTML plus JSON state.</p>
        <div class="about-grid">
          <div class="about-pill"><b>Runtime</b>Local browser shell</div>
          <div class="about-pill"><b>Apps</b>Independent iframe sessions</div>
          <div class="about-pill"><b>State</b>In-memory session JSON</div>
          <div class="about-pill"><b>Safety</b>Sandboxed UI, no local commands</div>
        </div>
      </section>
    </main>`,
    state: { section: 'about' },
    narration: 'Displayed local static About page.',
    static: true
  };
}

export function cacheKeyForApp(app = {}, provider = {}, thinkingLevel = 'off') {
  const appId = app.appId || 'custom';
  const intent = app.intent || '';
  const model = provider.model || '';
  const providerName = provider.provider || '';
  return [providerName, model, thinkingLevel, appId, hashText(intent)].join(':');
}

export function getCachedInitialResult(app = {}, provider = {}, thinkingLevel = 'off') {
  if (!isCacheableApp(app.appId)) return null;
  const cached = TEMPLATE_CACHE.get(cacheKeyForApp(app, provider, thinkingLevel));
  return cached ? cloneResult(cached) : null;
}

export function storeCachedInitialResult(app = {}, provider = {}, thinkingLevel = 'off', result = null) {
  if (!result || !isCacheableApp(app.appId)) return;
  TEMPLATE_CACHE.set(cacheKeyForApp(app, provider, thinkingLevel), cloneResult(result));
}

export function selectThinkingLevel({ appId = 'custom', eventType = 'init', configured = 'off' } = {}) {
  const max = normalizeLevel(configured);
  let desired = 'medium';
  if (['calculator', 'about'].includes(appId)) desired = 'off';
  else if (['tasks', 'notepad', 'settings', 'files'].includes(appId)) desired = eventType === 'init' ? 'low' : 'low';
  else if (appId === 'browser') desired = eventType === 'init' ? 'medium' : 'low';
  else if (appId === 'terminal') desired = 'low';
  else if (appId === 'custom') desired = ['init', 'submit'].includes(eventType) ? max : clampLevel('medium', max);
  if (eventType === 'input_snapshot') desired = 'off';
  return clampLevel(desired, max);
}

export function normalizePatch(patch, maxHtmlChars = 16000) {
  if (!isPlainObject(patch) || !patch.selector || !patch.html) return null;
  const mode = ['replaceInnerHTML', 'replaceOuterHTML', 'appendHTML'].includes(patch.mode) ? patch.mode : 'replaceInnerHTML';
  return {
    selector: String(patch.selector).slice(0, 180),
    mode,
    html: String(patch.html).slice(0, maxHtmlChars)
  };
}

function isCacheableApp(appId = '') {
  return Boolean(appId && appId !== 'custom' && appId !== 'about');
}

function normalizeLevel(level) {
  return LEVELS.includes(String(level || '').toLowerCase()) ? String(level).toLowerCase() : 'off';
}

function clampLevel(level, max) {
  return LEVELS[Math.min(LEVELS.indexOf(normalizeLevel(level)), LEVELS.indexOf(normalizeLevel(max)))];
}

function cloneResult(result) {
  return JSON.parse(JSON.stringify(result));
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function hashText(text) {
  let hash = 2166136261;
  for (const ch of String(text)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
