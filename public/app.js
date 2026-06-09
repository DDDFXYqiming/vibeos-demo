const APPS = {
  files: {
    appId: 'files',
    title: 'Files',
    intent: 'A Ubuntu Files/Nautilus-style file manager with folder navigation, file list, and breadcrumb path.'
  },
  browser: {
    appId: 'browser',
    title: 'Vibe Browser',
    intent: 'A web browser with address bar, search, bookmarks bar, and page content area.'
  },
  terminal: {
    appId: 'terminal',
    title: 'Terminal',
    intent: 'A Ubuntu terminal emulator with command prompt, scrollable output area, and command history.'
  },
  calculator: {
    appId: 'calculator',
    title: 'Calculator',
    intent: 'A calculator with digit buttons, operators, display, and calculation history.'
  },
  notepad: {
    appId: 'notepad',
    title: 'Text Editor',
    intent: 'A text editor with title field, editing area, save button, word count, and status bar.'
  },
  tasks: {
    appId: 'tasks',
    title: 'Tasks',
    intent: 'A task list app with add, check/uncheck, delete, and filter interactions.'
  },
  settings: {
    appId: 'settings',
    title: 'Settings',
    intent: 'A Ubuntu-style settings app showing appearance, privacy, LLM runtime, and sandbox status.'
  },
  prompt: {
    appId: 'prompt',
    title: 'Vibe Prompt',
    intent: 'An app that lets the user describe a new application and then generates it from the description.'
  },
  about: {
    appId: 'about',
    title: 'About VibeOS',
    intent: 'An about screen explaining this desktop operating system and its architecture.'
  }
};

const state = {
  config: null,
  z: 100,
  counter: 0,
  focused: null,
  windows: new Map(),
  closedSessions: new Map()
};

const el = {
  boot: document.getElementById('boot'),
  bootLog: document.getElementById('bootLog'),
  workspace: document.getElementById('workspace'),
  template: document.getElementById('windowTemplate'),
  activeTitle: document.getElementById('activeTitle'),
  providerBadge: document.getElementById('providerBadge'),
  clock: document.getElementById('clock'),
  overview: document.getElementById('overview'),
  toast: document.getElementById('toast'),
  quickPrompt: document.getElementById('quickPrompt'),
  overviewPrompt: document.getElementById('overviewPrompt')
};

boot();

async function boot() {
  logBoot('[ ok ] loading local shell');
  bindGlobalEvents();
  tickClock();
  setInterval(tickClock, 1000);

  try {
    const config = await api('/api/config');
    state.config = config;
    renderProvider(config);
    logBoot(`[ ok ] provider=${config.provider} model=${config.model}`);
    logBoot('[ ok ] iframe event bridge armed');
    logBoot('[ ok ] window manager ready');
  } catch (error) {
    logBoot(`[fail] ${error.message}`);
    toast(`Config load failed: ${error.message}`);
  }

  logBoot('[ ok ] desktop ready without startup LLM call');
  setTimeout(() => el.boot.classList.add('hidden'), 850);
}

function logBoot(line) {
  el.bootLog.textContent += `${line}\n`;
}

function renderProvider(config) {
  el.providerBadge.textContent = `${config.provider}:${config.model}`;
  el.providerBadge.classList.toggle('missing', config.mode === 'missing_key');
  el.providerBadge.classList.toggle('mock', config.provider === 'mock');
}

function tickClock() {
  const now = new Date();
  el.clock.textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', weekday: 'short' }).format(now);
}

function bindGlobalEvents() {
  document.querySelectorAll('[data-app]').forEach(btn => {
    btn.addEventListener('click', () => {
      const app = APPS[btn.dataset.app];
      if (app) openApp(app);
      hideOverview();
    });
  });

  document.getElementById('activitiesBtn').addEventListener('click', toggleOverview);
  document.getElementById('powerBtn').addEventListener('click', () => openApp(APPS.about));

  el.overview.addEventListener('click', (event) => {
    if (event.target === el.overview) hideOverview();
  });

  el.quickPrompt.addEventListener('submit', (event) => {
    event.preventDefault();
    const intent = new FormData(el.quickPrompt).get('intent')?.toString().trim();
    if (intent) openCustomApp(intent);
    el.quickPrompt.reset();
  });

  el.overviewPrompt.addEventListener('submit', (event) => {
    event.preventDefault();
    const intent = new FormData(el.overviewPrompt).get('intent')?.toString().trim();
    if (intent) openCustomApp(intent);
    el.overviewPrompt.reset();
    hideOverview();
  });

  window.addEventListener('message', handleIframeMessage);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideOverview();
    if (event.ctrlKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      showOverview();
      el.overviewPrompt.querySelector('input').focus();
    }
  });
}

function toggleOverview() { el.overview.classList.toggle('hidden'); }
function showOverview() { el.overview.classList.remove('hidden'); }
function hideOverview() { el.overview.classList.add('hidden'); }

async function openCustomApp(intent) {
  const title = titleFromIntent(intent);
  await openApp({
    appId: 'custom',
    title,
    intent: `Create a complete app from this user request: ${intent}`
  });
}

function titleFromIntent(intent) {
  const clean = intent.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return 'Vibe App';
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean;
}

async function openApp(app, geometry = {}) {
  const existing = findWindowByApp(app.appId);
  if (existing) {
    existing.element.classList.remove('minimized');
    focusWindow(existing.element);
    return;
  }
  if (await restoreClosedSession(app.appId)) return;

  const localId = `win_${++state.counter}`;
  const win = createWindow(localId, app.title, geometry);
  setLoading(win, true);
  setIframeHtml(win, loadingHtml(`Starting ${escapeHtml(app.title)} session...`), localId, app.appId);
  focusWindow(win);

  try {
    const result = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(app)
    });
    attachSessionToWindow(win, app, result);
    toast(`${result.title || app.title} ready`);
  } catch (error) {
    setIframeHtml(win, diagnosticHtml('Failed to start app', error.message), localId, app.appId);
    toast(error.message);
  } finally {
    setLoading(win, false);
  }
}

function createWindow(localId, title, geometry = {}) {
  const node = el.template.content.firstElementChild.cloneNode(true);
  node.dataset.localId = localId;
  node.querySelector('.window-title').textContent = title;

  const cascade = state.counter % 8;
  const x = geometry.x ?? (120 + cascade * 28);
  const y = geometry.y ?? (64 + cascade * 24);
  const width = geometry.width ?? defaultWidth();
  const height = geometry.height ?? defaultHeight();
  Object.assign(node.style, {
    left: `${x}px`,
    top: `${y}px`,
    width: `${width}px`,
    height: `${height}px`,
    zIndex: ++state.z
  });

  el.workspace.appendChild(node);
  bindWindowEvents(node);
  return node;
}

function defaultWidth() { return Math.min(820, Math.max(500, window.innerWidth - 180)); }
function defaultHeight() { return Math.min(590, Math.max(360, window.innerHeight - 110)); }

function bindWindowEvents(win) {
  const header = win.querySelector('.window-header');
  const close = win.querySelector('.close');
  const minimize = win.querySelector('.minimize');
  const maximize = win.querySelector('.maximize');
  const handle = win.querySelector('.resize-handle');

  win.addEventListener('pointerdown', () => focusWindow(win));
  header.addEventListener('pointerdown', (event) => startDrag(event, win));
  handle.addEventListener('pointerdown', (event) => startResize(event, win));
  close.addEventListener('click', () => closeWindow(win));
  minimize.addEventListener('click', () => minimizeWindow(win));
  maximize.addEventListener('click', () => toggleMaximize(win));
  header.addEventListener('dblclick', () => toggleMaximize(win));
}

function focusWindow(win) {
  document.querySelectorAll('.window.focused').forEach(w => w.classList.remove('focused'));
  win.classList.add('focused');
  win.style.zIndex = ++state.z;
  state.focused = win;
  el.activeTitle.textContent = win.querySelector('.window-title').textContent;
}

function closeWindow(win) {
  const sessionId = win.dataset.sessionId;
  if (sessionId) {
    const record = state.windows.get(sessionId);
    if (record) {
      record.geometry = geometryOf(win);
      record.html = win.querySelector('iframe')?.srcdoc || '';
      record.closedAt = Date.now();
      state.closedSessions.set(sessionId, record);
    }
    state.windows.delete(sessionId);
  }
  win.remove();
  el.activeTitle.textContent = 'VibeOS Desktop';
}

function minimizeWindow(win) {
  win.classList.toggle('minimized');
  if (win.classList.contains('minimized')) el.activeTitle.textContent = 'VibeOS Desktop';
  else focusWindow(win);
}

function toggleMaximize(win) {
  win.classList.toggle('maximized');
  focusWindow(win);
}

function startDrag(event, win) {
  if (event.button !== 0 || win.classList.contains('maximized')) return;
  const target = event.target;
  if (target.closest('.window-controls')) return;
  event.preventDefault();
  focusWindow(win);
  const rect = win.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  win.setPointerCapture?.(event.pointerId);

  function move(e) {
    const left = clamp(e.clientX - offsetX, 68, window.innerWidth - 120);
    const top = clamp(e.clientY - offsetY, 40, window.innerHeight - 80);
    win.style.left = `${left}px`;
    win.style.top = `${top}px`;
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

function startResize(event, win) {
  if (event.button !== 0 || win.classList.contains('maximized')) return;
  event.preventDefault();
  event.stopPropagation();
  focusWindow(win);
  const rect = win.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const startW = rect.width;
  const startH = rect.height;

  function move(e) {
    const width = clamp(startW + e.clientX - startX, 360, window.innerWidth - rect.left - 12);
    const height = clamp(startH + e.clientY - startY, 260, window.innerHeight - rect.top - 12);
    win.style.width = `${width}px`;
    win.style.height = `${height}px`;
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

function setLoading(win, loading) {
  win.querySelector('.window-spinner').classList.toggle('hidden', !loading);
}

function setIframeHtml(win, html, sessionId, appId = win.dataset.appId || '') {
  const iframe = win.querySelector('iframe');
  iframe.srcdoc = wrapIframeHtml(html, sessionId, appId);
}

function wrapIframeHtml(html, sessionId, appId = '') {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;width:100%;height:100%;overflow:auto;font-family:Ubuntu,"Segoe UI",system-ui,sans-serif;color:#241f31;background:#fff;}
  *{box-sizing:border-box}button,input,textarea,select{font:inherit}button{cursor:pointer}a{color:#77216f}
  ::selection{background:#e95420;color:white}
</style>
</head>
<body>
${html || ''}
<script>
(() => {
  const sessionId = ${JSON.stringify(sessionId)};
  const appId = ${JSON.stringify(appId)};
  const MAX_TEXT = 1200;
  const MAX_TRACE = 20;

  // ── Interaction Trace Ring Buffer ──
  const trace = [];
  function pushTrace(desc) {
    const now = new Date();
    const ts = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0') + ':' + String(now.getSeconds()).padStart(2,'0');
    trace.push('- ' + ts + ' ' + desc);
    if (trace.length > MAX_TRACE) trace.shift();
  }
  function getTrace() { return trace.slice().reverse().join('\\n'); }

  function clip(str, max) {
    str = String(str == null ? '' : str);
    return str.length > max ? str.slice(0, max) + '\\n...[clipped]' : str;
  }

  // ── Accessible Name Resolution ──
  function getAccessibleName(el) {
    if (!el) return '';
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria;
    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return (labelEl.innerText || labelEl.textContent || '').trim().slice(0, 60);
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const placeholder = el.getAttribute && el.getAttribute('placeholder');
      if (placeholder) return placeholder;
      const label = el.closest && el.closest('label');
      if (label) return (label.innerText || label.textContent || '').trim().slice(0, 60);
      if (el.id) {
        const forLabel = document.querySelector('label[for="' + el.id + '"]');
        if (forLabel) return (forLabel.innerText || forLabel.textContent || '').trim().slice(0, 60);
      }
    }
    const text = (el.innerText || el.textContent || '').trim();
    if (text && text.length <= 60) return text;
    return '';
  }

  function getRole(el) {
    if (!el) return '';
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A' && el.href) return 'link';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit') return 'button';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SUMMARY') return 'button';
    if (tag === 'LI') return 'listitem';
    if (tag === 'TR') return 'row';
    if (tag === 'LABEL') return 'label';
    return '';
  }

  // ── Element Context ──
  function getElementContext(el) {
    if (!el) return '';
    const parent = el.closest('form,table,nav,ul,ol,[role="menu"],[role="list"],[role="toolbar"],fieldset,.card,.panel,.sidebar');
    if (!parent) return '';
    if (parent.tagName === 'FORM') {
      const action = parent.getAttribute('action') || '';
      const legend = parent.querySelector('legend');
      return 'in form' + (legend ? ' "' + (legend.innerText||'').trim().slice(0,40) + '"' : '') + (action ? ' action=' + action : '');
    }
    if (parent.tagName === 'TABLE' || parent.getAttribute('role') === 'grid') {
      const row = el.closest('tr,[role="row"]');
      if (row) {
        const cells = Array.from(row.querySelectorAll('td,th,[role="gridcell"],[role="cell"]'));
        const rowText = cells.map(c => (c.innerText||'').trim()).filter(Boolean).join(' | ').slice(0, 60);
        if (rowText) return 'in row: ' + rowText;
      }
      return 'in table';
    }
    const heading = parent.querySelector('h1,h2,h3,h4,h5,h6');
    if (heading) return 'in section "' + (heading.innerText||'').trim().slice(0,40) + '"';
    return '';
  }

  function targetInfo(target) {
    if (!target) return {};
    const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : {x:0,y:0,width:0,height:0};
    const form = target.closest ? target.closest('form') : null;
    return {
      tag: target.tagName,
      id: target.id || '',
      name: target.getAttribute && target.getAttribute('name') || '',
      type: target.getAttribute && target.getAttribute('type') || '',
      role: getRole(target),
      ariaLabel: target.getAttribute && target.getAttribute('aria-label') || '',
      accessibleName: getAccessibleName(target),
      text: clip(target.innerText || target.textContent || target.value || '', 500),
      value: target.value || target.getAttribute && target.getAttribute('value') || '',
      href: target.href || '',
      classes: target.className || '',
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      formData: form ? formData(form) : {},
      allInputs: allInputs()
    };
  }
  function formData(form) {
    const out = {};
    try {
      for (const [k, v] of new FormData(form).entries()) out[k] = v;
    } catch {}
    return out;
  }
  function allInputs() {
    const out = {};
    document.querySelectorAll('input, textarea, select').forEach((input, index) => {
      const key = input.name || input.id || 'input_' + index;
      if (input.type === 'checkbox') out[key] = input.checked;
      else out[key] = input.value;
    });
    return out;
  }

  function summarizeDocument() {
    const headings = Array.from(document.querySelectorAll('h1,h2,h3')).map(h => (h.innerText || h.textContent || '').trim()).filter(Boolean).slice(0, 8);
    const controls = Array.from(document.querySelectorAll('button,a,input,textarea,select,[role=\"button\"]')).map(el => selector(el)).filter(Boolean).slice(0, 24);
    return { headings, controls };
  }

  function inferSemanticAction(eventType, target) {
    const el = target && target.closest && target.closest('[data-vibe-action],button,a,input,textarea,select,[role=\"button\"],li,tr,label');
    if (!el) return appId + '.' + eventType;
    const explicit = el.getAttribute('data-vibe-action');
    if (explicit) return explicit;
    const label = (getAccessibleName(el) || el.name || el.id || el.textContent || '').toLowerCase();
    if (appId === 'browser' && (label.includes('search') || label.includes('go') || label.includes('address'))) return 'browser.search';
    if (appId === 'tasks' && eventType === 'submit') return 'task.add';
    if (appId === 'tasks' && (el.matches('input[type=\"checkbox\"]') || label.includes('done'))) return 'task.toggle';
    if (appId === 'notepad' && (label.includes('save') || eventType === 'submit')) return 'note.save';
    if (appId === 'calculator') return 'calculator.input';
    if (label.includes('retry')) return 'recovery.retry';
    if (label.includes('simplify')) return 'recovery.simplify';
    if (label.includes('reset')) return 'recovery.reset';
    return appId + '.' + eventType;
  }

  function emit(eventType, nativeEvent, extra = {}) {
    const target = nativeEvent && nativeEvent.target;
    const info = targetInfo(target);
    parent.postMessage({
      type: 'vibeos:event',
      sessionId,
      event: {
        eventType,
        target: info,
        text: info.text,
        value: info.value,
        formData: info.formData,
        allInputs: info.allInputs,
        key: nativeEvent && nativeEvent.key || '',
        pointer: nativeEvent ? { x: nativeEvent.clientX || 0, y: nativeEvent.clientY || 0 } : {},
        documentText: clip(document.body.innerText || '', MAX_TEXT),
        documentSummary: summarizeDocument(),
        semanticAction: inferSemanticAction(eventType, target),
        viewport: { width: innerWidth, height: innerHeight },
        interactionTrace: getTrace(),
        ...extra
      }
    }, '*');
  }

  // ── Host patch bridge ──
  window.addEventListener('message', (message) => {
    const data = message.data;
    if (!data || data.type !== 'vibeos:patch' || !data.patch) return;
    const patch = data.patch;
    const target = document.querySelector(patch.selector || '');
    if (!target) return;
    if (patch.mode === 'replaceOuterHTML') target.outerHTML = patch.html || '';
    else if (patch.mode === 'appendHTML') target.insertAdjacentHTML('beforeend', patch.html || '');
    else target.innerHTML = patch.html || '';
  });

  // ── Event Listeners ──

  // Submit
  document.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = {};
    try { for (const [k,v] of new FormData(form).entries()) fd[k] = v; } catch {}
    const desc = 'submit [form] ' + JSON.stringify(fd).slice(0, 120);
    pushTrace(desc);
    emit('submit', e);
  }, true);

  // Click
  document.addEventListener('click', (e) => {
    const interactive = e.target.closest('button,a,[role="button"],summary,li,tr,.clickable,input[type="submit"],input[type="button"],label');
    if (interactive) {
      e.preventDefault();
      const role = getRole(interactive);
      const name = getAccessibleName(interactive);
      const ctx = getElementContext(interactive);
      const desc = 'click [' + role + '] "' + (name || interactive.tagName).slice(0, 40) + '"' + (ctx ? ' (' + ctx + ')' : '');
      pushTrace(desc);
      emit('click', e, { clickedSelector: selector(interactive) });
    }
  }, true);

  // Enter
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.matches('input,textarea,[contenteditable="true"]'))) {
      if (e.target.tagName !== 'TEXTAREA' || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const role = getRole(e.target);
        const name = getAccessibleName(e.target);
        const val = (e.target.value || '').slice(0, 80);
        const desc = 'enter [' + role + '] "' + (name || e.target.name || e.target.id || 'input') + '" = "' + val + '"';
        pushTrace(desc);
        emit('enter', e);
      }
    }
  }, true);

  // Change (select, checkbox, radio, range)
  document.addEventListener('change', (e) => {
    if (e.target.matches('select,input[type="checkbox"],input[type="radio"],input[type="range"]')) {
      const role = getRole(e.target);
      const name = getAccessibleName(e.target) || e.target.name || e.target.id || 'input';
      const val = e.target.type === 'checkbox' ? String(e.target.checked) : String(e.target.value || '');
      const desc = 'change [' + role + '] "' + name.slice(0, 40) + '" → "' + val.slice(0, 60) + '"';
      pushTrace(desc);
      emit('change', e);
    }
  }, true);

  // Input snapshot (debounced, for text typing awareness)
  let inputTimer = null;
  document.addEventListener('input', (e) => {
    if (!inputTimer) {
      inputTimer = setTimeout(() => {
        inputTimer = null;
        const role = getRole(e.target);
        const name = getAccessibleName(e.target) || e.target.name || e.target.id || 'input';
        const val = (e.target.value || '').slice(0, 80);
        const desc = 'type [' + role + '] "' + name.slice(0, 30) + '" = "' + val + (val.length >= 80 ? '...' : '') + '"';
        pushTrace(desc);
        parent.postMessage({
          type: 'vibeos:event',
          sessionId,
          event: {
            eventType: 'input_snapshot',
            target: targetInfo(e.target),
            allInputs: allInputs(),
            interactionTrace: getTrace(),
            documentText: clip(document.body.innerText || '', MAX_TEXT)
          }
        }, '*');
      }, 500);
    }
  }, true);

  // ── Selector (P2: ARIA role + accessible name) ──
  function selector(el) {
    if (!el) return '';
    // Priority 1: ID
    if (el.id) return '#' + el.id;
    // Priority 2: ARIA role + accessible name
    const role = getRole(el);
    const name = getAccessibleName(el);
    if (role && name) return '[' + role + '] "' + name.slice(0, 30) + '"';
    // Priority 3: name attribute
    const nameAttr = el.getAttribute('name');
    if (nameAttr) return el.tagName.toLowerCase() + '[name="' + nameAttr + '"]';
    // Priority 4: role only
    if (role) return '[' + role + '] "' + (el.innerText || el.textContent || '').trim().slice(0, 24) + '"';
    // Priority 5: classes
    const cls = (el.className || '').split(/\\s+/).filter(c => c && !c.match(/^\\d/)).slice(0, 2);
    if (cls.length) return el.tagName.toLowerCase() + '.' + cls.join('.');
    // Priority 6: text content
    const text = (el.innerText || el.textContent || '').trim().slice(0, 24);
    if (text) return el.tagName.toLowerCase() + ':contains("' + text + '")';
    // Priority 7: nth-child fallback
    const idx = Array.from(el.parentNode ? el.parentNode.children : []).indexOf(el);
    return el.tagName.toLowerCase() + ':nth-child(' + (idx + 1) + ')';
  }
})();
</script>
</body>
</html>`;
}

async function handleIframeMessage(message) {
  const data = message.data;
  if (!data || data.type !== 'vibeos:event') return;
  return enqueueSessionEvent(data.sessionId, data.event);
}

function enqueueSessionEvent(sessionId, event) {
  const record = state.windows.get(sessionId);
  if (!record) return Promise.resolve();
  record.requestSeq = (record.requestSeq || 0) + 1;
  const seq = record.requestSeq;
  record.queue = (record.queue || Promise.resolve()).then(() => sendSessionEvent(sessionId, event, seq));
  return record.queue.catch(() => {});
}

async function sendSessionEvent(sessionId, event, seq) {
  const record = state.windows.get(sessionId);
  if (!record) return;
  const win = record.element;
  focusWindow(win);
  setLoading(win, true);

  // Surface "the last patch was rejected" to the server so the model can switch
  // back to a full HTML render on this turn. Consumed once per request so the
  // hint does not stick after the model recovers.
  const payload = { ...event };
  if (record.lastPatchFailed) {
    payload.lastPatchFailed = true;
    record.lastPatchFailed = false;
  }

  try {
    const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/event`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (seq < (record.lastAppliedSeq || 0)) return;
    record.lastAppliedSeq = seq;
    if (!result.silent) {
      win.querySelector('.window-title').textContent = result.title || record.title;
      const usedPatch = Boolean(result.patch);
      const patchOk = usedPatch ? applyPatch(win, result.patch) : true;
      if (usedPatch && !patchOk) {
        // The model chose a patch but the selector did not match the live DOM.
        // Record this so the next event tells the model to render full HTML.
        record.lastPatchFailed = true;
      }
      if (!patchOk) setIframeHtml(win, result.html, sessionId, record.app?.appId);
      record.title = result.title || record.title;
    }
  } catch (error) {
    toast(error.message);
    setIframeHtml(win, diagnosticHtml('LLM event failed', error.message), sessionId, record.app?.appId);
  } finally {
    setLoading(win, false);
  }
}


function attachSessionToWindow(win, app, result) {
  win.dataset.sessionId = result.id;
  win.dataset.appId = app.appId;
  win.querySelector('.window-title').textContent = result.title || app.title;
  setIframeHtml(win, result.html, result.id, app.appId);
  state.windows.set(result.id, { element: win, app, title: result.title || app.title, requestSeq: 0, lastAppliedSeq: 0, queue: Promise.resolve() });
}

function findWindowByApp(appId) {
  for (const record of state.windows.values()) {
    if (record.app?.appId === appId) return record;
  }
  return null;
}

async function restoreClosedSession(appId) {
  const entry = Array.from(state.closedSessions.entries()).reverse().find(([, record]) => record.app?.appId === appId);
  if (!entry) return false;
  const [sessionId, record] = entry;
  state.closedSessions.delete(sessionId);
  const win = createWindow(`win_${++state.counter}`, record.title || record.app.title, record.geometry || {});
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    attachSessionToWindow(win, record.app, result);
    focusWindow(win);
    toast(`${result.title || record.title} restored`);
    return true;
  } catch {
    win.remove();
    return false;
  }
}

function geometryOf(win) {
  return {
    x: parseFloat(win.style.left) || 120,
    y: parseFloat(win.style.top) || 64,
    width: parseFloat(win.style.width) || defaultWidth(),
    height: parseFloat(win.style.height) || defaultHeight()
  };
}

function applyPatch(win, patch) {
  if (!patch || !patch.selector || !patch.html) return false;
  const iframe = win.querySelector('iframe');
  try {
    const doc = iframe?.contentDocument;
    const target = doc?.querySelector(patch.selector);
    if (target) {
      if (patch.mode === 'replaceOuterHTML') target.outerHTML = patch.html;
      else if (patch.mode === 'appendHTML') target.insertAdjacentHTML('beforeend', patch.html);
      else target.innerHTML = patch.html;
      return true;
    }
  } catch {}
  if (iframe?.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'vibeos:patch', patch }, '*');
    return true;
  }
  return false;
}

function loadingHtml(text) {
  return `<div class="loading-page"><div class="loading-card"><div class="loading-dot"></div><h1>Starting session</h1><p>${text}</p></div></div>`;
}

function diagnosticHtml(title, detail) {
  return `<main style="font-family:Ubuntu,Segoe UI,sans-serif;background:#f6f5f4;height:100%;padding:24px"><section style="background:white;border-radius:18px;padding:20px;box-shadow:0 18px 50px #0002"><h1 style="color:#c01c28">${escapeHtml(title)}</h1><pre style="white-space:pre-wrap;background:#241f31;color:#fff;border-radius:12px;padding:14px">${escapeHtml(detail)}</pre><div style="display:flex;gap:10px;margin-top:14px"><button data-vibe-action="recovery.retry">Retry</button><button data-vibe-action="recovery.simplify">Simplify UI</button><button data-vibe-action="recovery.reset">Reset App</button></div></section></main>`;
}

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!resp.ok) {
    const message = data?.message || data?.error || `${resp.status} ${resp.statusText}`;
    throw new Error(message);
  }
  return data;
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
