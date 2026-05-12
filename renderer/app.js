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

const state = {
  root: null,
  files: [],
  graphData: null,
  selected: null,       // { kind: 'module'|'file'|'ai', ... }
  running: false,
  pendingPlan: null,    // last swap plan: { moduleKey, replacement, removed, added, body }
};

const AGENT_COLORS = [
  'hsl(35, 90%, 58%)',
  'hsl(176, 72%, 46%)',
  'hsl(330, 72%, 60%)',
  'hsl(214, 74%, 60%)',
  'hsl(98, 58%, 50%)',
  'hsl(268, 68%, 64%)',
];

function shortTargetName(target) {
  if (!target) return '';
  const clean = String(target).replace(/^file:/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1] || clean;
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
  list.innerHTML = '';
  const f = filter.toLowerCase();

  // group files by layer → kind → files
  const grouped = new Map();
  for (const file of graph.files.values()) {
    if (file.hidden) continue;
    let aliases = file.kind === 'table'
      ? ' sql database db table data read write insert update delete'
      : file.kind === 'schema'
        ? ' sql database schema migration data'
        : file.kind === 'model'
          ? ' database db model entity orm data'
          : file.kind === 'infra'
            ? ' docker terraform deploy deployment infra infrastructure vercel netlify compose'
            : file.kind === 'job'
              ? ' job worker queue cron background script'
              : file.kind === 'service'
                ? ' service server backend api process daemon'
                : file.kind === 'endpoint'
          ? ' api endpoint route server http get post put patch delete'
          : '';
    if (file.gitStatus && file.gitStatus.dirty) aliases += ' git dirty changed uncommitted modified';
    if (file.kind === 'table' && file.sqlStats) {
      if (file.sqlStats.read) aliases += ' reads read';
      if (file.sqlStats.write) aliases += ' writes write mutation changed';
      if (file.sqlStats.insert) aliases += ' insert';
      if (file.sqlStats.update) aliases += ' update';
      if (file.sqlStats.delete) aliases += ' delete';
    }
    const text = `${fileDisplayLabel(file)} ${file.id} ${file.kind}${aliases}`.toLowerCase();
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
    list.appendChild(layerHeader);

    const byKind = grouped.get(layerId);
    const kinds = [...byKind.keys()].sort();
    for (const k of kinds) {
      const files = byKind.get(k).sort((a, b) => fileDisplayLabel(a).localeCompare(fileDisplayLabel(b)));
      const kindHeader = document.createElement('div');
      kindHeader.className = 'sidebar-kind';
      kindHeader.textContent = `${prettyKind(k)} · ${files.length}`;
      list.appendChild(kindHeader);
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
        list.appendChild(row);
      }
      if (files.length > 100) {
        const more = document.createElement('div');
        more.className = 'group-more';
        more.textContent = `… +${files.length - 100} more`;
        list.appendChild(more);
      }
    }
  }
  $('#file-count').textContent = String(count);
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

$('#filter-input').addEventListener('input', (e) => renderModuleList(e.target.value));
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
      <button class="primary-btn" data-action="explain">Explain</button>
      <button class="primary-btn alt" data-action="audit">Audit</button>
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
  const targetLabel = f.kind === 'table' ? `${f.label} table in \`${targetFile}\`` : `\`${targetFile}\``;
  if (action === 'explain') {
    runPrompt(`Explain what ${targetLabel} does in plain English: its responsibilities, its public surface, and how it fits in the overall system. Read it first.`, 'explore');
    switchTab('chat');
  } else if (action === 'audit') {
    runPrompt(`Audit ${targetLabel} — bugs, code smells, performance, security risks. Read related files for context.`, 'explore');
    switchTab('chat');
  } else if (action === 'open') {
    loadFileViewer(targetFile);
    switchTab('file');
  }
}

function onModuleAction() {} // legacy no-op

// ============================================================
// Swap workflow
// ============================================================
function openSwapDialog(m) {
  const modal = $('#swap-modal');
  modal.classList.remove('hidden');
  $('#swap-title').textContent = `Swap "${m.label}"`;
  $('#swap-current').innerHTML = `<b>${m.files.length} files</b> in <code>${escapeHtml(m.key)}</code>:<br/>` +
    m.files.slice(0, 12).map(f => `<div>· ${escapeHtml(f.id)}</div>`).join('') +
    (m.files.length > 12 ? `<div class="dim">… +${m.files.length - 12} more</div>` : '');
  $('#swap-input').value = '';
  $('#swap-input').focus();
  $('#swap-plan-out').textContent = '';
  $('#swap-apply-btn').disabled = true;

  state.pendingPlan = { moduleKey: m.key, replacement: '', removed: [], added: [], body: '' };

  $('#swap-cancel-btn').onclick = () => closeSwapDialog();
  $('#swap-plan-btn').onclick = () => planSwap(m);
  $('#swap-apply-btn').onclick = () => applySwap(m);
}
function closeSwapDialog() {
  $('#swap-modal').classList.add('hidden');
  state.pendingPlan = null;
}

async function planSwap(m) {
  const replacement = $('#swap-input').value.trim();
  if (!replacement) return;
  $('#swap-plan-out').textContent = 'Planning…';
  $('#swap-apply-btn').disabled = true;

  // Highlight the module being replaced
  graph.expand(m.key);
  graph.setReplacement(m.files.map(f => f.id), [], `${m.label} → ${replacement} (planning…)`);

  const prompt = `I want to REPLACE the \`${m.label}\` module (top-level directory \`${m.key}\`) with: ${replacement}

Current files in this module:
${m.files.map(f => `- ${f.id}`).join('\n')}

Read whatever you need to understand the module. Then produce a plan in this exact JSON shape — and ONLY the JSON, wrapped in a fenced code block:

\`\`\`json
{
  "summary": "one sentence describing the swap",
  "remove": ["files/to/delete.ext", ...],
  "add":    ["new/files/to/create.ext", ...],
  "modify": ["existing/files/to/touch.ext", ...],
  "callers_to_update": ["files outside the module that import it"],
  "risks": ["short list of risks / breaking changes"],
  "estimated_steps": 5
}
\`\`\`

Do NOT modify any files. This is a planning step only.`;

  state.pendingPlan = { moduleKey: m.key, replacement, removed: [], added: [], body: '' };
  state.swapPlanCollect = '';
  state.collectingForSwap = true;

  await runPrompt(prompt, 'explore', { silent: true });
}

function tryParseSwapPlan(text) {
  // Extract first ```json ... ``` block
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch { return null; }
}

function presentSwapPlan(plan, moduleKey, replacement) {
  const m = graph.modules.get(moduleKey);
  if (!m) return;
  const removeSet = new Set(plan.remove || []);
  const addSet = new Set(plan.add || []);

  $('#swap-plan-out').innerHTML = `
    <div><b>${escapeHtml(plan.summary || `${m.label} → ${replacement}`)}</b></div>
    <div class="plan-cols">
      <div class="plan-col plan-remove">
        <div class="plan-col-title">– remove (${(plan.remove || []).length})</div>
        ${(plan.remove || []).map(p => `<div>${escapeHtml(p)}</div>`).join('') || '<div class="dim">(none)</div>'}
      </div>
      <div class="plan-col plan-add">
        <div class="plan-col-title">+ add (${(plan.add || []).length})</div>
        ${(plan.add || []).map(p => `<div>${escapeHtml(p)}</div>`).join('') || '<div class="dim">(none)</div>'}
      </div>
      <div class="plan-col plan-modify">
        <div class="plan-col-title">~ modify (${(plan.modify || []).length})</div>
        ${(plan.modify || []).map(p => `<div>${escapeHtml(p)}</div>`).join('') || '<div class="dim">(none)</div>'}
      </div>
    </div>
    ${(plan.callers_to_update || []).length ? `
      <div class="plan-callers"><b>Callers to update:</b><br/>${(plan.callers_to_update || []).map(p => `<div>${escapeHtml(p)}</div>`).join('')}</div>
    ` : ''}
    ${(plan.risks || []).length ? `
      <div class="plan-risks"><b>Risks:</b><br/>${(plan.risks || []).map(p => `<div>${escapeHtml(p)}</div>`).join('')}</div>
    ` : ''}
  `;
  $('#swap-apply-btn').disabled = false;

  graph.setReplacement([...removeSet], [...addSet], `${m.label} → ${replacement}`);
  state.pendingPlan = {
    moduleKey,
    replacement,
    removed: [...removeSet],
    added: [...addSet],
    plan,
  };
}

async function applySwap(m) {
  if (!state.pendingPlan || !state.pendingPlan.plan) return;
  const plan = state.pendingPlan.plan;
  const replacement = state.pendingPlan.replacement;

  closeSwapDialog();
  switchTab('chat');

  const prompt = `Apply the previously-described swap of the \`${m.label}\` module to: ${replacement}.

Plan:
- remove: ${(plan.remove || []).join(', ') || '(none)'}
- add:    ${(plan.add || []).join(', ') || '(none)'}
- modify: ${(plan.modify || []).join(', ') || '(none)'}
- callers_to_update: ${(plan.callers_to_update || []).join(', ') || '(none)'}

Now execute: create the new files, edit the modify+caller files, and delete the removed files. Read first when needed. Be surgical and explain each step briefly as you go.`;

  await runPrompt(prompt, 'edit');
}

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
      { label: 'Explain this file', action: () => runPrompt(`Explain what \`${id}\` does, its responsibilities, and key entry points. Read it first.`, 'explore') },
      { label: 'Find bugs / smells', action: () => runPrompt(`Audit \`${id}\` for bugs, code smells, and risky patterns. Read related files for context.`, 'explore') },
      { label: 'Suggest a refactor', action: () => runPrompt(`Read \`${id}\` and propose a concrete refactor with reasoning. Don't apply changes.`, 'explore') },
      { type: 'divider' },
      { label: 'Open in viewer', action: () => { switchTab('file'); loadFileViewer(id); } },
    ];
  } else if (hit.kind === 'ai') {
    items = [
      { type: 'header', label: 'AI controls' },
      { label: 'Map this entire repo', action: () => runPrompt(`Give me a high-level architectural map of this repo — entry points, main subsystems, and how data flows. Read enough files to be accurate.`, 'explore') },
      { label: 'Recent changes', action: () => runPrompt(`Run \`git log --oneline -20\` and explain what's been happening recently.`, 'explore') },
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
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
}
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

async function loadFileViewer(rel) {
  const v = $('#file-viewer');
  v.textContent = 'Loading…';
  const res = await window.tree.readFile(rel);
  v.textContent = res.error ? ('Error: ' + res.error) : (res.content || '(empty)');
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

  const result = await window.tree.scanRepo(p);
  if (result.error) {
    $('#hud-status').textContent = 'Error: ' + result.error;
    return;
  }
  state.graphData = result;
  state.files = result.nodes.filter(n => n.type !== 'external');
  graph.load(result);
  renderKindFilter();
  renderModuleList();
  renderFileDetail(null);
  const stampEl = $('#stamp-sub');
  if (stampEl) stampEl.textContent = shorten(p);
  const mappedNodes = [...graph.files.values()].filter(f => f.kind !== 'external');
  const dirtyCount = mappedNodes.filter(f => f.gitStatus && f.gitStatus.dirty).length;
  const sqlWriteCount = mappedNodes.filter(f => f.kind === 'table' && f.sqlStats && f.sqlStats.write).length;
  const stackText = result.stackSummary && result.stackSummary.length ? ` · ${result.stackSummary.slice(0, 5).join('/')}` : '';
  $('#hud-status').textContent = `${result.fileCount} files · ${mappedNodes.length} nodes · ${graph.layers.length} layers · ${dirtyCount} dirty · ${sqlWriteCount} SQL writes${stackText}`;

  pushChat('system', `Loaded blueprint: ${result.fileCount} files across ${graph.layers.length} layers (${[...graph.layers].map(L => L.name).join(', ')}).`);
}

function shorten(p) {
  if (!p) return '';
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-2).join('/');
}

$('#open-folder-btn').addEventListener('click', () => openRepo());
$('#welcome-open').addEventListener('click', () => openRepo());
window.tree.onMenuOpenFolder(() => openRepo());

window.tree.onScanProgress((evt) => {
  if (evt.status === 'scanning') $('#hud-status').textContent = 'Scanning ' + shorten(evt.root) + '…';
  else if (evt.status === 'reading') $('#hud-status').textContent = `Reading ${evt.done}/${evt.total}…`;
  else if (evt.status === 'done') $('#hud-status').textContent = `Mapped ${evt.count} files in ${evt.ms}ms`;
});

// ============================================================
// Multi-agent chat
//
// Each agent is its own Claude session with its own message list, mode,
// model, and running state. Agents arrange in a grid in the chat tab.
// `runPrompt(prompt, mode, opts)` routes to the "primary" agent (first one
// created), so existing callers (context menus, swap workflow, file detail
// actions) keep working unchanged.
// ============================================================
state.agents = new Map();          // id → agent record
state.primaryAgentId = null;
let agentCounter = 0;

function newAgentId() { return 'a' + (++agentCounter); }

function createAgent({ label, primary = false, mode = 'explore', model = '' } = {}) {
  const id = newAgentId();
  const grid = $('#agents-grid');
  if (!grid) return null;
  const color = AGENT_COLORS[(agentCounter - 1) % AGENT_COLORS.length];
  const tile = document.createElement('div');
  tile.className = 'agent-tile';
  tile.dataset.agentId = id;
  tile.dataset.mode = mode;
  tile.style.setProperty('--agent-color', color);
  const lbl = label || `Agent ${state.agents.size + 1}`;
  tile.innerHTML = `
    <div class="agent-head">
      <span class="agent-dot"></span>
      <div class="agent-title-stack">
        <span class="agent-name">${escapeHtml(lbl)}</span>
        <span class="agent-activity">idle</span>
      </div>
      <span class="agent-mode" data-mode="${mode}">${mode === 'edit' ? 'EDIT' : 'EXPLORE'}</span>
      <select class="agent-model" title="Model">
        <option value="">Default</option>
        <option value="claude-opus-4-7">Opus 4.7</option>
        <option value="claude-sonnet-4-6">Sonnet 4.6</option>
        <option value="claude-haiku-4-5">Haiku 4.5</option>
      </select>
      <button class="agent-stop hidden" title="Stop">STOP</button>
      <button class="agent-close" title="Close agent" ${primary ? 'style="display:none"' : ''}>x</button>
    </div>
    <div class="agent-messages"></div>
    <div class="agent-input">
      <textarea rows="2" placeholder="Ask Claude..."></textarea>
      <div class="agent-input-row">
        <button class="ghost-btn agent-send">SEND</button>
      </div>
    </div>
  `;
  grid.appendChild(tile);

  const dom = {
    tile,
    head: tile.querySelector('.agent-head'),
    dot: tile.querySelector('.agent-dot'),
    name: tile.querySelector('.agent-name'),
    activity: tile.querySelector('.agent-activity'),
    modeBadge: tile.querySelector('.agent-mode'),
    modelSelect: tile.querySelector('.agent-model'),
    stopBtn: tile.querySelector('.agent-stop'),
    closeBtn: tile.querySelector('.agent-close'),
    messages: tile.querySelector('.agent-messages'),
    input: tile.querySelector('textarea'),
    sendBtn: tile.querySelector('.agent-send'),
  };
  dom.modelSelect.value = model || '';
  dom.modeBadge.classList.toggle('edit', mode === 'edit');

  const agent = {
    id, label: lbl, primary,
    color,
    mode, model: model || '',
    running: false,
    reads: new Set(),
    edits: new Set(),
    lastTarget: null,
    assistantBubble: null,
    thinkingBubble: null,
    dom,
  };
  state.agents.set(id, agent);
  if (primary) state.primaryAgentId = id;

  // Toggle mode on click
  dom.modeBadge.addEventListener('click', () => {
    agent.mode = agent.mode === 'edit' ? 'explore' : 'edit';
    dom.modeBadge.textContent = agent.mode === 'edit' ? 'EDIT' : 'EXPLORE';
    dom.modeBadge.classList.toggle('edit', agent.mode === 'edit');
    tile.dataset.mode = agent.mode;
    if (!agent.running) dom.activity.textContent = agent.mode === 'edit' ? 'edit mode' : 'explore mode';
  });
  dom.modelSelect.addEventListener('change', () => { agent.model = dom.modelSelect.value || ''; });
  dom.stopBtn.addEventListener('click', async () => {
    await window.tree.cancelClaude(id);
  });
  dom.closeBtn.addEventListener('click', async () => {
    if (agent.running) await window.tree.cancelClaude(id);
    state.agents.delete(id);
    tile.remove();
    relayoutAgentGrid();
  });
  dom.sendBtn.addEventListener('click', () => sendAgentInput(id));
  dom.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendAgentInput(id);
    }
  });

  relayoutAgentGrid();
  return agent;
}

function relayoutAgentGrid() {
  const grid = $('#agents-grid');
  if (!grid) return;
  const count = state.agents.size;
  grid.dataset.count = String(count);
  const cEl = $('#agents-count');
  if (cEl) cEl.textContent = String(count);
}

async function sendAgentInput(agentId) {
  const agent = state.agents.get(agentId);
  if (!agent) return;
  const text = agent.dom.input.value.trim();
  if (!text) return;
  agent.dom.input.value = '';
  await runOnAgent(agentId, text, { mode: agent.mode, model: agent.model });
}

function pushAgentChat(agentId, role, text) {
  const agent = state.agents.get(agentId);
  if (!agent) return null;
  const wrap = agent.dom.messages;
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.textContent = text;
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
  return el;
}
function pushAgentTool(agentId, toolName, target) {
  const agent = state.agents.get(agentId);
  if (!agent) return;
  const wrap = agent.dom.messages;
  const el = document.createElement('div');
  el.className = 'msg tool';
  el.style.borderLeftColor = agent.color;
  el.innerHTML = `<span class="tool-name">${escapeHtml(toolName)}</span> ${escapeHtml(target || '')}`;
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
}
function autoScrollAgent(agentId) {
  const agent = state.agents.get(agentId);
  if (!agent) return;
  const wrap = agent.dom.messages;
  const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
  if (nearBottom) wrap.scrollTop = wrap.scrollHeight;
}
function setAgentRunning(agentId, running) {
  const agent = state.agents.get(agentId);
  if (!agent) return;
  agent.running = running;
  agent.dom.tile.classList.toggle('running', running);
  agent.dom.dot.classList.toggle('running', running);
  agent.dom.sendBtn.classList.toggle('hidden', running);
  agent.dom.stopBtn.classList.toggle('hidden', !running);
  if (agent.dom.activity && running) {
    agent.dom.activity.textContent = agent.mode === 'edit' ? 'editing...' : 'thinking...';
  } else if (agent.dom.activity) {
    agent.dom.activity.textContent = agent.lastTarget
      ? `last ${shortTargetName(agent.lastTarget)}`
      : (agent.mode === 'edit' ? 'edit mode' : 'explore mode');
  }
}

function markAgentTarget(agent, target, kind) {
  if (!agent || !target) return;
  agent.lastTarget = target;
  if (kind === 'edit') agent.edits.add(target);
  else agent.reads.add(target);
  if (agent.dom.activity) {
    agent.dom.activity.textContent = `${kind === 'edit' ? 'editing' : 'reading'} ${shortTargetName(target)}`;
  }
  graph.touch(target, kind, {
    agentId: agent.id,
    label: agent.label,
    color: agent.color,
  });
}

// Legacy helpers used by other parts of app.js (file detail and swap workflow).
// These route to the primary agent.
function pushChat(role, text) {
  const id = state.primaryAgentId;
  if (!id) return null;
  return pushAgentChat(id, role, text);
}
function pushTool(toolName, target) {
  const id = state.primaryAgentId;
  if (!id) return;
  return pushAgentTool(id, toolName, target);
}
function autoScrollChat() {
  if (state.primaryAgentId) autoScrollAgent(state.primaryAgentId);
}
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

function selectedModel() {
  const a = state.agents.get(state.primaryAgentId);
  return a ? (a.model || null) : null;
}

// Send a prompt to a specific agent.
async function runOnAgent(agentId, prompt, opts = {}) {
  const agent = state.agents.get(agentId);
  if (!agent) return;
  if (agent.running) {
    pushAgentChat(agentId, 'error', 'This agent is busy — stop it first or use another agent.');
    return;
  }
  if (!state.root) {
    pushAgentChat(agentId, 'error', 'Open a repo first.');
    return;
  }
  if (!opts.silent) {
    pushAgentChat(agentId, 'user', prompt.length > 280 ? prompt.slice(0, 280) + '…' : prompt);
  }
  setAgentRunning(agentId, true);
  agent.assistantBubble = null;
  agent.thinkingBubble = null;
  const focus = state.selected && state.selected.kind === 'file' ? state.selected.id : null;
  let r;
  try {
    r = await window.tree.runClaude({
      agentId,
      prompt,
      mode: opts.mode || agent.mode,
      focusNode: focus,
      model: opts.model || agent.model || undefined,
    });
  } catch (err) {
    pushAgentChat(agentId, 'error', err && err.message ? err.message : String(err));
    setAgentRunning(agentId, false);
    return;
  }
  if (r && r.error) {
    pushAgentChat(agentId, 'error', r.error);
    setAgentRunning(agentId, false);
  }
}

// Legacy entry point: route to the primary agent.
async function runPrompt(prompt, mode = 'explore', opts = {}) {
  ensurePrimaryAgent();
  return runOnAgent(state.primaryAgentId, prompt, { ...opts, mode });
}

function ensurePrimaryAgent() {
  if (state.primaryAgentId && state.agents.has(state.primaryAgentId)) return;
  const a = createAgent({ label: 'Primary', primary: true });
  if (!a) return;
  state.primaryAgentId = a.id;
}
ensurePrimaryAgent();

const newAgentBtn = $('#new-agent-btn');
if (newAgentBtn) {
  newAgentBtn.addEventListener('click', () => {
    createAgent({ label: `Agent ${state.agents.size + 1}` });
  });
}

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

window.tree.onClaudeEvent((evt) => {
  const aId = evt.agentId;
  const agent = aId ? state.agents.get(aId) : null;

  if (evt.type === 'start') {
    pushLog('tool', `> ${agent ? agent.label : 'Agent'} started`);
    pushLedger({ op: 'PROMPT', target: (evt.prompt || '').slice(0, 80), status: '…' });
    return;
  }
  if (evt.type === 'system' && evt.subtype === 'init') {
    const m = evt.data?.model || 'claude';
    const sid = evt.data?.session_id ? ` · ${String(evt.data.session_id).slice(0, 8)}` : '';
    if (agent) pushAgentChat(aId, 'system', `Session${sid} · ${m}`);
    return;
  }
  if (evt.type === 'thinking') {
    if (!agent) return;
    if (!agent.thinkingBubble) agent.thinkingBubble = pushAgentChat(aId, 'thinking', '');
    agent.thinkingBubble.textContent += evt.text;
    autoScrollAgent(aId);
    return;
  }
  if (evt.type === 'text') {
    if (!agent) return;
    agent.thinkingBubble = null;
    if (!agent.assistantBubble) agent.assistantBubble = pushAgentChat(aId, 'assistant', '');
    agent.assistantBubble.textContent += evt.text;
    // Swap workflow collects from the primary agent's stream
    if (state.collectingForSwap && aId === state.primaryAgentId) {
      state.swapPlanCollect = (state.swapPlanCollect || '') + evt.text;
    }
    autoScrollAgent(aId);
    return;
  }
  if (evt.type === 'tool_use') {
    if (agent) {
      agent.assistantBubble = null;
      agent.thinkingBubble = null;
    }
    const target = evt.target || (evt.input && (evt.input.file_path || evt.input.path));
    if (agent) pushAgentTool(aId, evt.tool, target);
    pushLog('tool', `${evt.tool} ${target || ''}`);
    const opMap = { Read: 'READ', Edit: 'EDIT', Write: 'EDIT', NotebookEdit: 'EDIT', Bash: 'BASH', Grep: 'GREP', Glob: 'GLOB' };
    const op = opMap[evt.tool] || evt.tool.toUpperCase();
    pushLedger({ op, target: target || '', status: '…', fileId: target && graph.files.get(target) ? target : null });
    if (target) {
      const isEdit = ['Edit', 'Write', 'NotebookEdit'].includes(evt.tool);
      if (agent && graph.files.get(target)) markAgentTarget(agent, target, isEdit ? 'edit' : 'read');
      else graph.touch(target, isEdit ? 'edit' : 'read');
    }
    return;
  }
  if (evt.type === 'tool_result') {
    pushLog('result', evt.ok ? 'ok' : 'error');
    const list = $('#ledger-entries');
    if (list && list.firstChild) {
      const status = list.firstChild.querySelector('.col-status');
      if (status) status.textContent = evt.ok ? 'OK' : 'ERR';
      if (!evt.ok) list.firstChild.classList.add('status-error');
    }
    return;
  }
  if (evt.type === 'result') {
    if (agent) setAgentRunning(aId, false);
    const cost = evt.cost != null ? `$${Number(evt.cost).toFixed(4)}` : '';
    const dur = evt.duration != null ? `${(evt.duration / 1000).toFixed(1)}s` : '';
    $('#hud-cost').textContent = [cost, dur, `${evt.turns || 0} turns`].filter(Boolean).join(' · ');
    pushLog('result', `done ${cost} ${dur}`);
    pushLedger({ op: 'DONE', target: `${evt.turns || 0} turns`, status: dur || 'OK' });

    if (state.collectingForSwap && aId === state.primaryAgentId) {
      state.collectingForSwap = false;
      const text = state.swapPlanCollect || '';
      const plan = tryParseSwapPlan(text);
      if (plan && state.pendingPlan) {
        presentSwapPlan(plan, state.pendingPlan.moduleKey, state.pendingPlan.replacement);
      } else if (state.pendingPlan) {
        $('#swap-plan-out').textContent = 'Could not parse a plan. See chat for raw output.';
      }
    }
    return;
  }
  if (evt.type === 'error') {
    if (agent) {
      setAgentRunning(aId, false);
      pushAgentChat(aId, 'error', evt.error);
    }
    pushLog('error', evt.error);
    pushLedger({ op: 'ERROR', target: (evt.error || '').slice(0, 80), status: 'ERR' });
    state.collectingForSwap = false;
    return;
  }
  if (evt.type === 'canceled' || evt.type === 'done') {
    if (agent) setAgentRunning(aId, false);
  }
});

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
  wrap.innerHTML = '';
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
    wrap.appendChild(pill);
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
    wrap.appendChild(pill);
  }
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
  searchDebounce = setTimeout(() => graph.setSearch(v), 60);
});
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.add('hidden');
  graph.setSearch('');
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
    searchInput.blur();
  }
});

// ============================================================
// Initial check — real preflight against the claude CLI
// ============================================================
(async () => {
  const c = await window.tree.checkClaude();
  if (!c.ok) {
    pushChat('error', c.error || 'Claude is unavailable. Install the CLI and sign in.');
  } else {
    pushChat('system', `Claude ${c.version} · subscription · ${c.cliPath}`);
  }
})();
