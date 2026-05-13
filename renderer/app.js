// Tree IDE renderer — module-first map.
//   Default view: each top-level directory is a "module" card sized by file count.
//   Click a module → side panel shows files, gives one-click Audit + Swap actions.
//   Swap: AI plans a replacement; the diff plan is shown; accept to apply edits.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const THEME_STORAGE_KEY = 'tree-ide-theme';
function autoThemeMode() {
  const hour = new Date().getHours();
  return hour >= 7 && hour < 18 ? 'light' : 'dark';
}
function applyTheme(mode, persist = false) {
  const next = mode === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('theme-light', next === 'light');
  document.body.classList.toggle('theme-dark', next !== 'light');
  const toggle = $('#theme-toggle');
  if (toggle) {
    toggle.textContent = next === 'light' ? '☼' : '☾';
    toggle.title = next === 'light' ? 'Light theme' : 'Dark theme';
  }
  if (persist) localStorage.setItem(THEME_STORAGE_KEY, next);
  if (window.__treeGraph) window.__treeGraph.invalidate();
}
function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  applyTheme(saved || autoThemeMode());
  // If the user has not chosen manually, follow day/night while the app stays open.
  setInterval(() => {
    if (!localStorage.getItem(THEME_STORAGE_KEY)) applyTheme(autoThemeMode());
  }, 10 * 60 * 1000);
}
initTheme();

const canvas = $('#graph-canvas');
const graph = new Graph(canvas);
window.__treeGraph = graph;

const VIEW_STORAGE_KEY = 'tree-ide-view';
const RECENT_STORAGE_KEY = 'tree-ide-recents';
const MAX_RECENT_REPOS = 12;
const state = {
  root: null,
  files: [],
  graphData: null,
  selected: null,       // { kind: 'module'|'file'|'ai', ... }
  running: false,
  pendingPlan: null,    // last swap plan: { moduleKey, replacement, removed, added, body }
  view: 'graph',
  graphStale: false,
  agents: new Map(),
  primaryAgentId: null,
  activeAgentId: null,
};

const AGENT_COLORS = [
  'hsl(35, 90%, 58%)',
  'hsl(176, 72%, 46%)',
  'hsl(330, 72%, 60%)',
  'hsl(214, 74%, 60%)',
  'hsl(98, 58%, 50%)',
  'hsl(268, 68%, 64%)',
];
const EXTERNAL_WRITE_META = { agentId: '__external__', label: 'External', color: 'hsl(8, 72%, 62%)' };
const AGENT_WRITE_WINDOW_MS = 15000;

function shortTargetName(target) {
  if (!target) return '';
  const clean = String(target).replace(/^file:/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1] || clean;
}

function getRecentRepos() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(p => typeof p === 'string' && p.trim()) : [];
  } catch {
    return [];
  }
}

function saveRecentRepos(paths) {
  const seen = new Set();
  const clean = [];
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    clean.push(p);
    if (clean.length >= MAX_RECENT_REPOS) break;
  }
  localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(clean));
}

function addRecentRepo(repoPath) {
  if (!repoPath) return;
  saveRecentRepos([repoPath, ...getRecentRepos().filter(p => p !== repoPath)]);
  renderRecentRepos();
}

function clearRecentRepos() {
  localStorage.removeItem(RECENT_STORAGE_KEY);
  renderRecentRepos();
}

function renderRecentList(container, recents, { compact = false } = {}) {
  if (!container) return;
  container.innerHTML = '';
  if (!recents.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.textContent = 'No recent repos';
    container.appendChild(empty);
    return;
  }
  for (const repoPath of recents) {
    const btn = document.createElement('button');
    btn.className = 'recent-item';
    btn.title = repoPath;
    const label = document.createElement('span');
    label.className = 'recent-path';
    label.textContent = compact ? shorten(repoPath) : repoPath;
    const meta = document.createElement('span');
    meta.className = 'recent-meta';
    meta.textContent = shortTargetName(repoPath);
    btn.appendChild(label);
    btn.appendChild(meta);
    btn.addEventListener('click', () => {
      $('#recent-menu')?.classList.add('hidden');
      openRepo(repoPath);
    });
    container.appendChild(btn);
  }
}

function renderRecentRepos() {
  const recents = getRecentRepos();
  renderRecentList($('#welcome-recents'), recents);
  renderRecentList($('#recent-menu'), recents, { compact: true });
  const clear = $('#recent-clear');
  if (clear) clear.disabled = recents.length === 0;
}

// ============================================================
// Sidebar (left): list every file grouped by layer/role
// ============================================================
const LAYER_ORDER = ['interface', 'server', 'data', 'support'];
const LAYER_NAMES = { interface: 'Interface', server: 'Server', data: 'Data', support: 'Support' };
const KIND_TO_LAYER = {
  page: 'interface', layout: 'interface', template: 'interface', component: 'interface',
  hook: 'interface', styles: 'interface', loading: 'interface', error: 'interface',
  notfound: 'interface', app: 'interface', document: 'interface', default: 'interface', special: 'interface',
  service: 'server', endpoint: 'server', route: 'server', middleware: 'server', 'server-action': 'server', job: 'server',
  table: 'data', schema: 'data', model: 'data',
  infra: 'support', config: 'support', test: 'support', docs: 'support', module: 'support',
  other: 'support', external: 'support',
};

function fileDisplayLabel(f) {
  if (!f) return '';
  if (f.kind === 'route' && f.sublabel) return `${f.label} ${f.sublabel}`;
  if ((f.kind === 'page' || f.kind === 'layout' || f.kind === 'template') && f.sublabel) return f.sublabel;
  if ((f.kind === 'hook' || f.kind === 'component') && f.sublabel) return f.sublabel;
  if (f.kind === 'special' && f.sublabel) return f.sublabel;
  if (['config', 'infra', 'docs', 'schema'].includes(f.kind) && (f.sublabel || f.filename)) {
    return f.sublabel || f.filename;
  }
  if (f.kind === 'middleware') return 'middleware';
  return f.label || f.filename || f.id;
}

function renderModuleList(filter = '') {
  const list = $('#file-list');
  const frag = document.createDocumentFragment();
  const f = filter.toLowerCase();
  const hasFilter = !!f.trim();

  // group files by layer → kind → files
  const grouped = new Map();
  for (const file of graph.files.values()) {
    if (file.hidden && !hasFilter) continue;
    const text = file.searchText || `${fileDisplayLabel(file)} ${file.id} ${file.kind}`.toLowerCase();
    if (f && !text.includes(f)) continue;
    const layerId = KIND_TO_LAYER[file.kind] || 'support';
    if (!grouped.has(layerId)) grouped.set(layerId, new Map());
    const byKind = grouped.get(layerId);
    if (!byKind.has(file.kind)) byKind.set(file.kind, []);
    byKind.get(file.kind).push(file);
  }

  let count = 0;
  for (const layerId of LAYER_ORDER) {
    if (!grouped.has(layerId)) continue;
    const layerHeader = document.createElement('div');
    layerHeader.className = 'sidebar-layer';
    layerHeader.textContent = LAYER_NAMES[layerId];
    frag.appendChild(layerHeader);

    const byKind = grouped.get(layerId);
    const kinds = [...byKind.keys()].sort();
    for (const k of kinds) {
      const files = byKind.get(k).sort((a, b) => fileDisplayLabel(a).localeCompare(fileDisplayLabel(b)));
      const kindHeader = document.createElement('div');
      kindHeader.className = 'sidebar-kind';
      kindHeader.textContent = `${prettyKind(k)} · ${files.length}`;
      frag.appendChild(kindHeader);
      for (const file of files.slice(0, 100)) {
        count++;
        const row = document.createElement('div');
        row.className = 'file-node-row';
        if (state.selected && state.selected.kind === 'file' && state.selected.id === file.id) row.classList.add('selected');
        const hue = kindHue(k);
        const flags = [];
        if (file.gitStatus && file.gitStatus.dirty) flags.push(file.gitStatus.untracked ? 'G?' : 'G');
        row.innerHTML = `
          <span class="file-stripe" style="background: hsl(${hue},70%,55%)"></span>
          <span class="file-node-label">${escapeHtml(fileDisplayLabel(file))}</span>
          ${flags.length ? `<span class="file-node-flags">${flags.map(escapeHtml).join(' · ')}</span>` : ''}
        `;
        row.title = file.id;
        row.addEventListener('click', () => {
          selectFile(file.id);
          graph.panTo(file.id);
        });
        frag.appendChild(row);
      }
      if (files.length > 100) {
        const more = document.createElement('div');
        more.className = 'group-more';
        more.textContent = `… +${files.length - 100} more`;
        frag.appendChild(more);
      }
    }
  }
  list.replaceChildren(frag);
  $('#file-count').textContent = String(count);
}

let fileChromeRefreshTimer = null;
function refreshFileChrome() {
  renderKindFilter();
  renderModuleList($('#filter-input').value);
}
function scheduleFileChromeRefresh(delay = 90) {
  clearTimeout(fileChromeRefreshTimer);
  fileChromeRefreshTimer = setTimeout(() => {
    fileChromeRefreshTimer = null;
    refreshFileChrome();
  }, delay);
}

function prettyKind(k) {
  return ({
    page: 'Pages', component: 'Components', hook: 'Hooks', layout: 'Layouts',
    styles: 'Styles', loading: 'Loading', error: 'Errors', template: 'Templates',
    notfound: 'Not Found', app: 'App Shell', document: 'HTML Doc', default: 'Parallel', special: 'Special',
    service: 'Services', endpoint: 'Endpoints', route: 'API Routes', middleware: 'Middleware', 'server-action': 'Server Actions',
    job: 'Jobs', table: 'SQL Tables', schema: 'Schemas', model: 'Models', infra: 'Infra',
    config: 'Config', test: 'Tests', docs: 'Docs',
    module: 'Modules', other: 'Other', external: 'External',
  }[k]) || k;
}

function kindHue(k) {
  return ({
    page: 210, layout: 280, template: 260, component: 195, hook: 320, styles: 340,
    loading: 200, error: 0, notfound: 0, app: 215, document: 215, default: 230, special: 230,
    service: 120, endpoint: 35, route: 145, middleware: 50, 'server-action': 160, job: 55,
    table: 170, schema: 170, model: 185,
    infra: 25, config: 220, test: 35, docs: 240, module: 200, other: 220, external: 220,
  }[k]) || 220;
}

let sideFilterDebounce = null;
$('#filter-input').addEventListener('input', (e) => {
  const v = e.target.value;
  clearTimeout(sideFilterDebounce);
  sideFilterDebounce = setTimeout(() => {
    graph.setSearch(v);
    renderModuleList(v);
  }, 60);
});
$('#theme-toggle').addEventListener('click', () => {
  const next = document.body.classList.contains('theme-light') ? 'dark' : 'light';
  applyTheme(next, true);
});

// ============================================================
// Selection
// ============================================================
function selectModule() {} // legacy no-op

function selectFile(id) {
  const f = graph.files.get(id);
  if (!f) return;
  state.selected = { kind: 'file', id, label: fileDisplayLabel(f) };
  graph.selected = state.selected;
  renderFileDetail(f);
  switchTab('module');
  renderModuleList($('#filter-input').value);
}

graph.onSelect = (hit) => {
  if (!hit) {
    state.selected = null;
    renderFileDetail(null);
    return;
  }
  if (hit.kind === 'file') selectFile(hit.id);
};

// ============================================================
// Module detail panel (right)
// ============================================================
function renderFileDetail(f) {
  const pane = $('#module-detail');
  if (!f) {
    pane.innerHTML = `
      <div class="empty-state">
        <h3>Click any node on the blueprint</h3>
        <p>Each node is a real file — a Page, a Component, a Route, a Hook. Click one to see what it exports, what it depends on, and what depends on it. Hover to highlight its connections in the graph.</p>
      </div>`;
    return;
  }
  const layerId = KIND_TO_LAYER[f.kind] || 'support';
  const hue = ({ interface: 200, server: 145, data: 170, support: 220 })[layerId] || 220;
  // Compute neighbors
  const incomingEdges = [];
  const outgoingEdges = [];
  const incomingApi = [];
  const outgoingDb = [];
  const outgoingInternal = [];
  for (const e of graph.fileEdges) {
    if (e.target === f.id) incomingEdges.push(e);
    if (e.source === f.id) outgoingEdges.push(e);
    if (f.kind === 'endpoint' && e.target === f.id && e.type === 'api-call') incomingApi.push(e);
    if (f.kind === 'endpoint' && e.source === f.id && e.type === 'db-query') outgoingDb.push(e);
    if (f.kind === 'endpoint' && e.source === f.id && e.type === 'endpoint-internal') outgoingInternal.push(e);
  }
  const labelOf = (id) => {
    const ff = graph.files.get(id);
    if (!ff) return id.replace(/^ext:/, '') + ' (ext)';
    return fileDisplayLabel(ff);
  };
  const edgeKind = (e) => ({
    'api-call': e.transitive ? 'api via' : 'api call',
    'db-query': 'db query',
    'endpoint-internal': 'uses',
    fk: 'foreign key',
    import: 'import',
    external: 'external',
  }[e.type] || e.type || 'link');
  const dbOpsText = (e) => {
    const ops = e.operations || e.dbOps || [];
    const label = {
      read: 'READ',
      insert: 'INSERT',
      update: 'UPDATE',
      delete: 'DELETE',
      touch: 'TOUCH',
    };
    return ops.map(op => label[op] || String(op).toUpperCase()).join(' / ');
  };
  const edgeMeta = (e) => {
    if (e.type === 'api-call') {
      return [edgeKind(e), e.apiMethod, e.apiPath, e.via ? `via ${labelOf(e.via)}` : ''].filter(Boolean).join(' · ');
    }
    if (e.type === 'db-query') {
      return [edgeKind(e), dbOpsText(e)].filter(Boolean).join(' · ');
    }
    if (e.type === 'fk') {
      return [edgeKind(e), e.column && e.targetColumn ? `${e.column} → ${e.targetColumn}` : ''].filter(Boolean).join(' · ');
    }
    return edgeKind(e);
  };
  const edgeOrder = (e) => ({
    'api-call': 0,
    'db-query': 1,
    'endpoint-internal': 2,
    fk: 3,
    import: 4,
    external: 5,
  }[e.type] ?? 9);
  const sortEdges = (edges, dir) => edges.slice().sort((a, b) => {
    const ao = edgeOrder(a);
    const bo = edgeOrder(b);
    if (ao !== bo) return ao - bo;
    return labelOf(dir === 'out' ? a.target : a.source).localeCompare(labelOf(dir === 'out' ? b.target : b.source));
  });
  const bySource = (id, type = null) => graph.fileEdges.filter(e => e.source === id && (!type || e.type === type));
  const byTarget = (id, type = null) => graph.fileEdges.filter(e => e.target === id && (!type || e.type === type));
  const MAX_END_TO_END_PATHS = 80;
  const endToEndPaths = [];
  const seenPath = new Set();
  let endToEndOverflow = false;
  const addPath = (ids, meta = '') => {
    const clean = ids.filter(Boolean);
    if (clean.length < 2) return;
    if (endToEndPaths.length >= MAX_END_TO_END_PATHS) {
      endToEndOverflow = true;
      return;
    }
    const key = `${clean.join('>')}|${meta}`;
    if (seenPath.has(key)) return;
    seenPath.add(key);
    endToEndPaths.push({ ids: clean, meta });
  };
  const apiInto = (endpointId) => sortEdges(byTarget(endpointId, 'api-call'), 'in');
  const dbOut = (endpointId) => sortEdges(bySource(endpointId, 'db-query'), 'out');
  const internalOut = (endpointId) => sortEdges(bySource(endpointId, 'endpoint-internal'), 'out');
  const apiMeta = (e) => [e.apiMethod, e.apiPath, e.via ? `via ${labelOf(e.via)}` : ''].filter(Boolean).join(' · ');
  const gitStatusText = (s) => {
    if (!s || !s.dirty) return '';
    if (s.untracked) return 'untracked';
    if (s.deleted) return 'deleted';
    const parts = [];
    if (s.staged) parts.push('staged');
    if (s.unstaged) parts.push('unstaged');
    return parts.length ? `${parts.join(' + ')} (${String(s.code || '').trim() || 'M'})` : 'modified';
  };
  const sqlStatsText = (st) => {
    if (!st) return '';
    const parts = [
      st.read ? `reads ${st.read}` : '',
      st.write ? `writes ${st.write}` : '',
      st.insert ? `insert ${st.insert}` : '',
      st.update ? `update ${st.update}` : '',
      st.delete ? `delete ${st.delete}` : '',
      st.touch ? `touch ${st.touch}` : '',
    ].filter(Boolean);
    return parts.join(' · ');
  };

  if (f.kind === 'table') {
    for (const db of byTarget(f.id, 'db-query')) {
      if (endToEndOverflow) break;
      const callers = apiInto(db.source);
      if (callers.length) {
        for (const api of callers) {
          if (endToEndOverflow) break;
          addPath([api.source, db.source, f.id], [apiMeta(api), dbOpsText(db)].filter(Boolean).join(' · '));
        }
      } else {
        addPath([db.source, f.id], dbOpsText(db) || 'db query');
      }
    }
  } else if (f.kind === 'endpoint') {
    const callers = apiInto(f.id);
    const tables = dbOut(f.id);
    const internals = internalOut(f.id);
    if (callers.length && tables.length) {
      for (const api of callers) {
        if (endToEndOverflow) break;
        for (const db of tables) {
          if (endToEndOverflow) break;
          addPath([api.source, f.id, db.target], [apiMeta(api), dbOpsText(db)].filter(Boolean).join(' · '));
        }
      }
    } else if (callers.length) {
      for (const api of callers) {
        if (endToEndOverflow) break;
        addPath([api.source, f.id], apiMeta(api));
      }
    } else if (tables.length) {
      for (const db of tables) {
        if (endToEndOverflow) break;
        addPath([f.id, db.target], dbOpsText(db) || 'db query');
      }
    }
    if (callers.length && internals.length) {
      for (const api of callers.slice(0, 12)) {
        if (endToEndOverflow) break;
        for (const use of internals.slice(0, 4)) {
          if (endToEndOverflow) break;
          addPath([api.source, f.id, use.target], apiMeta(api));
        }
      }
    }
  } else {
    const apiOut = bySource(f.id, 'api-call');
    for (const api of apiOut) {
      if (endToEndOverflow) break;
      const tables = dbOut(api.target);
      if (tables.length) {
        for (const db of tables) {
          if (endToEndOverflow) break;
          addPath([f.id, api.target, db.target], [apiMeta(api), dbOpsText(db)].filter(Boolean).join(' · '));
        }
      } else {
        addPath([f.id, api.target], apiMeta(api));
      }
    }
    for (const use of byTarget(f.id, 'endpoint-internal')) {
      if (endToEndOverflow) break;
      const callers = apiInto(use.source);
      if (callers.length) {
        for (const api of callers) {
          if (endToEndOverflow) break;
          addPath([api.source, use.source, f.id], apiMeta(api));
        }
      } else {
        addPath([use.source, f.id], 'uses');
      }
    }
  }
  const endToEndCountLabel = `${endToEndPaths.length}${endToEndOverflow ? '+' : ''}`;
  const remainingEndToEndText = endToEndPaths.length > 24
    ? `+${endToEndPaths.length - 24}${endToEndOverflow ? ' or more' : ' more'}`
    : '';
  const pathTarget = (p) => p.ids.find(id => id !== f.id) || p.ids[p.ids.length - 1];
  const pathHtml = endToEndPaths.slice(0, 24).map(p => `
    <div class="path-row" data-target="${escapeHtml(pathTarget(p))}">
      <div class="path-chain">
        ${p.ids.map((id, idx) => `
          ${idx ? '<span class="path-arrow">→</span>' : ''}
          <span class="path-node" data-target="${escapeHtml(id)}" title="${escapeHtml(id)}">${escapeHtml(labelOf(id))}</span>
        `).join('')}
      </div>
      ${p.meta ? `<div class="path-meta">${escapeHtml(p.meta)}</div>` : ''}
    </div>
  `).join('');
  const mapSignals = [];
  const gitText = gitStatusText(f.gitStatus);
  if (gitText) mapSignals.push({ label: 'Git', value: gitText });
  if (f.kind === 'table' && f.sqlStats) mapSignals.push({ label: 'SQL', value: sqlStatsText(f.sqlStats) || 'no detected SQL access' });
  const tableDbEdges = f.kind === 'table' ? sortEdges(byTarget(f.id, 'db-query'), 'in') : [];
  const tableWriteEdges = tableDbEdges.filter(e => e.dbWrite || (e.operations || []).some(op => ['insert', 'update', 'delete'].includes(op)));
  const tableReadEdges = tableDbEdges.filter(e => e.dbRead || (e.operations || []).includes('read'));
  const normalizeDeadCall = (call) => {
    if (call && typeof call === 'object') {
      return {
        method: call.method || 'GET',
        path: call.path || '',
        owner: call.owner || '',
        reason: call.reason || 'unresolved',
        candidates: Array.isArray(call.candidates) ? call.candidates : [],
      };
    }
    const text = String(call || '');
    const [method, ...rest] = text.split(/\s+/);
    return {
      method: method || 'GET',
      path: rest.join(' ') || text,
      owner: '',
      reason: 'unresolved',
      candidates: [],
    };
  };
  const deadCalls = (f.deadApiCalls || []).map(normalizeDeadCall);
  const deadCallsHtml = deadCalls.map(call => `
    <div class="dead-call">
      <div class="dead-call-head">
        <span class="dead-method">${escapeHtml(call.method)}</span>
        <span class="dead-path">${escapeHtml(call.path)}</span>
      </div>
      <div class="dead-reason">${escapeHtml(call.reason)}${call.owner ? ` · owner ${escapeHtml(call.owner)}` : ''}</div>
      ${call.candidates.length ? `
        <div class="dead-candidates">
          ${call.candidates.map(c => `
            <button class="dead-candidate" data-target="${escapeHtml(c.file || '')}" title="${escapeHtml(c.file || '')}">
              <span>${escapeHtml(`${c.method || 'ANY'} ${c.path || ''}`)}</span>
              <span>${escapeHtml(labelOf(c.file || ''))}</span>
            </button>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `).join('');

  pane.innerHTML = `
    <div class="detail-head">
      <div class="detail-color" style="background: hsl(${hue},65%,55%)"></div>
      <div style="flex:1; min-width:0">
        <div class="detail-eyebrow">${prettyKind(f.kind)} · ${LAYER_NAMES[layerId]} layer</div>
        <div class="detail-title">${escapeHtml(fileDisplayLabel(f))}</div>
        <div class="detail-sub dim" title="${escapeHtml(f.id)}">${escapeHtml(f.id)}</div>
      </div>
    </div>
    <div class="detail-actions">
      <button class="ghost-btn" data-action="open">Open file</button>
    </div>

    ${mapSignals.length ? `
      <div class="detail-section-title">Map signals</div>
      <div class="signal-list">
        ${mapSignals.map(s => `
          <div class="signal-row">
            <span>${escapeHtml(s.label)}</span>
            <span>${escapeHtml(s.value)}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <div class="detail-section-title">Exports (${(f.exports || []).length})</div>
    <div class="export-list">
      ${(f.exports || []).slice(0, 24).map(e =>
        `<span class="export-chip ${e.kind === 'function' ? 'fn' : ''}">${escapeHtml(e.name)}${e.kind === 'function' ? '()' : ''}</span>`
      ).join('') || '<div class="dim">none detected</div>'}
    </div>

    ${deadCalls.length ? `
      <div class="detail-section-title">Dead API calls (${deadCalls.length})</div>
      <div class="dead-calls-list">
        ${deadCallsHtml}
      </div>
    ` : ''}

    ${(f.kind === 'table' && f.columns && f.columns.length) ? `
      <div class="detail-section-title">SQL columns (${f.columns.length})</div>
      <div class="column-list">
        ${f.columns.map(c => `
          <div class="column-row">
            <span class="column-name">${escapeHtml(c.name)}${c.pk ? ' PK' : ''}${c.fk ? ' FK' : ''}</span>
            <span class="column-type">${escapeHtml(c.type || '')}</span>
          </div>
        `).join('')}
      </div>

      <div class="detail-section-title">SQL access (${tableDbEdges.length})</div>
      <div class="neighbor-list">
        ${tableWriteEdges.length ? tableWriteEdges.slice(0, 18).map(e => `
          <div class="neighbor-row" data-target="${escapeHtml(e.source)}">
            <span class="dir-arrow">✎</span>
            <span>${escapeHtml(labelOf(e.source))}</span>
            <span class="connection-meta">${escapeHtml(dbOpsText(e) || 'WRITE')}</span>
          </div>
        `).join('') : ''}
        ${tableReadEdges.length ? tableReadEdges.slice(0, 18).map(e => `
          <div class="neighbor-row" data-target="${escapeHtml(e.source)}">
            <span class="dir-arrow">←</span>
            <span>${escapeHtml(labelOf(e.source))}</span>
            <span class="connection-meta">${escapeHtml(dbOpsText(e) || 'READ')}</span>
          </div>
        `).join('') : ''}
        ${(!tableWriteEdges.length && !tableReadEdges.length) ? '<div class="dim">no detected SQL readers or writers</div>' : ''}
        ${tableDbEdges.length > 36 ? `<div class="dim">+${tableDbEdges.length - 36} more</div>` : ''}
      </div>
    ` : ''}

    ${(f.kind === 'endpoint') ? `
      <div class="detail-section-title">Endpoint wiring</div>
      <div class="endpoint-summary">
        <span>UI/API callers ${incomingApi.length}</span>
        <span>DB tables ${outgoingDb.length}</span>
        <span>Backend uses ${outgoingInternal.length}</span>
      </div>

      <div class="detail-section-title">Called by (${incomingApi.length})</div>
      <div class="neighbor-list">
        ${incomingApi.length ? incomingApi.slice(0, 24).map(e => `
          <div class="neighbor-row" data-target="${escapeHtml(e.source)}">
            <span class="dir-arrow">←</span>
            <span>${escapeHtml(labelOf(e.source))}</span>
            <span class="connection-meta">${escapeHtml([e.apiMethod, e.apiPath, e.via ? `via ${labelOf(e.via)}` : ''].filter(Boolean).join(' · '))}</span>
          </div>
        `).join('') : '<div class="dim">no detected callers</div>'}
        ${incomingApi.length > 24 ? `<div class="dim">+${incomingApi.length - 24} more</div>` : ''}
      </div>

      <div class="detail-section-title">SQL access (${outgoingDb.length})</div>
      <div class="neighbor-list">
        ${outgoingDb.length ? sortEdges(outgoingDb, 'out').slice(0, 24).map(e => `
          <div class="neighbor-row" data-target="${escapeHtml(e.target)}">
            <span class="dir-arrow">→</span>
            <span>${escapeHtml(labelOf(e.target))}</span>
            <span class="connection-meta">${escapeHtml(dbOpsText(e) || 'touch')}</span>
          </div>
        `).join('') : '<div class="dim">no detected table access</div>'}
        ${outgoingDb.length > 24 ? `<div class="dim">+${outgoingDb.length - 24} more</div>` : ''}
      </div>

      <div class="detail-section-title">Uses internally (${outgoingInternal.length})</div>
      <div class="neighbor-list">
        ${outgoingInternal.length ? outgoingInternal.slice(0, 24).map(e => `
          <div class="neighbor-row" data-target="${escapeHtml(e.target)}">
            <span class="dir-arrow">→</span>
            <span>${escapeHtml(labelOf(e.target))}</span>
          </div>
        `).join('') : '<div class="dim">no detected backend imports</div>'}
        ${outgoingInternal.length > 24 ? `<div class="dim">+${outgoingInternal.length - 24} more</div>` : ''}
      </div>
    ` : ''}

    <div class="detail-section-title">End-to-end (${endToEndCountLabel})</div>
    <div class="path-list">
      ${pathHtml || '<div class="dim">no complete flow detected</div>'}
      ${remainingEndToEndText ? `<div class="dim">${remainingEndToEndText}</div>` : ''}
    </div>

    <div class="detail-section-title">Connects to (${outgoingEdges.length})</div>
    <div class="neighbor-list">
      ${outgoingEdges.length ? sortEdges(outgoingEdges, 'out').slice(0, 36).map(e => `
        <div class="neighbor-row" data-target="${escapeHtml(e.target)}">
          <span class="dir-arrow">→</span>
          <span>${escapeHtml(labelOf(e.target))}</span>
          <span class="connection-meta">${escapeHtml(edgeMeta(e))}</span>
        </div>
      `).join('') : '<div class="dim">none</div>'}
      ${outgoingEdges.length > 36 ? `<div class="dim">+${outgoingEdges.length - 36} more</div>` : ''}
    </div>

    <div class="detail-section-title">Connected from (${incomingEdges.length})</div>
    <div class="neighbor-list">
      ${incomingEdges.length ? sortEdges(incomingEdges, 'in').slice(0, 36).map(e => `
        <div class="neighbor-row" data-target="${escapeHtml(e.source)}">
          <span class="dir-arrow">←</span>
          <span>${escapeHtml(labelOf(e.source))}</span>
          <span class="connection-meta">${escapeHtml(edgeMeta(e))}</span>
        </div>
      `).join('') : '<div class="dim">none</div>'}
      ${incomingEdges.length > 36 ? `<div class="dim">+${incomingEdges.length - 36} more</div>` : ''}
    </div>
  `;

  pane.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => onFileAction(f, btn.dataset.action));
  });
  pane.querySelectorAll('.neighbor-row').forEach(row => {
    row.addEventListener('click', () => {
      const target = row.dataset.target;
      if (graph.files.get(target)) {
        selectFile(target);
        graph.panTo(target);
      }
    });
  });
  pane.querySelectorAll('.path-row').forEach(row => {
    row.addEventListener('click', () => {
      const target = row.dataset.target;
      if (graph.files.get(target)) {
        selectFile(target);
        graph.panTo(target);
      }
    });
  });
  pane.querySelectorAll('.path-node').forEach(node => {
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      const target = node.dataset.target;
      if (graph.files.get(target)) {
        selectFile(target);
        graph.panTo(target);
      }
    });
  });
  pane.querySelectorAll('.dead-candidate').forEach(btn => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const target = btn.dataset.target;
      if (graph.files.get(target)) {
        selectFile(target);
        graph.panTo(target);
      }
    });
  });

  const m = f;
}

function onFileAction(f, action) {
  const targetFile = f.parentFile || f.id;
  if (action === 'open') {
    loadFileViewer(targetFile);
    switchTab('file');
  }
}

function onModuleAction() {}

// (AI swap workflow removed — agents are real PTYs now; if you want to
// refactor, type a prompt into the active terminal tile.)

// ============================================================
// Context menu
// ============================================================
graph.onContext = (hit, x, y) => showContextMenu(hit, x, y);

function showContextMenu(hit, x, y) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  let items = [];
  if (hit.kind === 'file') {
    const id = hit.id;
    items = [
      { type: 'header', label: id },
      { label: 'Open in viewer', action: () => { switchTab('file'); loadFileViewer(id); } },
      { label: 'Reveal in sidebar',
        action: () => { selectFile(id); graph.panTo(id); } },
      { type: 'divider' },
      { label: 'Copy path', action: () => navigator.clipboard?.writeText(id).catch(() => {}) },
    ];
  } else if (hit.kind === 'ai') {
    items = [
      { type: 'header', label: 'overlay' },
      { label: 'Clear replacement overlay', action: () => { graph.setReplacement([], [], ''); } },
    ];
  }

  for (const item of items) {
    if (item.type === 'header') {
      const h = document.createElement('div');
      h.className = 'ctx-header';
      h.textContent = item.label.length > 32 ? '…' + item.label.slice(-32) : item.label;
      menu.appendChild(h);
    } else if (item.type === 'divider') {
      const d = document.createElement('div');
      d.className = 'ctx-divider';
      menu.appendChild(d);
    } else {
      const el = document.createElement('div');
      el.className = 'ctx-item';
      el.textContent = item.label;
      el.addEventListener('click', () => { hideContextMenu(); item.action && item.action(); });
      menu.appendChild(el);
    }
  }

  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 8;
  const maxY = window.innerHeight - rect.height - 8;
  menu.style.left = Math.min(x, maxX) + 'px';
  menu.style.top = Math.min(y, maxY) + 'px';
}

function hideContextMenu() { $('#context-menu').classList.add('hidden'); }
document.addEventListener('click', (e) => {
  if (!e.target.closest('#context-menu')) hideContextMenu();
});

// ============================================================
// Tabs + file viewer
// ============================================================
function refitAgents({ focus = false } = {}) {
  if (!state.agents) return;
  requestAnimationFrame(() => {
    let shouldFocus = focus;
    for (const a of state.agents.values()) {
      if (a.fitAddon) try { a.fitAddon.fit(); } catch {}
      if (shouldFocus && a.term) {
        try { a.term.focus(); } catch {}
        shouldFocus = false;
      }
    }
  });
}

function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
  if (name === 'chat' && state.agents) {
    refitAgents({ focus: true });
  }
}
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

function setWorkspaceView(view, persist = true) {
  const next = view === 'graph' ? 'graph' : 'agents';
  state.view = next;
  document.body.classList.toggle('view-agents', next === 'agents');
  document.body.classList.toggle('view-graph', next === 'graph');
  $('#agents-view-btn')?.classList.toggle('active', next === 'agents');
  $('#graph-view-btn')?.classList.toggle('active', next === 'graph');
  if (persist) localStorage.setItem(VIEW_STORAGE_KEY, next);

  if (next === 'agents') {
    graph.setPaused(true);
    switchTab('chat');
    refitAgents({ focus: true });
    return;
  }

  graph.setPaused(false);
  if ($('.tab-pane[data-pane="chat"]')?.classList.contains('active')) {
    switchTab('module');
  }
  requestAnimationFrame(() => {
    graph.refreshSize({ fit: !state.selected });
    if (state.graphStale && state.root) scheduleRescan(0);
  });
}

$('#agents-view-btn')?.addEventListener('click', () => setWorkspaceView('agents'));
$('#graph-view-btn')?.addEventListener('click', () => setWorkspaceView('graph'));

async function loadFileViewer(rel) {
  const v = $('#file-viewer');
  v.textContent = 'Loading…';
  const res = await window.tree.readFile(rel);
  v.textContent = res.error ? ('Error: ' + res.error) : (res.content || '(empty)');
}

async function syncFreshAgentsToRepo() {
  if (!state.root || !state.agents) return;
  for (const agent of state.agents.values()) {
    if (agent.provider !== 'shell' || agent.hasInput) continue;
    await respawnAgent(agent);
  }
}

// ============================================================
// Open repo
// ============================================================
async function openRepo(forcePath) {
  let p = forcePath;
  if (!p) p = await window.tree.openFolder();
  if (!p) return;
  state.root = p;
  $('#repo-name').textContent = shorten(p);
  $('#hud-status').textContent = 'Scanning…';
  $('#welcome').classList.add('hidden');
  if (window.tree.watchFs) {
    try { await window.tree.watchFs(p); } catch {}
  }

  const result = await window.tree.scanRepo(p);
  if (result.error) {
    $('#hud-status').textContent = 'Error: ' + result.error;
    return;
  }
  state.graphData = result;
  state.files = result.nodes.filter(n => n.type !== 'external');
  state.graphStale = false;
  addRecentRepo(p);
  graph.load(result);
  renderKindFilter();
  renderModuleList();
  renderFileDetail(null);
  syncFreshAgentsToRepo().catch(() => {});
  const stampEl = $('#stamp-sub');
  if (stampEl) stampEl.textContent = shorten(p);
  const mappedNodes = [...graph.files.values()].filter(f => f.kind !== 'external');
  const dirtyCount = mappedNodes.filter(f => f.gitStatus && f.gitStatus.dirty).length;
  const sqlWriteCount = mappedNodes.filter(f => f.kind === 'table' && f.sqlStats && f.sqlStats.write).length;
  const stackText = result.stackSummary && result.stackSummary.length ? ` · ${result.stackSummary.slice(0, 5).join('/')}` : '';
  $('#hud-status').textContent = `${result.fileCount} files · ${mappedNodes.length} nodes · ${graph.layers.length} layers · ${dirtyCount} dirty · ${sqlWriteCount} SQL writes${stackText}`;

}

function shorten(p) {
  if (!p) return '';
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-2).join('/');
}

$('#open-folder-btn').addEventListener('click', () => openRepo());
$('#welcome-open').addEventListener('click', () => openRepo());
$('#recent-toggle')?.addEventListener('click', (e) => {
  e.stopPropagation();
  renderRecentRepos();
  $('#recent-menu')?.classList.toggle('hidden');
});
$('#recent-clear')?.addEventListener('click', clearRecentRepos);
document.addEventListener('click', (e) => {
  if (!e.target.closest('#recent-menu') && !e.target.closest('#recent-toggle')) {
    $('#recent-menu')?.classList.add('hidden');
  }
});
window.tree.onMenuOpenFolder(() => openRepo());
if (window.tree.onOpenRoot) {
  window.tree.onOpenRoot((evt) => {
    if (evt && evt.root) openRepo(evt.root);
  });
}

window.tree.onScanProgress((evt) => {
  if (evt.status === 'scanning') $('#hud-status').textContent = 'Scanning ' + shorten(evt.root) + '…';
  else if (evt.status === 'reading') $('#hud-status').textContent = `Reading ${evt.done}/${evt.total}…`;
  else if (evt.status === 'done') $('#hud-status').textContent = `Mapped ${evt.count} files in ${evt.ms}ms`;
});

renderRecentRepos();
(async () => {
  try {
    const root = window.tree.getStartupRoot ? await window.tree.getStartupRoot() : null;
    if (root) await openRepo(root);
  } catch {}
})();

// ============================================================
// Multi-agent terminals
//
// Each agent is an xterm.js tile backed by a PTY. The focused tile becomes the
// attribution source for filesystem edits that show up as colored graph rings.
// ============================================================
let agentCounter = 0;

function newAgentId() { return 'a' + (++agentCounter); }

function setActiveAgent(agentId) {
  if (!agentId || !state.agents.has(agentId)) return;
  state.activeAgentId = agentId;
  for (const a of state.agents.values()) {
    a.dom?.tile?.classList.toggle('active', a.id === agentId);
  }
}

function fileWriteSourceMeta() {
  const agent = state.agents.get(state.activeAgentId) || state.agents.get(state.primaryAgentId);
  if (!agent) return EXTERNAL_WRITE_META;
  const now = Date.now();
  const recentAgentActivity = Math.max(agent.lastInputAt || 0, agent.lastOutputAt || 0);
  if (recentAgentActivity && now - recentAgentActivity <= AGENT_WRITE_WINDOW_MS) {
    return { agentId: agent.id, label: agent.label, color: agent.color };
  }
  return EXTERNAL_WRITE_META;
}

// Each agent tile is an embedded xterm.js terminal connected to a node-pty
// process. Provider picker chooses shell / codex / claude. There's also a
// "↗" button that re-launches the same command in your real Terminal.app
// as a fallback for TUIs that don't render correctly inside xterm.
function createAgent({ label, primary = false, provider = 'shell' } = {}) {
  const id = newAgentId();
  const grid = $('#agents-grid');
  if (!grid) return null;
  const color = AGENT_COLORS[(agentCounter - 1) % AGENT_COLORS.length];
  const tile = document.createElement('div');
  tile.className = 'agent-tile';
  tile.dataset.agentId = id;
  tile.dataset.provider = provider;
  tile.style.setProperty('--agent-color', color);
  const lbl = label || `Agent ${state.agents.size + 1}`;
  tile.innerHTML = `
    <div class="agent-head">
      <span class="agent-dot"></span>
      <div class="agent-title-stack">
        <span class="agent-name">${escapeHtml(lbl)}</span>
        <span class="agent-activity">starting…</span>
      </div>
      <select class="agent-provider" title="Provider">
        <option value="shell">SHELL</option>
        <option value="claude">CLAUDE</option>
        <option value="codex">CODEX</option>
      </select>
      <button class="agent-restart" title="Restart">⟲</button>
      <button class="agent-external" title="Open in external Terminal.app">↗</button>
      <button class="agent-close" title="Close" ${primary ? 'style="display:none"' : ''}>×</button>
    </div>
    <div class="agent-term"></div>
  `;
  grid.appendChild(tile);

  const dom = {
    tile,
    dot: tile.querySelector('.agent-dot'),
    name: tile.querySelector('.agent-name'),
    activity: tile.querySelector('.agent-activity'),
    providerSelect: tile.querySelector('.agent-provider'),
    restartBtn: tile.querySelector('.agent-restart'),
    externalBtn: tile.querySelector('.agent-external'),
    closeBtn: tile.querySelector('.agent-close'),
    termHost: tile.querySelector('.agent-term'),
  };
  dom.providerSelect.value = provider;

  const agent = {
    id, label: lbl, primary, color, provider,
    term: null, fitAddon: null, _ro: null,
    hasInput: false,
    lastInputAt: 0,
    lastOutputAt: 0,
    dom,
  };
  state.agents.set(id, agent);
  if (primary) state.primaryAgentId = id;
  if (!state.activeAgentId) setActiveAgent(id);

  bootAgentTerminal(agent);

  dom.providerSelect.addEventListener('change', async () => {
    const np = dom.providerSelect.value;
    if (np === agent.provider) return;
    agent.provider = np;
    tile.dataset.provider = np;
    await respawnAgent(agent);
  });
  dom.restartBtn.addEventListener('click', () => respawnAgent(agent));
  dom.externalBtn.addEventListener('click', async () => {
    const r = await window.tree.launchAgent({ provider: agent.provider, cwd: state.root || undefined });
    if (r && r.error) agent.dom.activity.textContent = r.error;
    else if (r && r.app) agent.dom.activity.textContent = `also running in ${r.app}`;
  });
  dom.closeBtn.addEventListener('click', async () => {
    try { await window.tree.ptyKill(id); } catch {}
    if (agent._ro) try { agent._ro.disconnect(); } catch {}
    if (agent.term) try { agent.term.dispose(); } catch {}
    state.agents.delete(id);
    tile.remove();
    if (state.activeAgentId === id) {
      state.activeAgentId = null;
      const nextId = state.agents.keys().next().value;
      if (nextId) setActiveAgent(nextId);
    }
    relayoutAgentGrid();
  });

  relayoutAgentGrid();
  return agent;
}

const XTERM_THEME = {
  background: '#000000',
  foreground: '#e7ded1',
  cursor: '#e7ded1',
  cursorAccent: '#000000',
  selectionBackground: 'rgba(231, 222, 209, 0.25)',
  black: '#1c1a17', red: '#c98a8a', green: '#9ab18d',
  yellow: '#c8b072', blue: '#8aa7c4', magenta: '#b89bb4',
  cyan: '#9bb8b6', white: '#e7ded1',
  brightBlack: '#5a5852', brightRed: '#dba5a5', brightGreen: '#b5cba8',
  brightYellow: '#dfc88c', brightBlue: '#a3c2dd', brightMagenta: '#cfb6cc',
  brightCyan: '#b6d2d0', brightWhite: '#f3ece0',
};

async function bootAgentTerminal(agent) {
  if (!window.Terminal) { agent.dom.activity.textContent = 'xterm failed to load'; return; }
  agent.dom.activity.textContent = 'starting…';

  const term = new window.Terminal({
    theme: XTERM_THEME,
    fontFamily: '"NB Akademie Mono", "Space Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    convertEol: true,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
  });
  const fitCtor = window.FitAddon && window.FitAddon.FitAddon;
  const fit = fitCtor ? new fitCtor() : null;
  if (fit) term.loadAddon(fit);
  term.open(agent.dom.termHost);
  agent.term = term;
  agent.fitAddon = fit;

  agent.dom.termHost.addEventListener('click', () => {
    setActiveAgent(agent.id);
    try { term.focus(); } catch {}
  });
  if (term.onFocus) term.onFocus(() => setActiveAgent(agent.id));
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (!agent.dom.tile.isConnected) return;
      if (fit) try { fit.fit(); } catch {}
    });
    ro.observe(agent.dom.termHost);
    agent._ro = ro;
  }

  await new Promise((r) => requestAnimationFrame(() => r()));
  if (fit) try { fit.fit(); } catch {}

  term.onData((data) => {
    if (data) {
      agent.hasInput = true;
      agent.lastInputAt = Date.now();
    }
    window.tree.ptyWrite(agent.id, data);
  });
  term.onResize(({ cols, rows }) => window.tree.ptyResize(agent.id, cols, rows));

  agent.dom.dot.classList.add('running');

  const dims = (fit && fit.proposeDimensions()) || { cols: 100, rows: 32 };
  const r = await window.tree.ptySpawn({
    agentId: agent.id,
    provider: agent.provider,
    cwd: state.root || undefined,
    cols: Math.max(20, dims.cols || 100),
    rows: Math.max(8,  dims.rows || 32),
  });
  if (r && r.error) {
    term.writeln(`\x1b[31m${r.error}\x1b[0m`);
    agent.dom.activity.textContent = 'failed';
    agent.dom.dot.classList.remove('running');
    return;
  }
  agent.dom.activity.textContent = `${agent.provider} · pid ${r.pid || ''}`;
  try { term.focus(); } catch {}
}

async function respawnAgent(agent) {
  try { await window.tree.ptyKill(agent.id); } catch {}
  if (agent.term) { try { agent.term.dispose(); } catch {} agent.term = null; }
  if (agent._ro) { try { agent._ro.disconnect(); } catch {} agent._ro = null; }
  agent.hasInput = false;
  agent.lastInputAt = 0;
  agent.lastOutputAt = 0;
  agent.dom.termHost.innerHTML = '';
  await bootAgentTerminal(agent);
}

function relayoutAgentGrid() {
  const grid = $('#agents-grid');
  if (!grid) return;
  grid.dataset.count = String(state.agents.size);
  const cEl = $('#agents-count');
  if (cEl) cEl.textContent = String(state.agents.size);
}

// Refit terminals when the tab/window shows them.
window.addEventListener('resize', () => {
  for (const a of state.agents.values()) {
    if (a.fitAddon) try { a.fitAddon.fit(); } catch {}
  }
});
function pushLog(kind, text) {
  const list = $('#log-list');
  const el = document.createElement('div');
  el.className = 'log-entry ' + kind;
  const time = new Date().toLocaleTimeString().slice(0, 8);
  el.innerHTML = `<span class="time">${time}</span>${escapeHtml(text)}`;
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
  while (list.childElementCount > 500) list.removeChild(list.firstChild);
}

// ---------- LEDGER ----------
function timeNow() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}
function pushLedger({ op, target, status = '', fileId = null }) {
  const list = $('#ledger-entries');
  if (!list) return;
  const row = document.createElement('div');
  const opLower = (op || 'op').toLowerCase();
  row.className = `ledger-row op-${opLower} ${status === 'error' ? 'status-error' : ''} ${fileId ? 'clickable' : ''}`;
  row.innerHTML = `
    <span class="col-time">${timeNow()}</span>
    <span class="col-op">${escapeHtml(op)}</span>
    <span class="col-target" title="${escapeHtml(target || '')}">${escapeHtml(target || '')}</span>
    <span class="col-status">${escapeHtml(status)}</span>
  `;
  if (fileId && graph.files.get(fileId)) {
    row.addEventListener('click', () => {
      selectFile(fileId);
      graph.panTo(fileId);
    });
  }
  list.insertBefore(row, list.firstChild);
  while (list.childElementCount > 200) list.removeChild(list.lastChild);
  const c = $('#ledger-count');
  if (c) c.textContent = `${list.childElementCount} entries`;
}
const ledgerClear = $('#ledger-clear');
if (ledgerClear) {
  ledgerClear.addEventListener('click', () => {
    const entries = $('#ledger-entries');
    const count = $('#ledger-count');
    if (entries) entries.innerHTML = '';
    if (count) count.textContent = '0 entries';
  });
}
const ledgerToggle = $('#ledger-toggle');
if (ledgerToggle) {
  ledgerToggle.addEventListener('click', () => {
    const led = $('#ledger');
    if (!led) return;
    led.classList.toggle('open');
    ledgerToggle.textContent = led.classList.contains('open') ? '▾' : '▴';
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function labelForKind(k) {
  const map = {
    page: 'Pages',
    endpoint: 'Endpoints',
    route: 'API routes',
    layout: 'Layouts',
    middleware: 'Middleware',
    'server-action': 'Server actions',
    hook: 'Hooks',
    component: 'Components',
    config: 'Config',
    test: 'Tests',
    table: 'SQL tables',
    schema: 'Schemas',
    styles: 'Styles',
    docs: 'Docs',
    module: 'Modules',
    loading: 'Loading',
    error: 'Error',
    template: 'Templates',
    app: 'App',
    document: 'Document',
    notfound: '404',
  };
  return map[k] || (k ? k[0].toUpperCase() + k.slice(1) : 'Other');
}

function ensurePrimaryAgent() {
  if (state.primaryAgentId && state.agents.has(state.primaryAgentId)) return;
  const a = createAgent({ label: 'Primary', primary: true, provider: 'shell' });
  if (!a) return;
  state.primaryAgentId = a.id;
}
ensurePrimaryAgent();

const newAgentBtn = $('#new-agent-btn');
if (newAgentBtn) {
  newAgentBtn.addEventListener('click', () => {
    createAgent({ label: `Agent ${state.agents.size + 1}`, provider: 'shell' });
  });
}
setWorkspaceView(localStorage.getItem(VIEW_STORAGE_KEY) || 'agents', false);

// ===== PTY data → write to the right xterm =====
window.tree.onPtyData(({ agentId, data }) => {
  const agent = state.agents.get(agentId);
  if (!agent || !agent.term) return;
  if (data) agent.lastOutputAt = Date.now();
  agent.term.write(data);
});
window.tree.onPtyExit(({ agentId, exitCode, signal }) => {
  const agent = state.agents.get(agentId);
  if (!agent) return;
  agent.dom.dot.classList.remove('running');
  agent.dom.activity.textContent = `exited ${exitCode != null ? `(${exitCode})` : signal ? `[${signal}]` : ''}`;
  if (agent.term) agent.term.writeln(`\r\n\x1b[2m[exited]\x1b[0m`);
});

// ===== Filesystem watcher → graph + ledger =====
// File create/delete events trigger a debounced full re-scan (cheap — ~350ms
// on real repos) so node metadata is accurate. We also do an immediate
// stub-insert / stub-remove so the change is visible right away.
let rescanTimer = null;
let rescanSeq = 0;
function scheduleRescan(delay = 600) {
  state.graphStale = true;
  clearTimeout(rescanTimer);
  const seq = ++rescanSeq;
  rescanTimer = setTimeout(async () => {
    rescanTimer = null;
    if (!state.root) return;
    const result = await window.tree.scanRepo(state.root);
    if (seq !== rescanSeq) return;
    if (result && !result.error) {
      state.graphData = result;
      state.files = result.nodes.filter(n => n.type !== 'external');
      graph.load(result);
      refreshFileChrome();
      state.graphStale = false;
    }
  }, delay);
}

function stubHintForPath(rel) {
  const name = rel.split('/').pop() || rel;
  const ext = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';
  let kind = 'module';
  if (/\.(css|scss|sass|less)$/i.test(name)) kind = 'styles';
  else if (/\.(test|spec)\.(t|j)sx?$/i.test(name) || /^test_.+\.py$/i.test(name)) kind = 'test';
  else if (/\.sql$/i.test(name) || /schema\.(ts|js|prisma|sql)$/i.test(name)) kind = 'schema';
  else if (/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock)$/i.test(name)) kind = 'config';
  else if (/dockerfile|docker-compose\.ya?ml|compose\.ya?ml/i.test(name) || /\.tf$/i.test(name)) kind = 'infra';
  return { label: name, kind, ext };
}

window.tree.onFsEvent((evt) => {
  if (evt.type === 'error') return;
  const rel = evt.path;
  if (!rel) return;
  const opMap = { add: 'CREATE', change: 'EDIT', unlink: 'DELETE' };
  const agentMeta = fileWriteSourceMeta();
  state.graphStale = true;
  if (evt.type === 'unlink') {
    // Drop the node + its edges immediately so the graph stays accurate.
    graph.removeFile(rel);
  } else if (evt.type === 'add' && !graph.files.get(rel)) {
    // Show the new file straight away; full metadata comes in on rescan.
    graph.addFileStub(rel, stubHintForPath(rel));
    graph.touch(rel, 'edit', agentMeta);
  } else if (graph.files.get(rel)) {
    graph.touch(rel, 'edit', agentMeta);
  }
  if (evt.type === 'add' || evt.type === 'unlink') scheduleRescan(160);
  else if (evt.type === 'change') scheduleRescan(900);
  scheduleFileChromeRefresh(90);
  pushLog(agentMeta.agentId === '__external__' ? 'result' : 'tool', `${agentMeta.label} ${opMap[evt.type] || evt.type.toUpperCase()} ${rel}`);
  pushLedger({
    op: opMap[evt.type] || evt.type.toUpperCase(),
    target: rel,
    status: agentMeta.label,
    fileId: graph.files.get(rel) ? rel : null,
  });
});

// ===== Resize handles for sidebars =====
{
  const root = document.documentElement;
  const saved = (k, def) => {
    const v = parseInt(localStorage.getItem(k), 10);
    return isFinite(v) && v > 80 ? v : def;
  };
  root.style.setProperty('--sidebar-w', saved('treeIde.sidebarW', 320) + 'px');
  root.style.setProperty('--right-w',   saved('treeIde.rightW',   320) + 'px');

  for (const h of document.querySelectorAll('.resize-handle')) {
    h.addEventListener('mousedown', (e) => {
      e.preventDefault();
      h.classList.add('dragging');
      const side = h.dataset.side;
      const startX = e.clientX;
      const curW = parseInt(getComputedStyle(root).getPropertyValue(
        side === 'left' ? '--sidebar-w' : '--right-w'), 10) || 240;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        let next;
        if (side === 'left') next = Math.max(160, Math.min(480, curW + dx));
        else next = Math.max(220, Math.min(640, curW - dx));
        root.style.setProperty(side === 'left' ? '--sidebar-w' : '--right-w', next + 'px');
        window.dispatchEvent(new Event('resize'));
      };
      const onUp = () => {
        h.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const v = parseInt(getComputedStyle(root).getPropertyValue(
          side === 'left' ? '--sidebar-w' : '--right-w'), 10);
        localStorage.setItem(side === 'left' ? 'treeIde.sidebarW' : 'treeIde.rightW', String(v));
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
}


// ============================================================
// Visibility filter (kind pills)
// ============================================================
const KIND_LABELS = {
  page: 'Pages', endpoint: 'Endpoints', component: 'Components', hook: 'Hooks', layout: 'Layouts',
  template: 'Templates', styles: 'Styles', loading: 'Loading', error: 'Errors',
  notfound: 'Not Found', app: 'Server', document: 'HTML', special: 'Special',
  service: 'Services', route: 'Routes', middleware: 'Middleware', 'server-action': 'Actions', job: 'Jobs',
  table: 'SQL', schema: 'Schemas', model: 'Models', infra: 'Infra',
  config: 'Config', test: 'Tests', docs: 'Docs',
  module: 'Modules', other: 'Other', external: 'Deps',
};
const FILTER_ORDER = [
  'page', 'service', 'endpoint', 'route', 'component', 'hook', 'middleware', 'server-action',
  'job', 'layout', 'template', 'special', 'table', 'schema', 'model', 'app',
  'styles', 'infra', 'config', 'test', 'docs', 'module', 'external',
];
function renderKindFilter() {
  const wrap = $('#kind-filter');
  if (!wrap) return;
  const frag = document.createDocumentFragment();
  // Count files per kind from the loaded graph
  const counts = new Map();
  for (const f of graph.files.values()) counts.set(f.kind, (counts.get(f.kind) || 0) + 1);
  for (const k of FILTER_ORDER) {
    const c = counts.get(k);
    if (!c) continue;
    const pill = document.createElement('div');
    pill.className = 'kind-pill' + (graph.visibleKinds.has(k) ? ' active' : '');
    pill.innerHTML = `${escapeHtml(KIND_LABELS[k] || k)}<span class="pill-count">${c}</span>`;
    pill.addEventListener('click', () => {
      graph.toggleKind(k);
      renderKindFilter();
      renderModuleList($('#filter-input').value);
    });
    frag.appendChild(pill);
  }
  const signals = [
    { key: 'dirty', label: 'Dirty', count: [...graph.files.values()].filter(f => f.gitStatus && f.gitStatus.dirty).length },
    { key: 'write', label: 'SQL writes', count: [...graph.files.values()].filter(f => f.kind === 'table' && f.sqlStats && f.sqlStats.write).length },
  ].filter(s => s.count);
  for (const s of signals) {
    const pill = document.createElement('div');
    pill.className = 'kind-pill signal-pill';
    pill.innerHTML = `${escapeHtml(s.label)}<span class="pill-count">${s.count}</span>`;
    pill.addEventListener('click', () => {
      const canvasSearch = $('#canvas-search');
      const sideSearch = $('#filter-input');
      if (canvasSearch) {
        canvasSearch.value = s.key;
        canvasSearch.dispatchEvent(new Event('input'));
      }
      if (sideSearch) {
        sideSearch.value = s.key;
        renderModuleList(s.key);
      }
    });
    frag.appendChild(pill);
  }
  wrap.replaceChildren(frag);
}

// ============================================================
// Search bar
// ============================================================
const searchInput = $('#canvas-search');
const searchClear = $('#search-clear');
let searchDebounce = null;
searchInput.addEventListener('input', (e) => {
  const v = e.target.value;
  searchClear.classList.toggle('hidden', !v);
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    graph.setSearch(v);
    renderModuleList(v);
  }, 60);
});
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.add('hidden');
  graph.setSearch('');
  renderModuleList($('#filter-input').value);
  searchInput.focus();
});
// Cmd/Ctrl+F focuses search
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
  if (e.key === 'Escape' && document.activeElement === searchInput) {
    searchInput.value = '';
    searchClear.classList.add('hidden');
    graph.setSearch('');
    renderModuleList($('#filter-input').value);
    searchInput.blur();
  }
});

// ============================================================
// Provider preflight — surface which CLIs are available
// ============================================================
(async () => {
  try {
    const p = await window.tree.detectProviders();
    const found = [];
    if (p.claude) found.push('claude');
    if (p.codex) found.push('codex');
    if (p.shell) found.push('shell');
    const stamp = $('#stamp-sub');
    if (stamp && !state.root) stamp.textContent = `providers: ${found.join(' · ')}`;
  } catch {}
})();
