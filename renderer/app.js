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
  usageStats: null,
  usageLoading: false,
  usageProgress: null,
  usageProgressDisplay: 0,
  fileEditor: {
    rel: null,
    original: '',
    dirty: false,
    saving: false,
    truncated: false,
  },
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
  if (f.kind === 'page' && f.sublabel) return pageDisplayLabel(f);
  if ((f.kind === 'layout' || f.kind === 'template') && f.sublabel) return routeFileDisplayLabel(f);
  if (f.kind === 'component') return componentDisplayLabel(f);
  if (f.kind === 'hook' && f.sublabel) return f.sublabel;
  if (f.kind === 'special' && f.sublabel) return f.sublabel;
  if (['config', 'infra', 'docs', 'schema'].includes(f.kind) && (f.sublabel || f.filename)) {
    return f.sublabel || f.filename;
  }
  if (f.kind === 'middleware') return 'middleware';
  return f.label || f.filename || f.id;
}

function pageDisplayLabel(f) {
  const route = f.sublabel || '';
  const role = primaryExportName(f, 'page');
  if (role && role !== 'Page') return `${role} ${route}`.trim();
  return route || f.filename || f.id;
}

function routeFileDisplayLabel(f) {
  const route = f.sublabel || '';
  const role = primaryExportName(f, f.kind) || f.label || f.kind;
  return `${role} ${route}`.trim();
}

function componentDisplayLabel(f) {
  const role = primaryExportName(f, 'component') || f.sublabel || f.filename || f.id;
  const context = componentRouteContext(f);
  return context ? `${context}/${role}` : role;
}

function primaryExportName(f, kind) {
  const skip = new Set([
    'default', 'metadata', 'viewport', 'revalidate', 'dynamic', 'runtime',
    'generateMetadata', 'generateViewport', 'generateStaticParams',
  ]);
  const names = (f.exports || [])
    .map(e => e && e.name)
    .filter(name => name && !skip.has(name) && !/Props$|Params$|Config$|Metadata$/i.test(name));
  if (!names.length) return f.sublabel || '';
  if (kind === 'page') {
    return names.find(name => /(Page|Screen|View)$/i.test(name)) || names.find(name => /^[A-Z]/.test(name)) || names[0];
  }
  return names.find(name => /^[A-Z]/.test(name)) || names[0];
}

function componentRouteContext(f) {
  const parts = String(f.id || '').split('/').slice(0, -1);
  const appIdx = parts.lastIndexOf('app');
  if (appIdx !== -1) {
    const routeParts = parts.slice(appIdx + 1)
      .filter(part => part && !/^\(.+\)$/.test(part))
      .filter(part => !['components', 'component', '_components', 'ui'].includes(part));
    if (routeParts.length) return routeParts.slice(-2).join('/');
  }
  return '';
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
        if (fileHasOpenGitChange(file)) flags.push(file.gitStatus.untracked ? 'G?' : file.gitStatus.unpushed && !file.gitStatus.dirty ? 'G↑' : 'G');
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
  graph.setFocusCompact?.(id, { fit: true });
  renderFileDetail(f);
  switchTab('module');
  renderModuleList($('#filter-input').value);
}

graph.onSelect = (hit) => {
  if (!hit) {
    state.selected = null;
    graph.clearFocusCompact?.({ fit: true });
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
  const edgeLabel = (e) => {
    if (e.type === 'import') {
      if (e.reason === 'stylesheet') return 'stylesheet';
      if (e.reason === 'script') return 'script';
      if (e.reason === 'companion-style') return 'style companion';
      if (e.reason === 'asset') return 'asset';
    }
    return edgeKind(e);
  };
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
      return [edgeLabel(e), e.apiMethod, e.apiPath, e.via ? `via ${labelOf(e.via)}` : ''].filter(Boolean).join(' · ');
    }
    if (e.type === 'db-query') {
      return [edgeLabel(e), dbOpsText(e)].filter(Boolean).join(' · ');
    }
    if (e.type === 'fk') {
      return [edgeLabel(e), e.column && e.targetColumn ? `${e.column} → ${e.targetColumn}` : ''].filter(Boolean).join(' · ');
    }
    return edgeLabel(e);
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
    if (!s || (!s.dirty && !s.unpushed)) return '';
    if (s.unpushed && !s.dirty) return 'unpushed';
    if (s.untracked) return 'untracked';
    if (s.deleted) return 'deleted';
    const parts = [];
    if (s.staged) parts.push('staged');
    if (s.unstaged) parts.push('unstaged');
    if (s.unpushed) parts.push('unpushed');
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
  if (f.kind === 'page' && f.sublabel) {
    mapSignals.push({ label: 'Route', value: f.sublabel });
    const role = primaryExportName(f, 'page');
    if (role) mapSignals.push({ label: 'Page', value: role });
  } else if (f.kind === 'component') {
    const role = primaryExportName(f, 'component') || f.sublabel;
    if (role) mapSignals.push({ label: 'Component', value: role });
    const context = componentRouteContext(f);
    if (context) mapSignals.push({ label: 'Context', value: context });
  } else if ((f.kind === 'layout' || f.kind === 'template') && f.sublabel) {
    mapSignals.push({ label: 'Route', value: f.sublabel });
  }
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
      <button class="ghost-btn" data-action="open">View code</button>
      <button class="ghost-btn" data-action="edit">Edit code</button>
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
  if (action === 'open' || action === 'edit') {
    loadFileViewer(targetFile, { focus: action === 'edit' });
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
      { label: 'View code', action: () => { switchTab('file'); loadFileViewer(id); } },
      { label: 'Edit code', action: () => { switchTab('file'); loadFileViewer(id, { focus: true }); } },
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
  if (name === 'usage') {
    renderUsagePane();
    refreshUsage().catch(() => {});
  }
}
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

function renderUsagePane() {
  const content = $('#usage-content');
  const stamp = $('#usage-stamp');
  if (!content) return;
  const usage = state.usageStats;
  if (stamp) {
    if (state.usageLoading) {
      const pct = Math.round(state.usageProgress?.pct || 0);
      stamp.textContent = pct ? `refreshing ${pct}%` : 'refreshing';
    }
    else if (!usage) stamp.textContent = 'waiting';
    else stamp.textContent = usage.stale ? 'stale' : (usage.status || 'ready');
  }
  const loadingBar = state.usageLoading ? renderUsageLoading(state.usageProgress) : '';
  if (!usage) {
    content.innerHTML = state.usageLoading
      ? loadingBar + renderUsageSkeleton()
      : '<div class="usage-empty">No usage snapshot yet.</div>';
    return;
  }
  const providers = [usage.providers?.codex, usage.providers?.claude].filter(Boolean);
  content.innerHTML = `
    ${loadingBar}
    <div class="usage-grid">
      ${providers.map(renderUsageProvider).join('')}
    </div>
    ${renderUsageStats(usage.stats)}
  `;
}

// The first snapshot can take ~50s (it captures live Claude + Codex limits via
// their CLIs), so show real per-stage progress streamed from the backend rather
// than a bare spinner.
function renderUsageLoading(progress) {
  const pct = usageDisplayPct();
  const label = progress?.label || 'Reading Codex and Claude usage…';
  return `
    <div class="usage-loading" role="status" aria-live="polite">
      <div class="usage-loading-row">
        <span class="usage-spinner" aria-hidden="true"></span>
        <span class="usage-loading-label">${escapeHtml(label)}</span>
        <span class="usage-loading-pct">${pct}%</span>
      </div>
      <div class="usage-progress"><div class="usage-progress-fill" style="width:${pct}%"></div></div>
      <div class="usage-loading-hint">First read can take up to a minute while it captures live Claude &amp; Codex limits.</div>
    </div>
  `;
}

function usageDisplayPct() {
  return Math.max(4, Math.min(100, Math.round(state.usageProgressDisplay || 0)));
}

// Stage events arrive sparsely (the Claude capture alone is a ~25s gap), so we
// ease the bar upward between them toward — but never reaching — the next
// stage, so it always looks like it's making headway. Real stage events snap
// the floor up; completion jumps it to 100.
let usageProgressTimer = null;
function startUsageProgressAnim() {
  stopUsageProgressAnim();
  usageProgressTimer = setInterval(() => {
    const target = Number(state.usageProgress?.pct) || 8;
    const ceil = Math.min(96, target + 14);
    const cur = state.usageProgressDisplay || 0;
    state.usageProgressDisplay = cur + (ceil - cur) * 0.06;
    paintUsageProgress();
  }, 200);
}
function stopUsageProgressAnim() {
  if (usageProgressTimer) { clearInterval(usageProgressTimer); usageProgressTimer = null; }
}
function paintUsageProgress() {
  const fill = $('#usage-content .usage-progress-fill');
  const pctEl = $('#usage-content .usage-loading-pct');
  const stamp = $('#usage-stamp');
  const pct = usageDisplayPct();
  if (fill) fill.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (stamp && state.usageLoading) stamp.textContent = `refreshing ${pct}%`;
}

function renderUsageSkeleton() {
  return `
    <div class="usage-grid">
      ${[0, 1].map(() => `
        <section class="usage-provider usage-skeleton" aria-hidden="true">
          <div class="usage-skel-line w40"></div>
          <div class="usage-skel-bar"></div>
          <div class="usage-skel-bar"></div>
          <div class="usage-skel-line w70"></div>
        </section>
      `).join('')}
    </div>
  `;
}

function renderUsageProvider(provider) {
  const color = provider.key === 'claude' ? 'hsl(35, 32%, 74%)' : 'hsl(145, 22%, 72%)';
  const stateName = provider.source?.state || provider.state || 'unknown';
  const oneHour = provider.headroom?.oneHour || {};
  const active = provider.headroom?.active ?? 0;
  const weeklyReset = provider.windows?.weekly?.resetIso ? shortDateTime(provider.windows.weekly.resetIso) : provider.windows?.weekly?.resetText;
  const fiveReset = provider.windows?.fiveHour?.resetIso ? shortDateTime(provider.windows.fiveHour.resetIso) : provider.windows?.fiveHour?.resetText;
  const advice = usageAdvice(provider);
  return `
    <section class="usage-provider" data-state="${escapeHtml(stateName)}" style="--provider-color:${color}">
      <div class="usage-provider-head">
        <span class="usage-provider-name">${escapeHtml(provider.label || provider.key)}</span>
        <span class="usage-provider-state">${escapeHtml(stateName)}</span>
      </div>
      <div class="usage-provider-body">
        ${renderUsageMeter('weekly', provider.quota?.weeklyUsedPercent, provider.quota?.weeklyRemainingPercent, weeklyReset)}
        ${renderUsageMeter('5h', provider.quota?.fiveHourUsedPercent, provider.quota?.fiveHourRemainingPercent, fiveReset)}
        <div class="usage-advice ${stateClass(advice.state)}">
          <span class="usage-advice-label">${escapeHtml(advice.label)}</span>
          <span class="usage-advice-text">${escapeHtml(advice.text)}</span>
        </div>
        <div class="usage-capacity">
          <div class="usage-capacity-item">
            <span class="usage-capacity-label">running now</span>
            <span class="usage-capacity-value">${active}</span>
          </div>
          <div class="usage-capacity-item">
            <span class="usage-capacity-label">add now</span>
            <span class="usage-capacity-value ${stateClass(advice.state)}">${escapeHtml(advice.addText)}</span>
          </div>
          <div class="usage-capacity-item">
            <span class="usage-capacity-label">best for</span>
            <span class="usage-capacity-value">${escapeHtml(advice.bestFor)}</span>
          </div>
          <div class="usage-capacity-item">
            <span class="usage-capacity-label">closest limit</span>
            <span class="usage-capacity-value">${escapeHtml(advice.watch)}</span>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderUsageStats(stats) {
  const daily = Array.isArray(stats?.daily) ? stats.daily : [];
  if (!daily.length) return '';
  const last7 = stats.last7 || {};
  const last28 = stats.last28 || {};
  const peak = stats.peakDay || {};
  const bars = daily.slice(-28);
  const max = Math.max(1, Number(stats.maxDailyTokens) || 1, ...bars.map(row => Number(row.totalTokens) || 0));
  const heatBlanks = Array.from({ length: Number(daily[0]?.weekday) || 0 });
  return `
    <section class="usage-charts">
      <div class="usage-chart-head">
        <span>Usage Stats</span>
        <span class="dim">Codex + Claude</span>
      </div>
      <div class="usage-stat-grid">
        ${renderUsageStat('last 7 days', formatUsageTokens(last7.totalTokens), usageSplitText(last7))}
        ${renderUsageStat('last 28 days', formatUsageTokens(last28.totalTokens), usageSplitText(last28))}
        ${renderUsageStat('peak day', peak.date ? formatUsageTokens(peak.totalTokens) : 'none', peak.date ? `${escapeHtml(peak.label || peak.date)}` : 'no usage')}
      </div>
      <div class="usage-chart-row">
        <div class="usage-chart-box">
          <div class="usage-chart-label">
            <span>activity</span>
            <span>56 days</span>
          </div>
          <div class="usage-heatmap" aria-label="56 day usage heatmap">
            ${heatBlanks.map(() => '<span class="usage-heat-cell empty"></span>').join('')}
            ${daily.map(row => `
              <span class="usage-heat-cell level-${Math.max(0, Math.min(4, Number(row.intensity) || 0))}"
                title="${escapeHtml(`${row.label}: ${formatUsageTokens(row.totalTokens)} total`)}"></span>
            `).join('')}
          </div>
        </div>
        <div class="usage-chart-box">
          <div class="usage-chart-label">
            <span>daily split</span>
            <span>28 days</span>
          </div>
          <div class="usage-bars" aria-label="28 day Codex and Claude usage">
            ${bars.map(row => renderUsageBar(row, max)).join('')}
          </div>
          <div class="usage-legend">
            <span><i class="legend-codex"></i>Codex</span>
            <span><i class="legend-claude"></i>Claude</span>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderUsageStat(label, value, meta) {
  return `
    <div class="usage-stat">
      <span class="usage-stat-label">${escapeHtml(label)}</span>
      <span class="usage-stat-value">${escapeHtml(value)}</span>
      <span class="usage-stat-meta">${escapeHtml(meta || '')}</span>
    </div>
  `;
}

function renderUsageBar(row, max) {
  const total = Number(row.totalTokens) || 0;
  const codex = Number(row.codexTokens) || 0;
  const claude = Number(row.claudeTokens) || 0;
  const codexPct = total > 0 ? Math.max(2, (codex / max) * 100) : 0;
  const claudePct = total > 0 ? Math.max(2, (claude / max) * 100) : 0;
  return `
    <div class="usage-bar-wrap" title="${escapeHtml(`${row.label}: ${formatUsageTokens(total)} total · Codex ${formatUsageTokens(codex)} · Claude ${formatUsageTokens(claude)}`)}">
      <div class="usage-bar">
        ${codex ? `<span class="usage-bar-fill codex" style="height:${codexPct}%"></span>` : ''}
        ${claude ? `<span class="usage-bar-fill claude" style="height:${claudePct}%"></span>` : ''}
      </div>
    </div>
  `;
}

function renderUsageMeter(label, used, remaining, reset) {
  const usedLabel = formatPct(used);
  const remainingLabel = remaining == null ? 'unknown' : `${formatPct(remaining)} left`;
  const width = clampPercent(used);
  return `
    <div class="usage-meter">
      <div class="usage-meter-label">
        <span>${escapeHtml(label)} · ${usedLabel}</span>
        <span>${escapeHtml(remainingLabel)}${reset ? ` · ${escapeHtml(reset)}` : ''}</span>
      </div>
      <div class="usage-meter-track"><span class="usage-meter-fill" style="--value:${width}%"></span></div>
    </div>
  `;
}

function usageAdvice(provider) {
  const label = provider.label || provider.key || 'Provider';
  const active = Number(provider.headroom?.active || 0);
  const oneHour = provider.headroom?.oneHour || {};
  const under80 = Number(oneHour.watchAgents);
  const under95 = Number(oneHour.hardAgents);
  const add80 = Number.isFinite(under80) ? Math.max(0, under80 - active) : null;
  const add95 = Number.isFinite(under95) ? Math.max(0, under95 - active) : null;
  const closest = closestLimitLabel(provider);

  if (provider.source?.state === 'missing' || provider.source?.state === 'error') {
    return {
      state: 'error',
      label: 'No live guidance',
      text: `Refresh TokenMax before deciding how much ${label} work to start.`,
      addText: 'unknown',
      bestFor: 'wait',
      watch: closest,
    };
  }

  if (add95 !== null && add95 <= 0) {
    return {
      state: 'limit',
      label: 'Hold off',
      text: `Do not start more ${label} agents. Let current work finish or wait for the next reset.`,
      addText: 'none',
      bestFor: 'finishing',
      watch: closest,
    };
  }

  if (add80 !== null && add80 <= 0) {
    return {
      state: 'watch',
      label: 'Use lightly',
      text: `Keep ${label} to the agents already running. New parallel work pushes into the caution zone.`,
      addText: 'none',
      bestFor: 'small fixes',
      watch: closest,
    };
  }

  if (add80 !== null && add80 <= 2) {
    return {
      state: 'watch',
      label: 'Use lightly',
      text: `Add ${agentPhrase(add80)} for short tasks, then check this page again.`,
      addText: `+${add80}`,
      bestFor: 'short tasks',
      watch: closest,
    };
  }

  if (add80 !== null && add80 <= 5) {
    return {
      state: 'ok',
      label: 'Use normally',
      text: `Good for regular work. Keep big parallel runs under ${under80} total ${label} agents for the next hour.`,
      addText: `+${add80}`,
      bestFor: 'normal work',
      watch: closest,
    };
  }

  if (add80 !== null) {
    return {
      state: 'ok',
      label: 'Use heavily',
      text: `Good for parallel work right now. You have room to add ${agentPhrase(add80)} for about an hour.`,
      addText: `+${add80}`,
      bestFor: 'parallel work',
      watch: closest,
    };
  }

  return {
    state: 'unknown',
    label: 'Not enough signal',
    text: `Live limits are present, but Tree cannot estimate ${label} agent room yet.`,
    addText: 'unknown',
    bestFor: 'manual call',
    watch: closest,
  };
}

function closestLimitLabel(provider) {
  const limiting = provider.headroom?.limitingWindow || 'unknown';
  const weekly = formatPct(provider.quota?.weeklyUsedPercent);
  const five = formatPct(provider.quota?.fiveHourUsedPercent);
  if (limiting === '5h') return `${five} in 5h`;
  if (limiting === 'weekly') return `${weekly} this week`;
  return `5h ${five} / week ${weekly}`;
}

function agentPhrase(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return `${n} more ${n === 1 ? 'agent' : 'agents'}`;
}

async function refreshUsage({ force = false } = {}) {
  if (!window.tree?.getUsage || state.usageLoading) return;
  state.usageLoading = true;
  state.usageProgress = null;
  state.usageProgressDisplay = 6;
  renderUsagePane();
  startUsageProgressAnim();
  try {
    state.usageStats = force && window.tree.refreshUsage
      ? await window.tree.refreshUsage({ range: '7d' })
      : await window.tree.getUsage({ range: '7d' });
  } catch (e) {
    state.usageStats = {
      ok: false,
      status: 'error',
      error: e.message || String(e),
      generatedAt: new Date().toISOString(),
      providers: {},
    };
  } finally {
    stopUsageProgressAnim();
    state.usageLoading = false;
    state.usageProgress = null;
    state.usageProgressDisplay = 0;
    renderUsagePane();
  }
}

function formatPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}%` : 'unknown';
}
function formatRate(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(n >= 10 ? 0 : 1)}%/h` : 'unknown';
}
function formatUsageTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
function usageSplitText(row) {
  const codex = Number(row?.codexTokens) || 0;
  const claude = Number(row?.claudeTokens) || 0;
  const total = codex + claude;
  if (!total) return 'no usage';
  return `Codex ${Math.round((codex / total) * 100)}% · Claude ${Math.round((claude / total) * 100)}%`;
}
function clampPercent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}
function shortDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
function stateClass(name) {
  const stateName = String(name || 'unknown');
  if (stateName === 'ok') return 'usage-state-ok';
  if (stateName === 'watch' || stateName === 'partial' || stateName === 'stale') return 'usage-state-watch';
  if (stateName === 'limit' || stateName === 'error' || stateName === 'missing') return 'usage-state-error';
  return 'usage-state-unknown';
}

function setWorkspaceView(view, persist = true) {
  const next = view === 'graph' ? 'graph' : view === 'usage' ? 'usage' : 'agents';
  state.view = next;
  document.body.classList.toggle('view-agents', next === 'agents');
  document.body.classList.toggle('view-usage', next === 'usage');
  document.body.classList.toggle('view-graph', next === 'graph');
  $('#agents-view-btn')?.classList.toggle('active', next === 'agents');
  $('#usage-view-btn')?.classList.toggle('active', next === 'usage');
  $('#graph-view-btn')?.classList.toggle('active', next === 'graph');
  if (persist) localStorage.setItem(VIEW_STORAGE_KEY, next);

  if (next === 'agents') {
    graph.setPaused(true);
    switchTab('chat');
    refitAgents({ focus: true });
    return;
  }

  if (next === 'usage') {
    graph.setPaused(true);
    switchTab('usage');
    refreshUsage().catch(() => {});
    return;
  }

  graph.setPaused(false);
  if ($('.tab-pane[data-pane="chat"]')?.classList.contains('active') ||
      $('.tab-pane[data-pane="usage"]')?.classList.contains('active')) {
    switchTab('module');
  }
  requestAnimationFrame(() => {
    graph.refreshSize({ fit: !state.selected });
    if (state.root && (state.graphStale || state.files.some(fileHasOpenGitChange))) scheduleRescan(0);
  });
}

$('#agents-view-btn')?.addEventListener('click', () => setWorkspaceView('agents'));
$('#usage-view-btn')?.addEventListener('click', () => setWorkspaceView('usage'));
$('#graph-view-btn')?.addEventListener('click', () => setWorkspaceView('graph'));
$('#usage-refresh')?.addEventListener('click', () => refreshUsage({ force: true }).catch(() => {}));

function formatFileBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
}

function editorModeLabel(rel) {
  const ext = (rel.split('.').pop() || '').toLowerCase();
  const labels = {
    js: 'JavaScript',
    jsx: 'React',
    ts: 'TypeScript',
    tsx: 'React TS',
    css: 'CSS',
    html: 'HTML',
    json: 'JSON',
    md: 'Markdown',
    py: 'Python',
    rb: 'Ruby',
    go: 'Go',
    rs: 'Rust',
    java: 'Java',
    kt: 'Kotlin',
    swift: 'Swift',
    sql: 'SQL',
    yml: 'YAML',
    yaml: 'YAML',
    toml: 'TOML',
    sh: 'Shell',
    zsh: 'Shell',
  };
  return labels[ext] || 'Text';
}

function renderFileEditorShell(rel, opts = {}) {
  const {
    status = 'Loading...',
    content = '',
    disabled = true,
    truncated = false,
    size = 0,
    error = '',
  } = opts;
  const v = $('#file-viewer');
  const mode = rel ? editorModeLabel(rel) : 'Text';
  v.innerHTML = `
    <div class="file-editor">
      <div class="file-editor-toolbar">
        <div class="file-editor-title">
          <div class="file-editor-name">${rel ? escapeHtml(shorten(rel, 54)) : 'No file selected'}</div>
          <div class="file-editor-meta">
            <span>${escapeHtml(mode)}</span>
            ${size ? `<span>${escapeHtml(formatFileBytes(size))}</span>` : ''}
            <span id="file-editor-status">${escapeHtml(status)}</span>
          </div>
        </div>
        <div class="file-editor-actions">
          <button class="ghost-btn compact" id="file-editor-reload" ${rel ? '' : 'disabled'}>Reload</button>
          <button class="ghost-btn compact" id="file-editor-revert" disabled>Revert</button>
          <button class="ghost-btn compact" id="file-editor-save" disabled>Save</button>
        </div>
      </div>
      ${error ? `<div class="file-editor-error">${escapeHtml(error)}</div>` : ''}
      ${truncated ? `<div class="file-editor-warning">This file is larger than the editor limit, so it is shown read-only to avoid saving partial content.</div>` : ''}
      <textarea
        id="file-editor-text"
        class="file-editor-text"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        ${disabled ? 'disabled' : ''}
      ></textarea>
    </div>
  `;
  const text = $('#file-editor-text');
  if (text) text.value = content;
  wireFileEditorControls();
}

function setFileEditorStatus(text, tone = '') {
  const el = $('#file-editor-status');
  if (!el) return;
  el.textContent = text;
  el.className = tone ? `file-editor-status ${tone}` : 'file-editor-status';
}

function syncFileEditorButtons(opts = {}) {
  const editor = state.fileEditor;
  const text = $('#file-editor-text');
  const canEdit = Boolean(editor.rel && text && !text.disabled && !editor.truncated);
  const dirty = canEdit && text.value !== editor.original;
  editor.dirty = dirty;
  const save = $('#file-editor-save');
  const revert = $('#file-editor-revert');
  const reload = $('#file-editor-reload');
  if (save) save.disabled = !dirty || editor.saving;
  if (revert) revert.disabled = !dirty || editor.saving;
  if (reload) reload.disabled = !editor.rel || editor.saving;
  if (opts.preserveStatus) return;
  if (editor.saving) {
    setFileEditorStatus('saving...');
  } else if (dirty) {
    setFileEditorStatus('unsaved', 'dirty');
  } else if (editor.rel && !editor.truncated) {
    setFileEditorStatus('saved');
  }
}

function wireFileEditorControls() {
  const text = $('#file-editor-text');
  const save = $('#file-editor-save');
  const revert = $('#file-editor-revert');
  const reload = $('#file-editor-reload');
  if (text) {
    text.addEventListener('input', syncFileEditorButtons);
    text.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveFileEditor();
      }
    });
  }
  save?.addEventListener('click', saveFileEditor);
  revert?.addEventListener('click', () => {
    if (!text) return;
    text.value = state.fileEditor.original;
    syncFileEditorButtons();
    text.focus();
  });
  reload?.addEventListener('click', () => {
    if (state.fileEditor.rel) loadFileViewer(state.fileEditor.rel, { force: true });
  });
}

async function saveFileEditor() {
  const editor = state.fileEditor;
  const text = $('#file-editor-text');
  if (!editor.rel || !text || text.disabled || editor.truncated || editor.saving) return;
  const content = text.value;
  editor.saving = true;
  $$('.file-editor-error').forEach(el => el.remove());
  syncFileEditorButtons();
  const res = await window.tree.writeFile(editor.rel, content);
  editor.saving = false;
  if (res.error) {
    setFileEditorStatus('save failed', 'error');
    const error = $('.file-editor-error');
    if (error) error.textContent = res.error;
    else $('.file-editor')?.insertAdjacentHTML('afterbegin', `<div class="file-editor-error">${escapeHtml(res.error)}</div>`);
    syncFileEditorButtons({ preserveStatus: true });
    return;
  }
  editor.original = content;
  editor.dirty = false;
  $$('.file-editor-error').forEach(el => el.remove());
  setFileEditorStatus(`saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  syncFileEditorButtons({ preserveStatus: true });
}

async function loadFileViewer(rel, opts = {}) {
  if (!rel) return;
  if (!opts.force && state.fileEditor.dirty && state.fileEditor.rel && state.fileEditor.rel !== rel) {
    const discard = window.confirm(`${state.fileEditor.rel} has unsaved edits. Discard them and open ${rel}?`);
    if (!discard) return;
  }

  state.fileEditor = {
    rel,
    original: '',
    dirty: false,
    saving: false,
    truncated: false,
  };
  renderFileEditorShell(rel, { status: 'Loading...' });
  const res = await window.tree.readFile(rel, { maxChars: 1_500_000 });
  if (state.fileEditor.rel !== rel) return;
  if (res.error) {
    renderFileEditorShell(rel, {
      status: 'error',
      error: res.error,
      disabled: true,
    });
    return;
  }
  state.fileEditor.original = res.content || '';
  state.fileEditor.truncated = Boolean(res.truncated);
  renderFileEditorShell(rel, {
    status: res.truncated ? 'read-only' : 'saved',
    content: res.content || '',
    disabled: Boolean(res.truncated),
    truncated: Boolean(res.truncated),
    size: res.size,
  });
  if (opts.focus && !res.truncated) $('#file-editor-text')?.focus();
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
  refreshUsage().catch(() => {});
  const stampEl = $('#stamp-sub');
  if (stampEl) stampEl.textContent = shorten(p);
  const mappedNodes = [...graph.files.values()].filter(f => f.kind !== 'external');
  const pendingCount = mappedNodes.filter(fileHasOpenGitChange).length;
  const sqlWriteCount = mappedNodes.filter(f => f.kind === 'table' && f.sqlStats && f.sqlStats.write).length;
  const stackText = result.stackSummary && result.stackSummary.length ? ` · ${result.stackSummary.slice(0, 5).join('/')}` : '';
  $('#hud-status').textContent = `${result.fileCount} files · ${mappedNodes.length} nodes · ${graph.layers.length} layers · ${pendingCount} pending · ${sqlWriteCount} SQL writes${stackText}`;

}

function shorten(p) {
  if (!p) return '';
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-2).join('/');
}

function fileHasOpenGitChange(file) {
  const s = file && file.gitStatus;
  return !!(s && (s.dirty || s.unpushed));
}

$('#open-folder-btn').addEventListener('click', () => openRepo());
$('#welcome-open').addEventListener('click', () => openRepo());

// ============================================================
// Toast notifications — visible error surface so problems don't
// look like a silent freeze. window.treeNotify is also called from
// graph.js + transport.js when they catch errors of their own.
// ============================================================
const TOAST_DEFAULT_MS = 6500;
let lastToastKey = '';
let lastToastAt  = 0;
function showToast(msg, level = 'info', durationMs = TOAST_DEFAULT_MS) {
  const stack = document.getElementById('toast-stack');
  if (!stack || !msg) return;
  // Coalesce identical bursts (e.g. resize errors firing every frame).
  const key = level + '|' + msg;
  const now = Date.now();
  if (key === lastToastKey && now - lastToastAt < 1500) return;
  lastToastKey = key; lastToastAt = now;

  const el = document.createElement('div');
  el.className = 'toast toast-' + (['error','warn','info'].includes(level) ? level : 'info');
  el.textContent = String(msg);
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => dismiss());
  el.appendChild(close);
  stack.appendChild(el);

  let removed = false;
  const dismiss = () => {
    if (removed) return;
    removed = true;
    el.classList.add('toast-fade');
    setTimeout(() => { try { el.remove(); } catch {} }, 260);
  };
  if (durationMs > 0) setTimeout(dismiss, durationMs);

  // Keep at most 5 toasts on screen.
  while (stack.childElementCount > 5) stack.removeChild(stack.firstChild);
}
window.treeNotify = (msg, level, durationMs) => showToast(msg, level, durationMs);

// ============================================================
// SSH connect modal — wraps `ssh -L … tree-ide --serve` for an
// in-app "pick remote as a repo" experience. Only available
// inside Electron; the web/browser path doesn't have ssh access.
// ============================================================
function openSshModal() {
  if (!window.electronNative || !window.electronNative.connectSsh) {
    showToast('Remote SSH is only available in the desktop app.', 'warn');
    return;
  }
  const modal = $('#ssh-modal');
  if (!modal) return;
  const status = $('#ssh-status');
  if (status) { status.textContent = ''; status.classList.add('hidden'); }
  modal.classList.remove('hidden');
  const host = $('#ssh-host');
  setTimeout(() => { try { host && host.focus(); } catch {} }, 30);
}
function closeSshModal() {
  $('#ssh-modal')?.classList.add('hidden');
  const btn = $('#ssh-connect');
  if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
}
async function connectSshFromModal() {
  const btn      = $('#ssh-connect');
  const status   = $('#ssh-status');
  const host     = ($('#ssh-host')?.value || '').trim();
  const path     = ($('#ssh-path')?.value || '').trim();
  const identity = ($('#ssh-identity')?.value || '').trim();
  if (!host) {
    if (status) { status.textContent = 'SSH host is required (e.g. user@host).'; status.className = 'ssh-status error'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
  if (status) { status.textContent = `Opening ssh tunnel to ${host}\nWaiting for tree-ide on remote…`; status.className = 'ssh-status info'; }
  try {
    const res = await window.electronNative.connectSsh({ host, path, identity });
    if (res && res.ok && res.url) {
      if (status) { status.textContent = 'Connected. Loading remote workspace…'; status.className = 'ssh-status info'; }
      // Navigate the Electron window to the tunneled remote URL.
      // The remote server is serving the same renderer, so the page
      // reloads against the remote backend and the user sees their
      // remote repo in the same window.
      setTimeout(() => { window.location.href = res.url; }, 150);
    } else {
      const msg = (res && res.error) || 'Connection failed for an unknown reason.';
      if (status) { status.textContent = msg; status.className = 'ssh-status error'; }
      showToast('SSH connect failed: ' + msg.split('\n')[0], 'error', 8000);
      if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (status) { status.textContent = msg; status.className = 'ssh-status error'; }
    showToast('SSH connect failed: ' + msg, 'error', 8000);
    if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
  }
}
$('#ssh-connect-btn')?.addEventListener('click', openSshModal);
$('#welcome-ssh')?.addEventListener('click', openSshModal);
$('#ssh-cancel')?.addEventListener('click', closeSshModal);
$('#ssh-connect')?.addEventListener('click', connectSshFromModal);
$('#ssh-modal')?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSshModal();
  else if (e.key === 'Enter' && (e.target.tagName === 'INPUT')) connectSshFromModal();
});
// In browser/server mode (no electronNative), hide the SSH entry points.
if (!window.electronNative || !window.electronNative.connectSsh) {
  $('#ssh-connect-btn')?.classList.add('hidden');
  $('#welcome-ssh')?.classList.add('hidden');
}
// If the ssh tunnel dies after we navigated, tell the user — otherwise
// the page just appears to freeze when nothing is coming back over WS.
if (window.electronNative && window.electronNative.onSshGone) {
  window.electronNative.onSshGone((info) => {
    const detail = info && (info.code != null ? `code ${info.code}` : info.sig ? `signal ${info.sig}` : '');
    showToast('SSH tunnel closed' + (detail ? ` (${detail})` : '') + '. Reconnect to continue.', 'error', 0);
  });
}

// Visible breadcrumb when the WebSocket drops. The transport auto-
// reconnects with backoff, so we toast on the first close and dismiss
// when it comes back instead of nagging on each retry.
let _wsDownToast = null;
let _wsHasOpened = false;
if (window.tree && window.tree.onTransportOpen) {
  window.tree.onTransportOpen(() => {
    if (_wsHasOpened && _wsDownToast) {
      // Use treeNotify with a short ttl as the "reconnected" signal.
      showToast('Reconnected.', 'info', 2500);
    }
    _wsHasOpened = true;
    _wsDownToast = null;
  });
  window.tree.onTransportClose(() => {
    if (!_wsHasOpened || _wsDownToast) return;
    _wsDownToast = true;
    showToast('Lost connection to backend. Retrying…', 'warn', 4500);
  });
}
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
if (window.tree.onMenuOpenSsh) window.tree.onMenuOpenSsh(() => openSshModal());
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
// Update banner — surface a "Update & restart" button in the titlebar
// whenever the local version is behind the latest GitHub release.
// ============================================================
const updateBtn = $('#update-btn');
const updateBtnLabel = $('#update-btn-label');
let updateInfo = null;

function showUpdateBanner(info) {
  if (!updateBtn || !info || !info.isNewer) {
    updateBtn?.classList.add('hidden');
    return;
  }
  updateInfo = info;
  updateBtn.classList.remove('hidden');
  updateBtn.disabled = false;
  updateBtnLabel.textContent = info.gitCheckout
    ? `Update to v${info.latest} & restart`
    : `v${info.latest} available — get build`;
  updateBtn.title = info.gitCheckout
    ? `You're on v${info.current}. Latest release is v${info.latest}. Click to git pull, npm install, and relaunch.`
    : `You're on v${info.current}. Latest release is v${info.latest}. This isn't a git checkout, so the button opens the GitHub release page.`;
}

async function checkForUpdate() {
  if (!window.tree?.checkUpdate) return;
  try {
    const info = await window.tree.checkUpdate();
    if (info && info.isNewer) showUpdateBanner(info);
    else updateBtn?.classList.add('hidden');
  } catch {}
}

updateBtn?.addEventListener('click', async () => {
  if (!updateInfo || !window.tree?.updateAndRelaunch) return;
  updateBtn.disabled = true;
  updateBtnLabel.textContent = 'Updating…';
  const result = await window.tree.updateAndRelaunch();
  if (result && result.error) {
    updateBtnLabel.textContent = `Update failed`;
    updateBtn.title = result.error;
    updateBtn.disabled = false;
  }
});

window.tree?.onUpdateProgress?.((evt) => {
  if (!updateBtn || !updateBtnLabel) return;
  const map = { fetching: 'Fetching…', pulling: 'Pulling…', installing: 'Installing…', relaunching: 'Relaunching…' };
  if (evt?.status === 'downloading') {
    const pct = Number.isFinite(evt.percent) ? evt.percent : 0;
    updateBtnLabel.textContent = `Downloading ${pct}%`;
  } else if (evt?.status === 'error') {
    updateBtnLabel.textContent = 'Update failed';
    if (evt.error) updateBtn.title = evt.error;
    updateBtn.disabled = false;
  } else if (map[evt?.status]) {
    updateBtnLabel.textContent = map[evt.status];
  }
});

// Initial check shortly after launch, then every 30 minutes while open.
setTimeout(checkForUpdate, 2500);
setInterval(checkForUpdate, 30 * 60 * 1000);

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

  // Double-click the name to rename. Enter saves, Esc cancels, blur saves.
  dom.name.title = 'Double-click to rename';
  dom.name.addEventListener('dblclick', () => beginRenameAgent(agent));

  relayoutAgentGrid();
  return agent;
}

function createUserAgent({ provider = 'shell' } = {}) {
  const agent = createAgent({ label: `Agent ${state.agents.size + 1}`, provider });
  if (!agent) return null;
  setActiveAgent(agent.id);
  setWorkspaceView('agents');
  requestAnimationFrame(() => {
    if (agent.fitAddon) try { agent.fitAddon.fit(); } catch {}
    if (agent.term) try { agent.term.focus(); } catch {}
  });
  return agent;
}

function beginRenameAgent(agent) {
  const span = agent.dom.name;
  if (!span || span.dataset.editing === '1') return;
  const orig = agent.label;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'agent-name-input';
  input.value = orig;
  input.maxLength = 60;
  input.spellcheck = false;
  input.dataset.editing = '1';
  span.replaceWith(input);
  agent.dom.name = input;
  // Defer focus/select until the swap settles — otherwise blur can fire
  // immediately and revert before the user types.
  requestAnimationFrame(() => {
    try { input.focus(); input.select(); } catch {}
  });
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const trimmed = (input.value || '').trim();
    const next = save && trimmed ? trimmed.slice(0, 60) : orig;
    const newSpan = document.createElement('span');
    newSpan.className = 'agent-name';
    newSpan.textContent = next;
    newSpan.title = 'Double-click to rename';
    if (input.isConnected) input.replaceWith(newSpan);
    agent.dom.name = newSpan;
    newSpan.addEventListener('dblclick', () => beginRenameAgent(agent));
    agent.label = next;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')       { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    // Don't let typing in the rename field hit the page-level keyboard
    // shortcuts (e.g. ⌘O opening a folder picker).
    e.stopPropagation();
  });
  input.addEventListener('blur', () => commit(true));
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

// Refit terminals when the tab/window shows them. macOS's fullscreen
// transition fires a burst of resize events; xterm's fit walks every
// line, so refitting per tick on every agent terminal can hang the
// renderer. Coalesce to one fit-pass per animation frame.
let pendingTermFit = 0;
window.addEventListener('resize', () => {
  if (pendingTermFit) return;
  pendingTermFit = requestAnimationFrame(() => {
    pendingTermFit = 0;
    for (const a of state.agents.values()) {
      if (a.fitAddon) try { a.fitAddon.fit(); } catch {}
    }
  });
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
  newAgentBtn.addEventListener('click', () => createUserAgent());
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
window.tree.onUsageUpdate?.((snapshot) => {
  state.usageStats = snapshot;
  renderUsagePane();
});
// Live progress stages for the in-flight snapshot. Only repaint while the pane
// is actively loading so background refreshes don't flash the progress bar.
window.tree.onUsageProgress?.((evt) => {
  state.usageProgress = evt || null;
  const pct = Number(evt?.pct);
  if (Number.isFinite(pct)) state.usageProgressDisplay = Math.max(state.usageProgressDisplay || 0, pct);
  if (state.usageLoading) renderUsagePane();
});

// ===== Filesystem watcher → graph + ledger =====
// File events update the canvas immediately with cheap local hints. The backend
// follows with a graph:patch after rebuilding the authoritative graph.
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

function applyGraphPatchToData(graphData, patch) {
  if (!graphData || !patch) return graphData;
  const nodesById = new Map((graphData.nodes || []).map(n => [n.id, n]));
  const edgesById = new Map((graphData.edges || []).map(e => [e.id, e]));

  for (const id of patch.nodes?.remove || []) nodesById.delete(id);
  for (const node of patch.nodes?.add || []) nodesById.set(node.id, node);
  for (const node of patch.nodes?.update || []) nodesById.set(node.id, node);

  for (const id of patch.edges?.remove || []) edgesById.delete(id);
  for (const edge of patch.edges?.add || []) edgesById.set(edge.id, edge);
  for (const edge of patch.edges?.update || []) edgesById.set(edge.id, edge);

  return {
    ...graphData,
    nodes: [...nodesById.values()],
    edges: [...edgesById.values()],
    fileCount: typeof patch.fileCount === 'number' ? patch.fileCount : graphData.fileCount,
    elapsedMs: typeof patch.elapsedMs === 'number' ? patch.elapsedMs : graphData.elapsedMs,
  };
}

window.tree.onFsEvent((evt) => {
  if (evt.type === 'error') return;
  const rel = evt.path;
  if (!rel) return;
  const opMap = { add: 'CREATE', change: 'EDIT', unlink: 'DELETE' };
  const agentMeta = fileWriteSourceMeta();
  state.graphStale = true;

  if (evt.type === 'unlink') {
    graph.removeFile(rel);
  } else if (evt.type === 'add' && !graph.files.get(rel)) {
    graph.addFileStub(rel, stubHintForPath(rel));
    graph.touch(rel, 'edit', agentMeta);
  } else if (graph.files.get(rel)) {
    graph.touch(rel, 'edit', agentMeta);
  }

  scheduleFileChromeRefresh(90);
  pushLog(agentMeta.agentId === '__external__' ? 'result' : 'tool', `${agentMeta.label} ${opMap[evt.type] || evt.type.toUpperCase()} ${rel}`);
  pushLedger({
    op: opMap[evt.type] || evt.type.toUpperCase(),
    target: rel,
    status: agentMeta.label,
    fileId: graph.files.get(rel) ? rel : null,
  });
});

window.tree.onGraphPatch((patch) => {
  if (!patch) return;
  if (patch.root && state.root && patch.root !== state.root) return;
  if (!state.graphData) {
    scheduleRescan(0);
    return;
  }
  if (patch.empty) {
    state.graphData = {
      ...state.graphData,
      fileCount: typeof patch.fileCount === 'number' ? patch.fileCount : state.graphData.fileCount,
      elapsedMs: typeof patch.elapsedMs === 'number' ? patch.elapsedMs : state.graphData.elapsedMs,
    };
    state.graphStale = false;
    return;
  }
  state.graphData = applyGraphPatchToData(state.graphData, patch);
  state.files = state.graphData.nodes.filter(n => n.type !== 'external');
  graph.load(state.graphData);
  refreshFileChrome();
  state.graphStale = false;
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
    { key: 'git', label: 'Pending', count: [...graph.files.values()].filter(fileHasOpenGitChange).length },
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

function isNewAgentShortcut(e) {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key || '').toLowerCase() === 't';
}

function shortcutTargetIsEditable(target) {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  if (el.closest('.agent-term')) return false;
  return Boolean(el.closest('input, textarea, select, [contenteditable="true"]'));
}

function handleNewAgentCommand(e) {
  const target = e ? e.target : document.activeElement;
  if (shortcutTargetIsEditable(target)) return;
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  createUserAgent();
}

window.addEventListener('tree:new-agent', () => handleNewAgentCommand());

// Cmd/Ctrl+F focuses search. Cmd/Ctrl+T creates a new agent in browser mode;
// the Electron menu owns the desktop accelerator and dispatches tree:new-agent.
document.addEventListener('keydown', (e) => {
  if (!window.electronNative && isNewAgentShortcut(e)) {
    handleNewAgentCommand(e);
    return;
  }
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
}, true);

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
