// Architecture-blueprint renderer — files as individual nodes inside layers.
//
// Layout:
//   Three horizontal bands stack top-to-bottom: INTERFACE / SERVER / DATA.
//   Each band has sub-sections per role (Pages, Components, Hooks, Routes…).
//   Each file is its own labeled node with its semantic name (Header,
//   POST /api/auth, useSession, /dashboard).
//   Edges = real imports between those nodes, drawn as thin bezier curves.
//   Hovering a node highlights its end-to-end flow neighborhood; dims everything else.
//   Search highlights matching nodes by semantic name or filename.
//   AI orb beams pulses to whichever node it touches.

const LAYER_DEFS = [
  { id: 'interface', name: 'INTERFACE', kinds: ['page', 'layout', 'template', 'component', 'hook', 'store', 'styles', 'loading', 'error', 'notfound', 'app', 'document', 'default', 'special'] },
  { id: 'server',    name: 'SERVER',    kinds: ['service', 'endpoint', 'route', 'middleware', 'server-action', 'job'] },
  { id: 'data',      name: 'DATA',      kinds: ['table', 'schema', 'model'] },
  { id: 'support',   name: 'SUPPORT',   kinds: ['infra', 'config', 'test', 'docs', 'module', 'other'] },
];

const LAYER_OF_KIND = {};
for (const L of LAYER_DEFS) for (const k of L.kinds) LAYER_OF_KIND[k] = L.id;

const KIND_PRETTY = {
  page: 'Pages', component: 'Components', hook: 'Hooks', store: 'Stores', layout: 'Layouts',
  styles: 'Styles', loading: 'Loading', error: 'Errors', template: 'Templates',
  notfound: 'Not Found', app: 'App Shell', document: 'HTML Doc', default: 'Parallel',
  special: 'Special',
  service: 'Services', endpoint: 'Endpoints', route: 'Route Files', middleware: 'Middleware', 'server-action': 'Server Actions',
  job: 'Jobs', table: 'Tables', schema: 'Schemas', model: 'Models', infra: 'Infra',
  config: 'Config', test: 'Tests', docs: 'Docs',
  module: 'Modules', other: 'Other', external: 'External Deps',
};

// cthdrl palette: black canvas, ghost-sand text, plus a small set of *muted*
// alt tints so each role reads distinctly without breaking the austere mood.
// Each tint is a desaturated neutral that pairs with sand on black.
let SAND = '231, 222, 209'; // rgb of #e7ded1 in dark mode, ink in light mode
let CANVAS_BG = '#000000';
let INVERT_TEXT = '#000000';
let GRAPH_THEME = null;
let TINT_CACHE = new Map();

const KIND_TINT_DARK = {
  // INTERFACE
  page:        'hsl(210, 22%, 74%)',
  layout:      'hsl(265, 16%, 76%)',
  template:    'hsl(265, 14%, 72%)',
  component:   'hsl(95, 16%, 76%)',
  hook:        'hsl(330, 18%, 76%)',
  store:       'hsl(290, 18%, 76%)',  // muted lavender for state stores
  styles:      'hsl(345, 18%, 76%)',
  loading:     'hsl(200, 14%, 70%)',
  error:       'hsl(8, 26%, 72%)',
  notfound:    'hsl(8, 26%, 72%)',
  app:         'hsl(220, 14%, 74%)',
  document:    'hsl(220, 12%, 70%)',
  default:     'hsl(245, 12%, 74%)',
  special:     'hsl(230, 10%, 72%)',
  // SERVER
  service:     'hsl(120, 14%, 74%)',
  endpoint:    'hsl(35, 38%, 78%)',   // bright ochre — endpoints are the action
  route:       'hsl(35, 22%, 68%)',   // duller ochre for the file-level route
  middleware:  'hsl(15, 24%, 74%)',
  'server-action': 'hsl(140, 18%, 74%)',
  job:         'hsl(55, 22%, 74%)',
  // DATA
  table:       'hsl(170, 24%, 76%)',  // brighter teal so ER cards pop
  schema:      'hsl(170, 20%, 72%)',
  model:       'hsl(185, 16%, 74%)',
  // SUPPORT
  infra:       'hsl(25, 16%, 72%)',
  config:      'hsl(40, 12%, 74%)',
  test:        'hsl(50, 18%, 74%)',
  docs:        'hsl(245, 8%, 74%)',
  module:      'hsl(35, 14%, 80%)',
  other:       'hsl(35, 8%, 70%)',
  external:    'hsl(35, 6%, 56%)',
};

const KIND_TINT_LIGHT = {
  // INTERFACE
  page:        'hsl(210, 42%, 34%)',
  layout:      'hsl(265, 32%, 38%)',
  template:    'hsl(265, 26%, 42%)',
  component:   'hsl(94, 35%, 30%)',
  hook:        'hsl(330, 34%, 38%)',
  store:       'hsl(290, 32%, 38%)',
  styles:      'hsl(345, 36%, 40%)',
  loading:     'hsl(200, 34%, 34%)',
  error:       'hsl(8, 48%, 38%)',
  notfound:    'hsl(8, 48%, 38%)',
  app:         'hsl(220, 30%, 35%)',
  document:    'hsl(220, 24%, 38%)',
  default:     'hsl(245, 26%, 36%)',
  special:     'hsl(230, 24%, 36%)',
  // SERVER
  service:     'hsl(128, 30%, 32%)',
  endpoint:    'hsl(32, 58%, 32%)',
  route:       'hsl(32, 42%, 36%)',
  middleware:  'hsl(15, 42%, 38%)',
  'server-action': 'hsl(140, 34%, 32%)',
  job:         'hsl(48, 48%, 34%)',
  // DATA
  table:       'hsl(178, 46%, 30%)',
  schema:      'hsl(176, 38%, 34%)',
  model:       'hsl(190, 34%, 32%)',
  // SUPPORT
  infra:       'hsl(25, 42%, 34%)',
  config:      'hsl(40, 34%, 34%)',
  test:        'hsl(50, 42%, 32%)',
  docs:        'hsl(245, 24%, 38%)',
  module:      'hsl(28, 34%, 28%)',
  other:       'hsl(35, 22%, 34%)',
  external:    'hsl(35, 18%, 46%)',
};

// Compatibility shim — older code still reads KIND_HUE; we keep an approximate
// hue lookup for any callers that need it.
const KIND_HUE = {
  page: 210, layout: 265, template: 265, component: 95, hook: 330, styles: 345,
  loading: 200, error: 8, notfound: 8, app: 220, document: 220, default: 245, special: 230,
  service: 120, route: 35, middleware: 15, 'server-action': 140, job: 55,
  schema: 170, model: 185, infra: 25, config: 40, test: 50, docs: 245, module: 35, other: 35, external: 35,
};

const HTTP_VERB_ORDER = new Map(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map((v, i) => [v, i]));

function endpointVerbOf(f) {
  const verb = f && (f.verb || String(f.label || '').match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/i)?.[1]);
  return String(verb || '').toUpperCase();
}

function endpointPathOf(f) {
  if (!f) return '';
  if (f.fullPath) return f.fullPath;
  const label = String(f.label || '');
  return label.replace(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/i, '') || f.id;
}

function endpointVerbRank(f) {
  const verb = endpointVerbOf(f);
  return HTTP_VERB_ORDER.has(verb) ? HTTP_VERB_ORDER.get(verb) : 99;
}

function tintRGB(kind, alpha = 1) {
  const key = `${GRAPH_THEME || 'dark'}|${kind}|${alpha}`;
  const cached = TINT_CACHE.get(key);
  if (cached) return cached;
  const tint = (GRAPH_THEME === 'light' ? KIND_TINT_LIGHT : KIND_TINT_DARK)[kind] || `rgba(${SAND}, ${alpha})`;
  if (alpha === 1) {
    TINT_CACHE.set(key, tint);
    return tint;
  }
  // Convert hsl(...) to hsla
  const out = tint.replace('hsl(', 'hsla(').replace(')', `, ${alpha})`);
  TINT_CACHE.set(key, out);
  return out;
}

function isLightTheme() {
  return !!(typeof document !== 'undefined' && document.body && document.body.classList && document.body.classList.contains('theme-light'));
}

function syncGraphTheme() {
  const nextTheme = isLightTheme() ? 'light' : 'dark';
  if (GRAPH_THEME === nextTheme) return;
  GRAPH_THEME = nextTheme;
  TINT_CACHE = new Map();
  if (nextTheme === 'light') {
    SAND = '31, 34, 30';
    CANVAS_BG = '#f7f8f5';
    INVERT_TEXT = '#f7f8f5';
  } else {
    SAND = '231, 222, 209';
    CANVAS_BG = '#000000';
    INVERT_TEXT = '#000000';
  }
}

function bgAlpha(alpha) {
  return GRAPH_THEME === 'light'
    ? `rgba(247, 248, 245, ${alpha})`
    : `rgba(0, 0, 0, ${alpha})`;
}

const FONT_MONO = '"NB Akademie Mono", "Space Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const FONT_DISPLAY = '"NB Akademie", "Montserrat", ui-sans-serif, system-ui, sans-serif';

class Graph {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;

    this.layers = [];           // [{ id, name, x,y,w,h, sections: [{kind, name, x,y,w,h, files: [file]}] }]
    this.files = new Map();     // id -> file (positioned)
    this.visibleFiles = [];     // non-hidden files after relayout
    this.visibleEdges = [];     // edges whose endpoints are visible after relayout
    this.hitFiles = [];         // positioned files in draw order, reused for hit-testing
    this.fileEdges = [];        // import edges (file → file or file → ext id)
    this.fnEdges = [];
    this.edgesBySource = new Map();
    this.edgesByTarget = new Map();
    this.flowEdgesBySource = new Map();
    this.flowEdgesByTarget = new Map();
    this.neighborhoodCache = null;

    this.aiNode = { id: '__ai__', x: 0, y: 0 };
    this.selected = null;
    this.hovered = null;

    // Visibility — start by hiding noise so the picture isn't a wall
    // Endpoints are shown by default; route files are hidden because endpoints
    // already cover that territory at finer grain.
    this.visibleKinds = new Set([
      'page', 'service', 'endpoint', 'component', 'hook', 'store', 'layout', 'special', 'middleware',
      'server-action', 'job', 'schema', 'table', 'model', 'infra', 'app',
    ]);
    // Per-section "expanded" state for sections beyond the cap
    this.SECTION_CAP = 24;
    this.expandedSections = new Set();
    // Per-table expansion (false = show only PK + FK + 2 more cols)
    this.expandedTables = new Set();
    this.TABLE_COLS_PREVIEW = 5;
    // Importance metric: fan-in + fan-out per file
    this.importance = new Map();
    // Zoomed-in mode: render export/consumer detail when zoom > threshold
    this.exportConsumers = new Map();   // "fileId|exportName" -> Set<consumerFileId>
    this.hoveredExport = null;          // { fileId, name }
    this.exportPills = new Map();       // fileId -> [{ name, kind, x, y, w, h }] for current frame
    this.OVERVIEW_LABEL_ZOOM = 0.38;    // below this, boxes become structural marks
    this.DETAIL_ZOOM = 1.25;             // export/function panels open past this zoom
    this.TABLE_DETAIL_ZOOM = 0.82;        // SQL rows open once zoomed enough to read
    this.TABLE_PREVIEW_ROWS = 7;
    this.debugEdges = false;

    this.searchQuery = '';
    this.matchSet = new Set();   // file ids matching

    this.replaced = { removed: new Set(), added: new Set(), title: '' };
    this.agentActivity = new Map(); // file id -> agent id -> { label, color, kind, last, count }

    this.camera = { x: 0, y: 0, zoom: 1 };
    this.cameraTarget = { x: 0, y: 0, zoom: 1 };
    this.cameraEase = 0;     // 0..1 — 0 = direct (no smoothing), 1 = animate
    this.dragging = null;
    this.lastMouse = { x: 0, y: 0 };
    this.didDrag = false;
    this.needsDraw = true;
    this.paused = false;
    this.resizeCanvas = null;
    this.frameScheduled = false;
    this.fastUntil = 0;
    this.fastTimer = null;
    this.hoverFrame = 0;
    this.pendingHoverPoint = null;
    this.activeGlowIds = new Set();

    this.pulses = [];

    this.setupCanvas();
    this.setupInput();
    this.scheduleFrame();
  }

  invalidate() {
    this.needsDraw = true;
    this.scheduleFrame();
  }

  markInteracting(ms = 140) {
    this.fastUntil = Math.max(this.fastUntil || 0, performance.now() + ms);
    if (this.fastTimer) clearTimeout(this.fastTimer);
    this.fastTimer = setTimeout(() => {
      this.fastTimer = null;
      this.invalidate();
    }, ms + 24);
  }

  scheduleFrame() {
    if (this.paused || this.frameScheduled) return;
    this.frameScheduled = true;
    requestAnimationFrame(() => this.frame());
  }

  setupCanvas() {
    const resize = () => {
      const r = this.canvas.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      // Retina 2x canvases roughly quadruple pixel work during panning. A
      // small cap keeps text readable while cutting a large amount of fill.
      const rawDpr = window.devicePixelRatio || 1;
      const nextDpr = rawDpr > 1 ? Math.min(rawDpr, 1.5) : 1;
      const widthChanged = this.width !== r.width || this.height !== r.height || this.dpr !== nextDpr;
      this.dpr = nextDpr;
      this.canvas.width = Math.round(r.width * this.dpr);
      this.canvas.height = Math.round(r.height * this.dpr);
      this.width = r.width;
      this.height = r.height;
      if (widthChanged) this.relayout();
      else this.invalidate();
    };
    this.resizeCanvas = resize;
    resize();
    window.addEventListener('resize', resize);
  }

  refreshSize({ fit = false } = {}) {
    if (this.resizeCanvas) this.resizeCanvas();
    if (fit) this.fit();
    else this.invalidate();
  }

  setPaused(paused) {
    this.paused = !!paused;
    if (!this.paused) this.invalidate();
  }

  // Pixels at the bottom of the canvas occluded by optional overlays.
  // The ledger UI was removed, but this keeps fit logic safe if one returns.
  bottomOcclusion() {
    const led = document.getElementById('ledger');
    if (!led) return 0;
    const rect = led.getBoundingClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();
    const overlap = Math.max(0, canvasRect.bottom - rect.top);
    return overlap;
  }
  topOcclusion() {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return 80;
    const rect = topbar.getBoundingClientRect();
    const canvasRect = this.canvas.getBoundingClientRect();
    const overlap = Math.max(0, rect.bottom - canvasRect.top);
    return Math.max(80, Math.ceil(overlap + 8));
  } // search bar / topbar area

  setupInput() {
    const c = this.canvas;
    const flushHover = () => {
      this.hoverFrame = 0;
      const sp = this.pendingHoverPoint;
      this.pendingHoverPoint = null;
      if (!sp || this.dragging) return;
      const p = this.screenToWorld(sp.x, sp.y);
      const h = this.hit(p.x, p.y);
      if (this.hitKey(this.hovered) !== this.hitKey(h)) {
        this.hovered = h;
        c.style.cursor = h ? 'pointer' : 'grab';
        this.invalidate();
      }
    };
    const queueHover = (sp) => {
      this.pendingHoverPoint = sp;
      if (this.hoverFrame) return;
      this.hoverFrame = requestAnimationFrame(flushHover);
    };
    c.addEventListener('mousedown', (e) => {
      const sp = this.eventPoint(e);
      const p = this.screenToWorld(sp.x, sp.y);
      const hit = this.hit(p.x, p.y);
      this.didDrag = false;
      this.dragging = { mode: hit ? 'hit' : 'pan', hit };
      this.lastMouse = sp;
      this.cameraEase = 0; // user is taking direct control
    });
    c.addEventListener('mousemove', (e) => {
      const sp = this.eventPoint(e);
      const dx = sp.x - this.lastMouse.x;
      const dy = sp.y - this.lastMouse.y;
      this.lastMouse = sp;
      if (this.dragging) {
        if (Math.abs(dx) + Math.abs(dy) > 1) this.didDrag = true;
        if (this.dragging.mode === 'pan') {
          this.markInteracting();
          this.camera.x += dx / this.camera.zoom;
          this.camera.y += dy / this.camera.zoom;
          this.cameraTarget.x = this.camera.x;
          this.cameraTarget.y = this.camera.y;
          this.invalidate();
        }
      } else {
        queueHover(sp);
      }
    });
    c.addEventListener('mouseup', (e) => {
      if (this.dragging && !this.didDrag) {
        const p = this.eventToWorld(e);
        const h = this.hit(p.x, p.y);
        if (h && h.kind === 'expand') {
          this.toggleSection(h.sectionKind);
        } else if (h && h.kind === 'table-toggle') {
          if (this.expandedTables.has(h.id)) this.expandedTables.delete(h.id);
          else this.expandedTables.add(h.id);
          this.relayout();
        } else if (h) {
          this.selected = h;
          if (this.onSelect) this.onSelect(h);
        } else {
          this.selected = null;
          if (this.onSelect) this.onSelect(null);
        }
        this.invalidate();
      }
      this.dragging = null;
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = this.eventToWorld(e);
      const h = this.hit(p.x, p.y);
      if (h) {
        this.selected = h;
        this.invalidate();
        if (this.onSelect) this.onSelect(h);
        if (this.onContext) this.onContext(h, e.clientX, e.clientY);
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cameraEase = 0;
      this.markInteracting();

      // Cmd/Ctrl + wheel OR pinch (browsers report pinch with ctrlKey=true)
      // = zoom. Plain trackpad two-finger swipe = pan.
      const isZoom = e.ctrlKey || e.metaKey;
      if (isZoom) {
        // Pinch sends ctrlKey + tiny deltas; mouse wheel + cmd sends large deltas.
        // Normalize so both feel similar.
        const k = Math.abs(e.deltaY) > 50 ? 0.0012 : 0.012;
        const factor = Math.exp(-e.deltaY * k);
        const sp = this.eventPoint(e);
        const before = this.screenToWorld(sp.x, sp.y);
        this.camera.zoom = Math.max(0.2, Math.min(4, this.camera.zoom * factor));
        const after = this.screenToWorld(sp.x, sp.y);
        this.camera.x += after.x - before.x;
        this.camera.y += after.y - before.y;
      } else {
        // Two-finger pan / shift+wheel pan / classic mouse wheel scroll
        // Sign: scrolling down moves content up, so subtract delta from camera.
        this.camera.x -= e.deltaX / this.camera.zoom;
        this.camera.y -= e.deltaY / this.camera.zoom;
      }
      this.cameraTarget.x = this.camera.x;
      this.cameraTarget.y = this.camera.y;
      this.cameraTarget.zoom = this.camera.zoom;
      this.invalidate();
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      const p = this.eventToWorld(e);
      const h = this.hit(p.x, p.y);
      if (h && h.kind === 'file') {
        this.zoomToNode(h.id);
        this.selected = h;
        this.invalidate();
        if (this.onSelect) this.onSelect(h);
      } else if (h && h.kind === 'section') {
        this.zoomToSection(h.sectionKind);
      } else {
        this.fit();
      }
    });

    // Optional: keyboard +/- and arrow nudge for accessibility
    window.addEventListener('keydown', (e) => {
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
      const step = 60 / this.camera.zoom;
      let handled = false;
      if (e.key === 'ArrowLeft')  { this.camera.x += step; this.cameraTarget.x = this.camera.x; handled = true; }
      else if (e.key === 'ArrowRight') { this.camera.x -= step; this.cameraTarget.x = this.camera.x; handled = true; }
      else if (e.key === 'ArrowUp')    { this.camera.y += step; this.cameraTarget.y = this.camera.y; handled = true; }
      else if (e.key === 'ArrowDown')  { this.camera.y -= step; this.cameraTarget.y = this.camera.y; handled = true; }
      else if (e.key === '+' || e.key === '=') { this.zoomBy(1.2); }
      else if (e.key === '-' || e.key === '_') { this.zoomBy(1 / 1.2); }
      else if (e.key === '0' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.fit(); }
      if (handled) this.invalidate();
    });
  }

  zoomBy(factor) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const before = this.screenToWorld(cx, cy);
    this.camera.zoom = Math.max(0.2, Math.min(4, this.camera.zoom * factor));
    const after = this.screenToWorld(cx, cy);
    this.camera.x += after.x - before.x;
    this.camera.y += after.y - before.y;
    this.cameraTarget.x = this.camera.x;
    this.cameraTarget.y = this.camera.y;
    this.cameraTarget.zoom = this.camera.zoom;
    this.invalidate();
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.width / 2) / this.camera.zoom - this.camera.x,
      y: (sy - this.height / 2) / this.camera.zoom - this.camera.y,
    };
  }

  eventPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  eventToWorld(e) {
    const p = this.eventPoint(e);
    return this.screenToWorld(p.x, p.y);
  }

  visibleBounds() {
    return {
      minX: -this.camera.x - this.width / (2 * this.camera.zoom),
      minY: -this.camera.y - this.height / (2 * this.camera.zoom),
      maxX: -this.camera.x + this.width / (2 * this.camera.zoom),
      maxY: -this.camera.y + this.height / (2 * this.camera.zoom),
    };
  }

  hit(wx, wy) {
    const ai = this.aiNode;
    if ((wx - ai.x) ** 2 + (wy - ai.y) ** 2 <= 22 * 22) {
      return { kind: 'ai', id: '__ai__' };
    }
    // Export pills (only present when zoomed-in detail is rendered)
    const pillEntries = [...this.exportPills.entries()].reverse();
    for (const [fileId, pills] of pillEntries) {
      for (const p of pills.slice().reverse()) {
        if (wx >= p.x && wx <= p.x + p.w && wy >= p.y && wy <= p.y + p.h) {
          return { kind: 'export', fileId, name: p.name };
        }
      }
    }
    for (let i = this.hitFiles.length - 1; i >= 0; i--) {
      const f = this.hitFiles[i];
      if (f.hidden) continue;
      if (wx >= f.x && wx <= f.x + f.w && wy >= f.y && wy <= f.y + f.h) {
        // Tables: bottom 14px is the expand/collapse footer
        if (f.kind === 'table' && f._showFooter && wy >= f.y + f.h - 14) {
          return { kind: 'table-toggle', id: f.id };
        }
        return { kind: 'file', id: f.id, label: f.label, fileKind: f.kind };
      }
    }
    for (let li = this.layers.length - 1; li >= 0; li--) {
      const L = this.layers[li];
      for (let si = L.sections.length - 1; si >= 0; si--) {
        const s = L.sections[si];
        if (wx >= s.x && wx <= s.x + s.w && wy >= s.y - 4 && wy <= s.y + 22) {
          return { kind: 'section', sectionKind: s.kind, label: s.name, files: s.files };
        }
        if (s.canExpand && wx >= s.x && wx <= s.x + 200 && wy >= s.y + s.h - 18 && wy <= s.y + s.h) {
          return { kind: 'expand', sectionKind: s.kind };
        }
      }
    }
    return null;
  }

  hitKey(h) {
    if (!h) return '';
    if (h.kind === 'file' || h.kind === 'table-toggle' || h.kind === 'ai') return `${h.kind}:${h.id || ''}`;
    if (h.kind === 'section' || h.kind === 'expand') return `${h.kind}:${h.sectionKind || ''}`;
    if (h.kind === 'export') return `export:${h.fileId || ''}:${h.name || ''}`;
    return `${h.kind || ''}:${h.id || h.fileId || h.sectionKind || h.name || ''}`;
  }

  layerOfKind(kind) {
    for (const L of LAYER_DEFS) if (L.kinds.includes(kind)) return L.id;
    return 'support';
  }

  // Best display label for a file. Generic kinds (store, job, service…) get
  // their filename or sublabel — "Store" or "Job" alone is uninformative when
  // the layer has 30 of them.
  displayLabel(f) {
    if (!f) return '';
    if (f.kind === 'route' && f.sublabel) {
      // e.g., "POST /api/auth"
      return `${f.label} ${f.sublabel}`;
    }
    if ((f.kind === 'page' || f.kind === 'layout' || f.kind === 'template') && f.sublabel) {
      return f.sublabel; // "/", "/dashboard"
    }
    if ((f.kind === 'hook' || f.kind === 'component') && f.sublabel) {
      return f.sublabel; // "useSession", "Header"
    }
    if (['config', 'infra', 'docs', 'schema'].includes(f.kind) && (f.sublabel || f.filename)) {
      return f.sublabel || f.filename;
    }
    // Stores, jobs, services, server-actions, tests, styles, models —
    // scanner labels these "Store"/"Job"/"Server"/etc which is too generic.
    // Prefer the filename so two stores in the same layer are distinguishable.
    const generic = ['store', 'job', 'service', 'server-action', 'test', 'styles', 'model'];
    if (generic.includes(f.kind)) {
      const name = f.sublabel || (f.filename ? f.filename.replace(/\.[^.]+$/, '') : '') || f.id;
      // Disambiguate generic basenames (index, main, route, server) with the
      // parent folder so the user can tell "stores/cart/index" from
      // "stores/user/index" at a glance.
      const GENERIC_BASENAMES = new Set(['index', 'main', 'route', 'server', 'app', 'handler', 'router']);
      if (GENERIC_BASENAMES.has(String(name).toLowerCase()) && f.dir) {
        const folder = f.dir.split('/').pop();
        if (folder) return `${folder}/${name}`;
      }
      return name;
    }
    if (f.kind === 'middleware') return 'middleware';
    return f.label || f.filename || f.id;
  }

  load(graphData) {
    this.layers = [];
    this.files.clear();
    this.fileEdges = [];
    this.fnEdges = graphData.fnEdges || [];
    this.visibleKinds = new Set([
      'page', 'service', 'endpoint', 'component', 'hook', 'store', 'layout', 'special', 'middleware',
      'server-action', 'job', 'schema', 'table', 'model', 'infra', 'app',
    ]);
    this.pulses = [];
    this.replaced = { removed: new Set(), added: new Set(), title: '' };
    this.searchQuery = '';
    this.matchSet.clear();

    for (const n of graphData.nodes) {
      const isExt = n.type === 'external';
      const file = {
        id: n.id,
        filename: n.filename || n.id.split('/').pop(),
        label: n.label,
        sublabel: n.sublabel || '',
        kind: isExt ? 'external' : (n.kind || 'module'),
        methods: n.methods || null,
        verb: n.verb || null,
        fullPath: n.fullPath || '',
        exports: n.exports || [],
        importsRefs: n.importsRefs || [],
        columns: n.columns || null,         // for kind === 'table'
        parentFile: n.parentFile || null,   // for kind === 'table' / endpoint
        tableRefs: n.tableRefs || [],
        endpointStats: null,
        deadApiCalls: n.deadApiCalls || null, // unresolved API calls from this file
        gitStatus: n.gitStatus || null,
        usage: n.usage || null,
        sqlStats: n.sqlStats || null,
        ext: n.ext,
        size: n.size || 0,
        dir: n.dir || (n.id.includes('/') ? n.id.slice(0, n.id.lastIndexOf('/')) : ''),
        x: 0, y: 0, w: 110, h: 24,
        glow: 0, lastTouched: 0,
      };
      file.searchText = this.searchTextFor(file);
      this.files.set(n.id, file);
    }
    for (const id of [...this.agentActivity.keys()]) {
      if (!this.files.has(id)) this.agentActivity.delete(id);
    }
    this.fileEdges = (graphData.edges || []).slice();
    for (const e of this.fileEdges) {
      e.isApiCall = e.type === 'api-call';
      e.isFk = e.type === 'fk';
      e.isDbQuery = e.type === 'db-query';
      e.isEndpointInternal = e.type === 'endpoint-internal';
      e.isTransitive = !!e.transitive;
      e.dbOps = e.operations || [];
    }
    this.rebuildEdgeIndexes();

    const visibleNonExternal = [...this.files.values()].filter(f => f.kind !== 'external');
    const currentlyVisible = visibleNonExternal.filter(f => this.visibleKinds.has(f.kind)).length;
    const endpointCount = visibleNonExternal.filter(f => f.kind === 'endpoint').length;
    const routeCount = visibleNonExternal.filter(f => f.kind === 'route').length;
    if (
      visibleNonExternal.length <= 80 ||
      currentlyVisible < Math.max(4, Math.ceil(visibleNonExternal.length * 0.28))
    ) {
      for (const k of ['module', 'config', 'test', 'docs', 'styles', 'other', 'loading', 'error', 'notfound', 'document', 'default']) {
        this.visibleKinds.add(k);
      }
    }
    if (!endpointCount && routeCount) this.visibleKinds.add('route');

    const isUiSource = (id) => {
      const f = this.files.get(id);
      return id.startsWith('frontend/') ||
        id.startsWith('landing/') ||
        (f && ['page', 'component', 'hook', 'store'].includes(f.kind));
    };
    for (const f of this.files.values()) {
      if (f.kind === 'endpoint') {
        f.endpointStats = { callers: 0, ui: 0, backend: 0, db: 0, internal: 0 };
      }
    }
    for (const e of this.fileEdges) {
      const target = this.files.get(e.target);
      const source = this.files.get(e.source);
      if (target && target.kind === 'endpoint' && e.isApiCall && target.endpointStats) {
        target.endpointStats.callers++;
        if (isUiSource(e.source)) target.endpointStats.ui++;
        else target.endpointStats.backend++;
      }
      if (source && source.kind === 'endpoint' && source.endpointStats) {
        if (e.isDbQuery) source.endpointStats.db++;
        if (e.isEndpointInternal) source.endpointStats.internal++;
      }
    }

    // Compute importance: fan-in + fan-out
    this.importance.clear();
    const bump = (id, w = 1) => this.importance.set(id, (this.importance.get(id) || 0) + w);
    for (const e of this.fileEdges) {
      bump(e.source, 1);
      bump(e.target, 1);
    }

    // Index "who consumes file X's named export Y". This powers the export-hover
    // highlight when the user is zoomed in on a single file.
    this.exportConsumers.clear();
    // Map: edge target id → list of files that have an import edge to it
    const importersByTarget = new Map();
    for (const e of this.fileEdges) {
      if (e.type !== 'import') continue;
      if (!importersByTarget.has(e.target)) importersByTarget.set(e.target, []);
      importersByTarget.get(e.target).push(e.source);
    }
    for (const [targetId, importers] of importersByTarget) {
      const target = this.files.get(targetId);
      if (!target) continue;
      const exportNames = new Set((target.exports || []).map(e => e.name));
      for (const importerId of importers) {
        const importer = this.files.get(importerId);
        if (!importer || !importer.importsRefs) continue;
        for (const ref of importer.importsRefs) {
          for (const name of (ref.names || [])) {
            if (!exportNames.has(name)) continue;
            const k = `${targetId}|${name}`;
            if (!this.exportConsumers.has(k)) this.exportConsumers.set(k, new Set());
            this.exportConsumers.get(k).add(importerId);
          }
        }
      }
    }

    this.relayout();
    this.fit();
  }

  // Fully dynamic horizontal-column layout.
  //   - Each architectural layer (INTERFACE / SERVER / DATA / SUPPORT) becomes
  //     a vertical column placed side-by-side. Diagram grows to the SIDES.
  //   - All sizes are derived from the actual content: column widths come from
  //     the widest item that needs to fit; section heights from the items
  //     within. Nothing is hardcoded by repo or kind.
  //   - Within each column, sections (Pages, Endpoints, Tables…) stack
  //     vertically. Within a section, items wrap into rows that fit the
  //     column's width.
  refreshVisibleCaches() {
    this.visibleFiles = [...this.files.values()].filter(f => !f.hidden);
    this.hitFiles = this.visibleFiles.slice();
    this.visibleEdges = (this.fileEdges || []).filter(e => {
      const a = this.files.get(e.source);
      const b = this.files.get(e.target);
      return !!(a && b && !a.hidden && !b.hidden);
    });
  }

  relayout() {
    if (!this.files.size) {
      this.visibleFiles = [];
      this.visibleEdges = [];
      this.hitFiles = [];
      return;
    }
    this.neighborhoodCache = null;
    const ctx = this.ctx;
    const topPad = (this.topOcclusion ? this.topOcclusion() : 80) + 24;

    // ---- 1. Bucket visible files by layer + kind ----
    const byLayer = {};
    for (const L of LAYER_DEFS) byLayer[L.id] = new Map();
    let visibleNodeCount = 0;
    for (const f of this.files.values()) {
      const forceVisible = this.searchQuery && this.matchSet.has(f.id);
      if (!this.visibleKinds.has(f.kind) && !forceVisible) { f.hidden = true; continue; }
      f.hidden = false;
      visibleNodeCount++;
      const lid = LAYER_OF_KIND[f.kind] || 'support';
      const m = byLayer[lid];
      if (!m.has(f.kind)) m.set(f.kind, []);
      m.get(f.kind).push(f);
    }
    this.visibleNodeCount = visibleNodeCount;
    const density = visibleNodeCount <= 80 ? 'small' : visibleNodeCount <= 320 ? 'medium' : 'large';

    // ---- 2. Geometry primitives derived from current font metrics ----
    const fontPills = `400 12px ${FONT_MONO}`;
    const fontTable = `400 11px ${FONT_MONO}`;
    const PILL_PAD_X = 18;
    const PILL_MIN_W = density === 'small' ? 112 : 84;
    const PILL_MAX_W = density === 'small' ? 520 : density === 'medium' ? 460 : 420;
    const PILL_H = density === 'small' ? 34 : 30;
    const LABEL_LINE_H = 14;
    const ITEM_GAP = density === 'small' ? 10 : 8;
    const ROW_GAP = density === 'small' ? 12 : 10;
    const SECTION_HEAD_H = 30;
    const SECTION_GAP = density === 'small' ? 36 : 30;
    const COL_GAP = density === 'small' ? 52 : density === 'medium' ? 60 : 64;
    const SAFE_GAP = density === 'small' ? 26 : 22;

    // Measure widest "label" for files in each layer/kind so we can pick a
    // column width that *always* fits at least one item per row (and as many
    // as possible for compact items).
    const measureLabel = (f, font) => {
      ctx.font = font;
      if (f.kind === 'table') {
        let w = ctx.measureText((f.label || '').toUpperCase()).width + 60;
        for (const c of (f.columns || [])) {
          w = Math.max(w, ctx.measureText(`${c.name} ${c.type}`).width + 56);
        }
        return Math.ceil(w);
      }
      const lbl = this.displayLabel(f);
      return Math.ceil(Math.min(PILL_MAX_W, ctx.measureText(lbl).width + PILL_PAD_X * 2));
    };

    // Per-layer width statistics: collect every visible item's natural width
    // and derive both median and max so we can size columns dynamically — pack
    // typical items 2-up while still letting outliers take a full row.
    const widthsByLayer = {};
    for (const L of LAYER_DEFS) {
      const widths = [];
      const buckets = byLayer[L.id];
      if (!buckets) { widthsByLayer[L.id] = []; continue; }
      for (const [k, files] of buckets) {
        const font = (k === 'table') ? fontTable : fontPills;
        for (const f of files) widths.push(measureLabel(f, font));
      }
      widths.sort((a, b) => a - b);
      widthsByLayer[L.id] = widths;
    }
    const stat = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;

    // Decide how wide each layer column should be, dynamically and per content.
    // The diagram is meant to grow SIDEWAYS, not down — so for crowded layers
    // we scale columns with sqrt(count) and bias toward more side-by-side
    // packing instead of letting one section run hundreds of rows tall.
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const sqrtCols = (count, maxCols, divisor = 1.5) =>
      clamp(Math.round(Math.sqrt(Math.max(1, count)) / divisor), 1, maxCols);
    const layerColWidth = (lid) => {
      const ws = widthsByLayer[lid];
      if (!ws || !ws.length) return PILL_MIN_W;
      const buckets = byLayer[lid];
      const max = ws[ws.length - 1];
      const count = [...buckets.values()].reduce((sum, files) => sum + files.length, 0);
      if (buckets.has('table')) {
        return Math.ceil(max + 24);
      }
      if (buckets.has('endpoint')) {
        const p60 = stat(ws, 0.6);
        const med = stat(ws, 0.5);
        const maxCols = density === 'small' ? 4 : density === 'medium' ? 5 : 6;
        const cols = sqrtCols(count, maxCols, 1.8);
        const endpointGroups = new Map();
        for (const f of buckets.get('endpoint') || []) {
          const key = endpointPathOf(f);
          if (!endpointGroups.has(key)) endpointGroups.set(key, []);
          endpointGroups.get(key).push(f);
        }
        let groupedW = 0;
        for (const group of endpointGroups.values()) {
          if (group.length < 2) continue;
          const compactW = 118;
          const groupCols = Math.min(group.length, 4);
          groupedW = Math.max(groupedW, compactW * groupCols + ITEM_GAP * (groupCols - 1));
        }
        return Math.ceil(Math.max(med * cols + ITEM_GAP * (cols - 1), p60 + 24, groupedW + 20) + 16);
      }
      if (lid === 'support') {
        const maxCols = density === 'small' ? 4 : density === 'medium' ? 5 : 6;
        const cols = sqrtCols(count, maxCols, 1.8);
        return Math.ceil(Math.max(max, stat(ws, 0.5) * cols + ITEM_GAP * (cols - 1)) + 16);
      }
      const med = stat(ws, 0.5);
      const maxCols = density === 'small' ? 4 : density === 'medium' ? 6 : 8;
      const cols = sqrtCols(count, maxCols, 1.5);
      return Math.ceil(Math.max(max + 16, med * cols + ITEM_GAP * (cols - 1) + 24));
    };

    // ---- 3. Decide which layers are present, in display order ----
    const activeLayers = LAYER_DEFS
      .filter(L => byLayer[L.id] && byLayer[L.id].size)
      .map(L => ({ L, w: layerColWidth(L.id) }));

    if (!activeLayers.length) {
      this.layers = [];
      this.refreshVisibleCaches();
      return;
    }

    // ---- 4. Build each layer at x=0 first, then center horizontally ----
    // We defer horizontal placement so bin-packing inside a layer (which can
    // widen the layer beyond its initial subColW) doesn't throw off the
    // overall centering. After every layer's final width is known, a second
    // pass shifts them into place.
    const builtLayers = [];
    for (const { L, w: subColW } of activeLayers) {
      const layer = {
        id: L.id, name: L.name, sections: [],
        x: 0, y: topPad, w: subColW, h: 0,
      };
      // ---- 5a. Lay out sections vertically inside one sub-column ----
      let yCursor = layer.y + 6;
      let lastBottom = yCursor;

      const orderedKinds = L.kinds.filter(k => byLayer[L.id].has(k));
      // Kinds where clustering by folder makes a crowded section legible.
      // Beyond a threshold we split the section into one mini-section per
      // folder so 200 components are presented as a handful of nameable
      // groups instead of a wall.
      const DIR_GROUPED = new Set(['component', 'hook', 'store', 'job', 'service', 'server-action', 'model', 'styles', 'test', 'module']);
      const FOLDER_SPLIT_THRESHOLD = 40;
      const dirKey = (f) => {
        const d = f.dir || '';
        if (!d) return '';
        return d.split('/').pop() || d;
      };

      // First sort each kind's files; then optionally split into per-folder
      // sub-sections. We never cap or hide anything — bin-packing handles the
      // resulting height.
      const units = [];
      for (const k of orderedKinds) {
        const allK = byLayer[L.id].get(k).slice().sort((a, b) => {
          if (k === 'table' && a.parentFile && b.parentFile && a.parentFile !== b.parentFile) {
            return a.parentFile.localeCompare(b.parentFile);
          }
          if (k === 'endpoint') {
            const pa = endpointPathOf(a);
            const pb = endpointPathOf(b);
            if (pa !== pb) return pa.localeCompare(pb);
            const va = endpointVerbRank(a);
            const vb = endpointVerbRank(b);
            if (va !== vb) return va - vb;
            if (a.parentFile && b.parentFile && a.parentFile !== b.parentFile) return a.parentFile.localeCompare(b.parentFile);
            return a.id.localeCompare(b.id);
          }
          if (DIR_GROUPED.has(k)) {
            const da = dirKey(a);
            const db = dirKey(b);
            if (da !== db) return da.localeCompare(db);
          }
          const ia = this.importance.get(a.id) || 0;
          const ib = this.importance.get(b.id) || 0;
          if (ia !== ib) return ib - ia;
          return (this.displayLabel(a) || '').localeCompare(this.displayLabel(b) || '');
        });

        if (DIR_GROUPED.has(k) && allK.length > FOLDER_SPLIT_THRESHOLD) {
          const folderGroups = new Map();
          for (const f of allK) {
            const folder = dirKey(f) || '·';
            if (!folderGroups.has(folder)) folderGroups.set(folder, []);
            folderGroups.get(folder).push(f);
          }
          const folders = [...folderGroups.entries()].sort((a, b) => {
            if (a[1].length !== b[1].length) return b[1].length - a[1].length;
            return a[0].localeCompare(b[0]);
          });
          for (const [folder, files] of folders) {
            units.push({
              kind: k,
              name: folder === '·' ? (KIND_PRETTY[k] || k) : `${KIND_PRETTY[k] || k} · ${folder}`,
              files,
              allCount: files.length,
            });
          }
        } else {
          units.push({
            kind: k,
            name: KIND_PRETTY[k] || k,
            files: allK,
            allCount: allK.length,
          });
        }
      }

      for (const u of units) {
        const k = u.kind;
        const filesK = u.files;
        for (const f of filesK) f.hidden = false;

        yCursor = Math.max(yCursor, lastBottom + SAFE_GAP);
        const section = {
          kind: k, name: u.name,
          files: filesK,
          allCount: u.allCount,
          hiddenCount: 0,
          canExpand: false,
          expanded: true,
          x: layer.x + 6, y: yCursor, w: layer.w - 12, h: 0,
        };

        // Per-section item layout: dynamic — auto-width to label, wrap by row
        const headerY = yCursor + SECTION_HEAD_H;
        const innerW = section.w - 4;
        let placeX = section.x + 2;
        let rowY = headerY;
        let rowMaxBottom = rowY;

        const placeNode = (f, w, h) => {
          if (placeX + w > section.x + innerW && placeX !== section.x + 2) {
            placeX = section.x + 2;
            rowY = rowMaxBottom + ROW_GAP;
          }
          f.w = w;
          f.h = h;
          f.x = placeX;
          f.y = rowY;
          f.hidden = false;
          placeX += w + ITEM_GAP;
          rowMaxBottom = Math.max(rowMaxBottom, rowY + h);
        };

        const sizeDefaultNode = (f) => {
          let w, h;
          if (f.kind === 'table') {
            const cols = f.columns || [];
            const expanded = this.expandedTables.has(f.id);
            const visCols = expanded ? cols : cols.slice(0, this.TABLE_PREVIEW_ROWS);
            f._visibleCols = visCols;
            f._tableExpanded = expanded;
            f._showFooter = cols.length > this.TABLE_PREVIEW_ROWS;
            f._moreCount = Math.max(0, cols.length - visCols.length);
            const headerH = 26, rowH = 17;
            w = innerW;                                   // tables fill column width
            h = headerH + visCols.length * rowH + (f._showFooter ? 24 : 8);
          } else {
            f._endpointCompact = false;
            f._endpointPath = '';
            f._endpointVerb = '';
            const labelW = measureLabel(f, fontPills);
            const cap = PILL_MAX_W;
            w = Math.max(PILL_MIN_W, Math.min(cap, labelW));
            const imp = this.importance.get(f.id) || 0;
            f._importance = imp;
            w = Math.min(cap, Math.ceil(w + Math.min(36, Math.log2(imp + 1) * 6)));
            if (w > innerW) w = innerW;
            const labelMaxW = Math.max(20, w - PILL_PAD_X * 2);
            f._labelLines = this.wrapLabel(ctx, this.displayLabel(f), labelMaxW, f.kind === 'endpoint' ? 3 : 2);
            const textH = f._labelLines.length * LABEL_LINE_H;
            const endpointMetaH = f.kind === 'endpoint' ? 16 : 0;
            const minH = f.kind === 'endpoint' ? 48 : PILL_H;
            h = Math.max(minH, textH + 14 + endpointMetaH + Math.min(6, Math.log2(imp + 1) * 1.4));
          }
          return { w, h };
        };

        if (k === 'endpoint') {
          const groups = [];
          for (const f of filesK) {
            const key = endpointPathOf(f);
            const last = groups[groups.length - 1];
            if (last && last.key === key) last.files.push(f);
            else groups.push({ key, files: [f] });
          }
          for (const group of groups) {
            if (group.files.length > 1) {
              if (placeX !== section.x + 2) {
                placeX = section.x + 2;
                rowY = rowMaxBottom + ROW_GAP;
              }
              const minMethodW = 96;
              const maxCols = Math.max(1, Math.floor((innerW + ITEM_GAP) / (minMethodW + ITEM_GAP)));
              const cols = Math.max(1, Math.min(group.files.length, maxCols));
              const compactW = Math.max(minMethodW, Math.min(132, Math.floor((innerW - ITEM_GAP * (cols - 1)) / cols)));
              for (const f of group.files) {
                f._endpointCompact = true;
                f._endpointPath = group.key;
                f._endpointVerb = endpointVerbOf(f) || 'API';
                f._labelLines = [f._endpointVerb, group.key];
                const imp = this.importance.get(f.id) || 0;
                f._importance = imp;
                placeNode(f, compactW, 52);
              }
              placeX = section.x + 2;
              rowY = rowMaxBottom + ROW_GAP;
            } else {
              const f = group.files[0];
              const box = sizeDefaultNode(f);
              placeNode(f, box.w, box.h);
            }
          }
        } else {
          for (const f of filesK) {
            const box = sizeDefaultNode(f);
            placeNode(f, box.w, box.h);
          }
        }

        section.h = (rowMaxBottom + (filesK.some(f => f.kind === 'table') ? 6 : 14)) - yCursor;
        layer.sections.push(section);

        let bottom = rowMaxBottom;
        for (const f of filesK) {
          if (!f.hidden && (f.y + f.h) > bottom) bottom = f.y + f.h + 6;
        }
        lastBottom = bottom;
        yCursor = lastBottom + SECTION_GAP;
      }

      layer.h = Math.max(0, lastBottom - layer.y);

      // ---- 5b. Bin-pack sections into multiple sub-columns when the layer
      //          is much taller than wide. This is what lets a big repo
      //          grow horizontally: instead of one tower of 25 sections, we
      //          place sections greedily into the shortest available
      //          sub-column. Nothing is hidden — only re-positioned.
      const SUB_GAP = COL_GAP;
      // Roughly target an aspect ratio of 1:1.4 (height ≈ 1.4 × width) before
      // splitting into another sub-column. Always allow at least one sub-col
      // and cap at 6 so the overall diagram stays browsable.
      const aspectTarget = Math.max(700, subColW * 1.4);
      let K = 1;
      if (layer.sections.length > 1 && layer.h > aspectTarget) {
        K = Math.min(layer.sections.length, 6, Math.ceil(layer.h / aspectTarget));
      }
      if (K > 1) {
        const colHeights = new Array(K).fill(layer.y + 6);
        for (const s of layer.sections) {
          let best = 0;
          for (let i = 1; i < K; i++) if (colHeights[i] < colHeights[best]) best = i;
          const newX = layer.x + 6 + best * (subColW + SUB_GAP);
          const newY = colHeights[best];
          const dx = newX - s.x;
          const dy = newY - s.y;
          s.x += dx;
          s.y += dy;
          for (const f of s.files) {
            if (f.hidden) continue;
            f.x += dx;
            f.y += dy;
          }
          colHeights[best] = s.y + s.h + SECTION_GAP;
        }
        layer.w = K * subColW + (K - 1) * SUB_GAP;
        layer.h = Math.max(...colHeights) - layer.y;
      }

      builtLayers.push(layer);
    }

    // ---- 6. Center the finished layers horizontally. ----
    const finalTotalW = builtLayers.reduce((s, l) => s + l.w, 0) + COL_GAP * Math.max(0, builtLayers.length - 1);
    let xCursor = -finalTotalW / 2;
    for (const layer of builtLayers) {
      const dx = xCursor - layer.x;
      if (dx !== 0) {
        layer.x = xCursor;
        for (const s of layer.sections) {
          s.x += dx;
          for (const f of s.files) {
            if (!f.hidden) f.x += dx;
          }
        }
      }
      xCursor += layer.w + COL_GAP;
    }
    this.layers = builtLayers;

    // AI is no longer rendered on the canvas
    this.aiNode.x = -99999;
    this.aiNode.y = -99999;
    this.refreshVisibleCaches();
    this.invalidate();
  }

  fit() {
    if (!this.layers.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const L of this.layers) {
      if (L.x < minX) minX = L.x;
      if (L.y < minY) minY = L.y;
      if (L.x + L.w > maxX) maxX = L.x + L.w;
      if (L.y + L.h > maxY) maxY = L.y + L.h;
    }
    const padX = 60, topPadCss = this.topOcclusion() + 10, botPadCss = this.bottomOcclusion() + 20;
    const usableH = Math.max(120, this.height - topPadCss - botPadCss);
    const usableW = Math.max(160, this.width - padX * 2);
    const w = (maxX - minX) || 1;
    const h = (maxY - minY) || 1;
    const zx = usableW / w;
    const zy = (usableH - 24) / h;
    const count = this.visibleNodeCount || this.files.size || 0;
    const minZoom = count > 700 ? 0.18 : count > 320 ? 0.22 : 0.25;
    const maxZoom = count <= 40 ? 1.85 : count <= 120 ? 1.55 : count <= 320 ? 1.35 : 1.2;
    this.cameraTarget.zoom = Math.max(minZoom, Math.min(maxZoom, zx, zy));
    this.cameraTarget.x = -(minX + maxX) / 2;
    // Keep the whole diagram inside the non-occluded canvas area when possible.
    const z = this.cameraTarget.zoom;
    const screenContentH = h * z;
    if (screenContentH <= usableH - 24) {
      const targetScreenCenterY = topPadCss + usableH / 2;
      this.cameraTarget.y = (targetScreenCenterY - this.height / 2) / z - (minY + maxY) / 2;
    } else {
      this.cameraTarget.y = ((topPadCss + 12) - this.height / 2) / z - minY;
    }
    this.cameraEase = 1;
    this.invalidate();
  }

  // Toggle which kinds render. Triggers a relayout. Used by the visibility filter.
  setVisibleKinds(kinds) {
    this.visibleKinds = new Set(kinds);
    this.relayout();
  }
  toggleKind(kind) {
    if (this.visibleKinds.has(kind)) this.visibleKinds.delete(kind);
    else this.visibleKinds.add(kind);
    this.relayout();
  }
  toggleSection(kind) {
    if (this.expandedSections.has(kind)) this.expandedSections.delete(kind);
    else this.expandedSections.add(kind);
    this.relayout();
  }

  // Cheap incremental graph mutations driven by the file-watcher.
  // - removeFile: drop a node + every edge touching it, then re-layout.
  // - addFileStub: insert a placeholder so a freshly-created file appears in
  //   the diagram immediately (it'll be replaced with full metadata on the
  //   next scan).
  removeFile(id) {
    if (!this.files.has(id)) return false;
    this.files.delete(id);
    if (this.fileEdges) {
      this.fileEdges = this.fileEdges.filter(e => e.source !== id && e.target !== id);
    }
    this.rebuildEdgeIndexes();
    if (this.importance) this.importance.delete(id);
    if (this.exportConsumers) {
      for (const k of [...this.exportConsumers.keys()]) {
        if (k.startsWith(id + '|')) this.exportConsumers.delete(k);
        else this.exportConsumers.get(k)?.delete(id);
      }
    }
    if (this.agentActivity) this.agentActivity.delete(id);
    if (this.selected && this.selected.id === id) this.selected = null;
    if (this.hovered && this.hovered.id === id) this.hovered = null;
    this.relayout();
    this.invalidate();
    return true;
  }

  addFileStub(id, hint = {}) {
    if (this.files.has(id)) return false;
    const baseName = id.split('/').pop();
    const file = {
      id,
      filename: baseName,
      label: hint.label || baseName,
      sublabel: hint.sublabel || '',
      kind: hint.kind || 'module',
      methods: null,
      exports: [],
      importsRefs: [],
      columns: null,
      parentFile: null,
      deadApiCalls: null,
      ext: hint.ext || ('.' + (baseName.split('.').pop() || '')),
      size: 0,
      dir: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
      x: 0, y: 0, w: 110, h: 24,
      glow: 0, lastTouched: 0,
    };
    file.searchText = this.searchTextFor(file);
    this.files.set(id, file);
    this.relayout();
    this.invalidate();
    return true;
  }

  searchTextFor(f) {
    let aliases = f.kind === 'table'
      ? ' sql database db table data read write insert update delete'
      : f.kind === 'schema'
        ? ' sql database schema migration data'
        : f.kind === 'model'
          ? ' database db model entity orm data'
          : f.kind === 'infra'
            ? ' docker terraform deploy deployment infra infrastructure vercel netlify compose'
            : f.kind === 'job'
              ? ' job worker queue cron background script'
              : f.kind === 'service'
                ? ' service server backend api process daemon'
                : f.kind === 'endpoint'
          ? ' api endpoint route server http get post put patch delete'
          : '';
    if (f.gitStatus && f.gitStatus.dirty) aliases += ' git dirty changed uncommitted modified';
    if (f.kind === 'table' && f.sqlStats) {
      if (f.sqlStats.read) aliases += ' reads read';
      if (f.sqlStats.write) aliases += ' writes write mutation changed';
      if (f.sqlStats.insert) aliases += ' insert';
      if (f.sqlStats.update) aliases += ' update';
      if (f.sqlStats.delete) aliases += ' delete';
    }
    return `${this.displayLabel(f)} ${f.id} ${f.kind}${aliases}`.toLowerCase();
  }

  setSearch(q) {
    this.searchQuery = (q || '').trim().toLowerCase();
    this.matchSet.clear();
    if (!this.searchQuery) {
      this.relayout();
      return;
    }
    const q2 = this.searchQuery;
    for (const f of this.files.values()) {
      if ((f.searchText || this.searchTextFor(f)).includes(q2)) this.matchSet.add(f.id);
    }
    this.relayout();
  }

  isFlowEdge(e) {
    return e && (
      e.type === 'api-call' ||
      e.type === 'db-query' ||
      e.type === 'endpoint-internal' ||
      e.type === 'fk'
    );
  }

  addEdgeIndex(map, key, edge) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(edge);
  }

  rebuildEdgeIndexes() {
    this.edgesBySource = new Map();
    this.edgesByTarget = new Map();
    this.flowEdgesBySource = new Map();
    this.flowEdgesByTarget = new Map();
    for (const e of this.fileEdges || []) {
      this.addEdgeIndex(this.edgesBySource, e.source, e);
      this.addEdgeIndex(this.edgesByTarget, e.target, e);
      if (this.isFlowEdge(e)) {
        this.addEdgeIndex(this.flowEdgesBySource, e.source, e);
        this.addEdgeIndex(this.flowEdgesByTarget, e.target, e);
      }
    }
    this.neighborhoodCache = null;
  }

  edgesForNodeSet(ids) {
    if (!ids || !ids.size) return [];
    const out = [];
    const seen = new Set();
    const add = (edges) => {
      for (const e of edges || []) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
      }
    };
    for (const id of ids) {
      add(this.edgesBySource.get(id));
      add(this.edgesByTarget.get(id));
    }
    return out;
  }

  // End-to-end neighborhood for hover/select highlighting. This follows the
  // real app flow across frontend callers, endpoints, SQL tables, and endpoint
  // internals instead of stopping at one hop.
  neighborhood(id) {
    if (this.neighborhoodCache && this.neighborhoodCache.id === id) return this.neighborhoodCache.set;
    const set = new Set([id]);
    const edgeBudget = 260;
    let used = 0;
    const walk = (start, dir) => {
      const q = [{ id: start, depth: 0 }];
      const seen = new Set([start]);
      while (q.length && used < edgeBudget) {
        const cur = q.shift();
        if (cur.depth >= 5) continue;
        const edges = dir === 'out'
          ? (this.flowEdgesBySource.get(cur.id) || [])
          : (this.flowEdgesByTarget.get(cur.id) || []);
        for (const e of edges) {
          const next = dir === 'out' ? e.target : e.source;
          const nf = this.files.get(next);
          if (!nf || nf.hidden) continue;
          used++;
          set.add(next);
          if (!seen.has(next)) {
            seen.add(next);
            q.push({ id: next, depth: cur.depth + 1 });
          }
        }
      }
    };
    walk(id, 'out');
    walk(id, 'in');

    // Keep immediate imports too, so regular file dependencies still light up,
    // but do not recursively import-walk the whole repo.
    for (const e of this.edgesBySource.get(id) || []) {
      if (e.type === 'import' || e.type === 'external') set.add(e.target);
    }
    for (const e of this.edgesByTarget.get(id) || []) {
      if (e.type === 'import' || e.type === 'external') set.add(e.source);
    }
    this.neighborhoodCache = { id, set };
    return set;
  }

  // All neighbors of any file in a section (for section hover/select)
  sectionNeighborhood(sectionKind) {
    const set = new Set();
    const inSection = new Set();
    for (const f of this.files.values()) {
      if (f.kind === sectionKind && !f.hidden) inSection.add(f.id);
    }
    for (const id of inSection) set.add(id);
    for (const id of inSection) {
      for (const e of this.edgesBySource.get(id) || []) set.add(e.target);
      for (const e of this.edgesByTarget.get(id) || []) set.add(e.source);
    }
    return set;
  }

  touch(targetId, kind = 'read', agent = null) {
    const f = this.files.get(targetId);
    if (!f) return;
    const now = performance.now();
    // Reads flash briefly; writes hold for ~1.5s so you don't miss them.
    // glowHoldUntil suppresses decay until that time has passed.
    if (kind === 'edit') {
      f.glow = 1.4;
      f.glowDecay = 0.965;             // slower fade after hold
      f.glowHoldUntil = now + 1500;    // 1.5s hold at full brightness
    } else {
      f.glow = 0.9;
      f.glowDecay = 0.985;             // quick fade
      f.glowHoldUntil = now + 120;     // brief flash
    }
    f.lastTouched = now;
    this.activeGlowIds.add(targetId);
    if (agent && agent.agentId) {
      let byAgent = this.agentActivity.get(targetId);
      if (!byAgent) {
        byAgent = new Map();
        this.agentActivity.set(targetId, byAgent);
      }
      const prev = byAgent.get(agent.agentId);
      byAgent.set(agent.agentId, {
        id: agent.agentId,
        label: agent.label || agent.agentId,
        color: agent.color || `rgba(${SAND}, 0.95)`,
        kind,
        last: now,
        count: (prev && prev.count ? prev.count : 0) + 1,
      });
      const ordered = [...byAgent.entries()].sort((a, b) => b[1].last - a[1].last);
      for (const [oldId] of ordered.slice(6)) byAgent.delete(oldId);
    }
    this.invalidate();
  }

  setReplacement(removed, added, title = '') {
    this.replaced = { removed: new Set(removed || []), added: new Set(added || []), title };
    this.invalidate();
  }
  setSummary() {}
  expand() {}
  panTo(id) {
    const f = this.files.get(id);
    if (!f) return;
    this.cameraTarget.x = -(f.x + f.w / 2);
    this.cameraTarget.y = -(f.y + f.h / 2);
    if (this.cameraTarget.zoom < 0.7) this.cameraTarget.zoom = 0.9;
    this.cameraEase = 1;
    this.invalidate();
  }

  // Zoom in close on a single node so its exports are readable inside the box
  // and we can show consumer-edge highlights.
  zoomToNode(id) {
    const f = this.files.get(id);
    if (!f) return;
    // Pick a zoom that gives the node ~340px on screen so the export pills fit
    const desiredScreenW = 340;
    this.cameraTarget.zoom = Math.max(1.4, Math.min(3, desiredScreenW / Math.max(60, f.w)));
    this.cameraTarget.x = -(f.x + f.w / 2);
    this.cameraTarget.y = -(f.y + f.h / 2);
    this.cameraEase = 1;
    this.invalidate();
  }

  zoomToSection(kind) {
    let s = null;
    for (const L of this.layers) for (const sec of L.sections) if (sec.kind === kind) { s = sec; break; }
    if (!s) return;
    const padX = 40, padY = 30;
    const zx = (this.width - padX * 2) / s.w;
    const zy = (this.height - padY * 2) / s.h;
    this.cameraTarget.zoom = Math.max(0.6, Math.min(1.6, Math.min(zx, zy)));
    this.cameraTarget.x = -(s.x + s.w / 2);
    this.cameraTarget.y = -(s.y + s.h / 2);
    this.cameraEase = 1;
    this.invalidate();
  }

  // Backwards-compat shims for app.js that referenced graph.modules / graph.boxes
  get boxes() { return new Map(); }
  get modules() { return new Map(); }

  frame() {
    this.frameScheduled = false;
    if (this.paused) {
      return;
    }
    const now = performance.now();
    let animating = this.cameraEase > 0;
    for (const id of this.activeGlowIds) {
      const f = this.files.get(id);
      if (!f) {
        this.activeGlowIds.delete(id);
        continue;
      }
      if (f.glow > 0.05) {
        // Hold the glow at full brightness until glowHoldUntil expires,
        // then decay using the per-touch decay rate.
        if (!f.glowHoldUntil || now >= f.glowHoldUntil) {
          f.glow *= (f.glowDecay != null ? f.glowDecay : 0.985);
        }
        animating = true;
      } else {
        f.glow = 0;
        this.activeGlowIds.delete(id);
        this.needsDraw = true;
      }
    }
    // Smooth camera toward target when easing is on (e.g. after fit/panTo)
    if (this.cameraEase > 0) {
      const k = 0.18;
      this.camera.x += (this.cameraTarget.x - this.camera.x) * k;
      this.camera.y += (this.cameraTarget.y - this.camera.y) * k;
      this.camera.zoom += (this.cameraTarget.zoom - this.camera.zoom) * k;
      const dx = Math.abs(this.cameraTarget.x - this.camera.x);
      const dy = Math.abs(this.cameraTarget.y - this.camera.y);
      const dz = Math.abs(this.cameraTarget.zoom - this.camera.zoom);
      if (dx < 0.5 && dy < 0.5 && dz < 0.005) {
        this.camera.x = this.cameraTarget.x;
        this.camera.y = this.cameraTarget.y;
        this.camera.zoom = this.cameraTarget.zoom;
        this.cameraEase = 0;
      }
    }
    if (this.needsDraw || animating) {
      this.draw(now);
      this.needsDraw = false;
    }
    if (animating || this.needsDraw) this.scheduleFrame();
  }

  // ===== Rendering =====
  draw(now) {
    syncGraphTheme();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const z = this.camera.zoom;
    ctx.setTransform(
      this.dpr * z, 0, 0, this.dpr * z,
      this.dpr * (this.width / 2 + this.camera.x * z),
      this.dpr * (this.height / 2 + this.camera.y * z)
    );

    const fastMode = now < (this.fastUntil || 0);
    const focusId = this.selected && this.selected.kind === 'file' ? this.selected.id : null;
    const hoverId = this.hovered && this.hovered.kind === 'file' ? this.hovered.id : null;
    const activeId = hoverId || focusId;
    const hoveredSection = this.hovered && this.hovered.kind === 'section' ? this.hovered.sectionKind : null;
    const selectedSection = this.selected && this.selected.kind === 'section' ? this.selected.sectionKind : null;
    const activeSection = hoveredSection || selectedSection;
    const hoveredExport = this.hovered && this.hovered.kind === 'export' ? this.hovered : null;

    // When an export pill is hovered, narrow the highlighted neighborhood to
    // just (focused file + that export's consumers) so the user sees ONLY who
    // uses that one function.
    let activeNeighborhood;
    if (fastMode) {
      activeNeighborhood = null;
    } else if (hoveredExport) {
      const consumers = this.exportConsumers.get(`${hoveredExport.fileId}|${hoveredExport.name}`);
      activeNeighborhood = new Set([hoveredExport.fileId, ...(consumers || [])]);
    } else if (activeId) {
      activeNeighborhood = this.neighborhood(activeId);
    } else if (activeSection) {
      activeNeighborhood = this.sectionNeighborhood(activeSection);
    } else {
      activeNeighborhood = null;
    }
    const isSearching = !!this.searchQuery;
    // Reset per-frame export pill registry (so hit-testing reflects current draw)
    this.exportPills.clear();

    const vb = this.visibleBounds();
    const inView = (x, y, w, h) => !(x + w < vb.minX || x > vb.maxX || y + h < vb.minY || y > vb.maxY);
    // For an edge between a and b, cull by the union of their boxes — that's
    // the actual bbox the line passes through. Keep this allocation-free in
    // the draw loop; large repos can have thousands of edges.
    const edgeInView = (a, b) => {
      const minX = Math.min(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxX = Math.max(a.x + a.w, b.x + b.w);
      const maxY = Math.max(a.y + a.h, b.y + b.h);
      return !(maxX < vb.minX || minX > vb.maxX || maxY < vb.minY || minY > vb.maxY);
    };

    // ----- Section headers (cthdrl: ghost-sand mono labels, thin rules) -----
    for (const L of this.layers) {
      ctx.font = `400 11px ${FONT_MONO}`;
      ctx.fillStyle = L.id === 'data' ? tintRGB('table', 0.85) : `rgba(${SAND}, 0.55)`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(L.id === 'data' ? 'DATA / SQL' : L.name, L.x, L.y - 24);
      // vertical rule on the column's left
      ctx.strokeStyle = L.id === 'data' ? tintRGB('table', 0.35) : `rgba(${SAND}, 0.14)`;
      ctx.lineWidth = 1 / z;
      ctx.beginPath();
      ctx.moveTo(L.x - 14, L.y - 8);
      ctx.lineTo(L.x - 14, L.y + L.h + 8);
      ctx.stroke();
      for (const s of L.sections) {
        const isHoverSection = this.hovered && this.hovered.kind === 'section' && this.hovered.sectionKind === s.kind;
        const tint = tintRGB(s.kind);
        ctx.fillStyle = tint;
        ctx.fillRect(s.x + 2, s.y + 4, 8, 8);
        ctx.font = `400 13px ${FONT_MONO}`;
        ctx.fillStyle = tint;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const title = s.name.toUpperCase();
        const titleX = s.x + 16;
        ctx.fillText(title, titleX, s.y);
        const titleW = ctx.measureText(title).width;
        ctx.font = `400 11px ${FONT_MONO}`;
        ctx.fillStyle = `rgba(${SAND}, ${isHoverSection ? 0.7 : 0.45})`;
        const countLabel = s.allCount && s.allCount !== s.files.length
          ? `× ${s.files.length}/${s.allCount}`
          : `× ${s.files.length}`;
        ctx.fillText(countLabel, titleX + titleW + 12, s.y + 2);
        ctx.strokeStyle = isHoverSection ? tint : tintRGB(s.kind, 0.30);
        ctx.lineWidth = (isHoverSection ? 1.5 : 1) / z;
        ctx.beginPath();
        ctx.moveTo(s.x + 2, s.y + 20);
        ctx.lineTo(s.x + s.w - 4, s.y + 20);
        ctx.stroke();
        // Sections show everything now — no "+N more" / "collapse" affordance.
      }
    }

    // ----- Edges (cthdrl: monochrome, vary by alpha + dash) -----
    // Encoding (no color, all sand):
    //   import, cross-kind  → solid, bright
    //   import, within-kind → solid, quiet
    //   api-call            → dashed, bright (always)
    const anyActive = !!(activeNeighborhood || isSearching);
    let drawCount = { api: 0, fk: 0, dbq: 0, internal: 0, imp: 0, skipped: 0, total: 0 };
    if (!fastMode) {
      for (const e of this.visibleEdges) {
        drawCount.total++;
        const a = this.files.get(e.source);
        const b = this.files.get(e.target);
        if (!a || !b) { drawCount.skipped++; continue; }
        if (!edgeInView(a, b)) { drawCount.skipped++; continue; }
        if (e.isApiCall) drawCount.api++;
        else if (e.isFk) drawCount.fk++;
        else if (e.isDbQuery) drawCount.dbq++;
        else if (e.isEndpointInternal) drawCount.internal++;
        else drawCount.imp++;

        const isHighlighted =
          (activeNeighborhood && activeNeighborhood.has(a.id) && activeNeighborhood.has(b.id)) ||
          (isSearching && (this.matchSet.has(a.id) || this.matchSet.has(b.id)));
        if (isHighlighted) continue;

        const crossKind = a.kind !== b.kind;
        const aLayer = LAYER_OF_KIND[a.kind] || 'support';
        const bLayer = LAYER_OF_KIND[b.kind] || 'support';
        const crossLayer = aLayer !== bLayer;
        let alpha, lineW, dashed = false;
        if (e.isFk) {
          alpha = anyActive ? 0.08 : 0.28;
          lineW = 0.9 / z;
        } else if (e.isDbQuery) {
          // Endpoint → Table: clearly distinct from imports
          alpha = anyActive ? 0.08 : 0.30;
          lineW = 0.9 / z;
          dashed = true;
        } else if (e.isEndpointInternal) {
          alpha = anyActive ? 0.04 : 0.14;
          lineW = 0.9 / z;
          dashed = true;
        } else if (e.isApiCall) {
          // Page/Component/Hook/Store → Endpoint flow. Keep passive flows quiet;
          // active selection/hover redraws them on top later.
          const direct = !e.isTransitive;
          alpha = anyActive ? 0.045 : (direct ? 0.34 : 0.16);
          lineW = (direct ? 1.0 : 0.75) / z;
          dashed = true;
        } else if (crossLayer) {
          // Any non-api edge that crosses architectural layers
          alpha = anyActive ? 0.04 : 0.18;
          lineW = 0.8 / z;
        } else if (crossKind) {
          // Within same layer, between kinds (e.g. Page→Component)
          alpha = anyActive ? 0.03 : 0.12;
          lineW = 0.7 / z;
        } else {
          alpha = anyActive ? 0.015 : 0.045;
          lineW = 0.6 / z;
        }
        // Edge color = source kind tint, with sand fallback
        ctx.strokeStyle = tintRGB(a.kind, alpha);
        ctx.lineWidth = lineW;
        if (dashed) ctx.setLineDash([5 / z, 4 / z]);
        this.drawEdge(ctx, a, b, false, e);
        if (dashed) ctx.setLineDash([]);
      }
    }

    // ----- Nodes -----
    for (const f of this.visibleFiles) {
      if (!inView(f.x, f.y, f.w, f.h)) continue;
      const isSel = focusId === f.id;
      const isHover = hoverId === f.id;
      const inHood = activeNeighborhood && activeNeighborhood.has(f.id);
      const isMatch = isSearching && this.matchSet.has(f.id);
      const dimmed = (activeId && !inHood) || (isSearching && !isMatch);

      // Tables render as ER cards
      if (f.kind === 'table') {
        const tableDimmed = (isSearching && !isMatch) || (activeId && !inHood && !isSearching);
        this.drawTableCard(ctx, f, { isSel, isHover, dimmed: tableDimmed, isMatch, z, vb, fast: fastMode });
        continue;
      }

      const isRemoved = this.replaced.removed.has(f.id);
      const isAdded = this.replaced.added.has(f.id);

      const baseAlpha = dimmed ? 0.10 : 1;

      // Body — solid black, optionally inverted on selection (tint fill)
      if (isSel) {
        ctx.fillStyle = tintRGB(f.kind);
      } else {
        ctx.fillStyle = CANVAS_BG;
      }
      ctx.fillRect(f.x, f.y, f.w, f.h);

      // Left tint stripe — kind color, gives instant visual differentiation
      if (!isSel) {
        ctx.fillStyle = tintRGB(f.kind, dimmed ? 0.35 : 0.85);
        ctx.fillRect(f.x, f.y, 3 / z, f.h);
      }

      // Glow when AI touches
      if (f.glow > 0.05) {
        ctx.strokeStyle = tintRGB(f.kind, 0.95 * f.glow);
        ctx.lineWidth = 2 / z;
        ctx.strokeRect(f.x - 2/z, f.y - 2/z, f.w + 4/z, f.h + 4/z);
      }

      // Border
      let borderAlpha;
      let useTint = false;
      if (isSel) { borderAlpha = 1.0; useTint = true; }
      else if (isHover) { borderAlpha = 0.95; useTint = true; }
      else if (inHood) { borderAlpha = 0.85; useTint = true; }
      else if (isMatch) borderAlpha = 1.0;
      else borderAlpha = dimmed ? 0.18 : 0.42;
      ctx.strokeStyle = useTint ? tintRGB(f.kind, borderAlpha) : `rgba(${SAND}, ${borderAlpha})`;
      ctx.lineWidth = (isSel || isHover || isMatch ? 1.4 : 1) / z;
      ctx.strokeRect(f.x, f.y, f.w, f.h);
      this.drawAgentActivity(ctx, f, { z, dimmed, selectedLike: isSel || isHover || isMatch || inHood });

      // Removed: diagonal line through
      if (isRemoved) {
        ctx.strokeStyle = `rgba(${SAND}, 0.85)`;
        ctx.lineWidth = 1 / z;
        ctx.beginPath();
        ctx.moveTo(f.x + 4, f.y + 4);
        ctx.lineTo(f.x + f.w - 4, f.y + f.h - 4);
        ctx.stroke();
      }
      // Added: filled left stripe (full sand)
      if (isAdded) {
        ctx.fillStyle = `rgba(${SAND}, 0.95)`;
        ctx.fillRect(f.x, f.y, 3 / z, f.h);
      }

      // Label — proportional to the box. At very distant zoom levels the
      // graph becomes structural blocks; text returns as the user opens it up.
      const showLabel = (
        (f.kind === 'endpoint' && z >= 0.20) ||
        z >= this.OVERVIEW_LABEL_ZOOM ||
        isSel || isHover || isMatch
      );
      if (showLabel) {
        ctx.fillStyle = isSel ? INVERT_TEXT : `rgba(${SAND}, ${dimmed ? 0.55 : 0.95})`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        if (f.kind === 'endpoint' && f._endpointCompact) {
          const st = f.endpointStats || { ui: 0, backend: 0, db: 0, internal: 0 };
          const verb = f._endpointVerb || endpointVerbOf(f) || 'API';
          const path = f._endpointPath || endpointPathOf(f);
          ctx.font = `400 12px ${FONT_MONO}`;
          ctx.fillText(this.truncate(ctx, verb, f.w - 18), f.x + 10, f.y + 14);
          ctx.font = `400 10px ${FONT_MONO}`;
          ctx.fillStyle = isSel ? INVERT_TEXT : `rgba(${SAND}, ${dimmed ? 0.42 : 0.72})`;
          ctx.fillText(this.truncate(ctx, path, f.w - 18), f.x + 10, f.y + 29);
          const meta = `UI ${st.ui} DB ${st.db}`;
          ctx.fillStyle = isSel ? INVERT_TEXT : tintRGB(f.kind, dimmed ? 0.45 : 0.78);
          ctx.fillText(this.truncate(ctx, meta, f.w - 18), f.x + 10, f.y + f.h - 9);
        } else {
          ctx.font = `400 12px ${FONT_MONO}`;
          const lines = f._labelLines && f._labelLines.length ? f._labelLines : [this.displayLabel(f)];
          const lineH = 14;
          const blockH = lines.length * lineH;
          const metaH = f.kind === 'endpoint' ? 15 : 0;
          const labelAreaH = f.h - metaH;
          const startY = f.y + labelAreaH / 2 - blockH / 2 + lineH / 2;
          const labelMaxW = f.w - 18;
          for (let i = 0; i < lines.length; i++) {
            const written = ctx.measureText(lines[i]).width <= labelMaxW
              ? lines[i]
              : this.truncate(ctx, lines[i], labelMaxW);
            ctx.fillText(written, f.x + 12, startY + i * lineH + 0.5);
          }
          if (f.kind === 'endpoint') {
            const st = f.endpointStats || { ui: 0, backend: 0, db: 0, internal: 0 };
            const meta = `UI ${st.ui} · API ${st.backend} · DB ${st.db} · USES ${st.internal}`;
            ctx.font = `400 10px ${FONT_MONO}`;
            ctx.fillStyle = isSel ? INVERT_TEXT : tintRGB(f.kind, dimmed ? 0.5 : 0.82);
            ctx.textBaseline = 'middle';
            ctx.fillText(this.truncate(ctx, meta, f.w - 18), f.x + 12, f.y + f.h - 9);
          }
        }
      }

      // Dead-call badge — small "!N" on the right edge for files with
      // unresolved API calls.
      if (!fastMode && f.deadApiCalls && f.deadApiCalls.length) {
        const badge = `! ${f.deadApiCalls.length}`;
        ctx.font = `400 10px ${FONT_MONO}`;
        const tw = ctx.measureText(badge).width;
        const bx = f.x + f.w - tw - 8;
        const by = f.y + 3;
        ctx.fillStyle = `rgba(${SAND}, 1)`;
        ctx.fillRect(bx - 3, by, tw + 6, 12);
        ctx.fillStyle = INVERT_TEXT;
        ctx.fillText(badge, bx, by + 9);
      }
      if (!fastMode) this.drawMapBadges(ctx, f, { z, dimmed, selectedLike: isSel || isHover || isMatch || inHood });
    }

    // Highlighted edges are the only lines allowed above boxes. Passive lines
    // stay behind the node fills so labels and SQL cards remain readable.
    if (!fastMode) {
      const highlightCandidates = activeNeighborhood && !isSearching
        ? this.edgesForNodeSet(activeNeighborhood)
        : this.visibleEdges;
      for (const e of highlightCandidates) {
        const a = this.files.get(e.source);
        const b = this.files.get(e.target);
        if (!a || !b || a.hidden || b.hidden) continue;
        if (!edgeInView(a, b)) continue;
        const isHighlighted =
          (activeNeighborhood && activeNeighborhood.has(a.id) && activeNeighborhood.has(b.id)) ||
          (isSearching && (this.matchSet.has(a.id) || this.matchSet.has(b.id)));
        if (!isHighlighted) continue;
        ctx.strokeStyle = tintRGB(a.kind, 0.95);
        ctx.lineWidth = 1.8 / z;
        if (e.isApiCall || e.isDbQuery || e.isEndpointInternal) ctx.setLineDash([5 / z, 4 / z]);
        this.drawEdge(ctx, a, b, true, e);
        if (e.isApiCall || e.isDbQuery || e.isEndpointInternal) ctx.setLineDash([]);
        if (e.isDbQuery) {
          const label = this.dbOpsLabel(e);
          if (label) this.drawEdgeLabel(ctx, a, b, label, z, tintRGB('table', 0.95));
        }
      }
    }

    // ----- Function call-graph (when a file is focused) -----
    // Renders a panel of the focused file's exports right next to its box.
    // For each export with consumers, a line is drawn from the pill to every
    // file that imports that name. Hover an export to filter to just it.
    if (!fastMode && focusId && z >= this.DETAIL_ZOOM) {
      const f = this.files.get(focusId);
      if (f && !f.hidden && f.exports && f.exports.length) {
        const pills = this.layoutExportPills(f, ctx);
        this.exportPills.set(focusId, pills);

        // Pass 1: draw the connector lines BEHIND the pills, so the pills
        // visually sit on top.
        for (const p of pills) {
          const isHE = hoveredExport && hoveredExport.fileId === focusId && hoveredExport.name === p.name;
          const consumers = this.exportConsumers.get(`${focusId}|${p.name}`);
          if (!consumers || !consumers.size) continue;
          // If a different export is hovered, fade everything else
          const fadeForHover = hoveredExport && !isHE;
          const baseAlpha = fadeForHover ? 0.05 : (isHE ? 1 : 0.55);
          ctx.lineWidth = (isHE ? 1.6 : 1) / z;

          for (const consumerId of consumers) {
            const c = this.files.get(consumerId);
            if (!c || c.hidden) continue;
            // Endpoint A: right-middle of the pill
            const ax = p.x + p.w;
            const ay = p.y + p.h / 2;
            // Endpoint B: nearest edge of the consumer's box
            const cMidX = c.x + c.w / 2;
            const dx = cMidX - ax;
            const bx = (dx >= 0) ? c.x : c.x + c.w;
            const by = c.y + c.h / 2;
            ctx.strokeStyle = `rgba(${SAND}, ${baseAlpha})`;
            const cpOff = Math.max(40, Math.abs(dx) * 0.4);
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.bezierCurveTo(ax + cpOff, ay, bx - Math.sign(dx || 1) * cpOff, by, bx, by);
            ctx.stroke();
            // Arrowhead
            const arrowAng = Math.atan2(by - by, bx - (bx - Math.sign(dx || 1) * cpOff));
            const ahLen = 6 / z;
            const ux = Math.sign(dx || 1);
            ctx.fillStyle = `rgba(${SAND}, ${baseAlpha})`;
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(bx - ux * ahLen, by - ahLen * 0.6);
            ctx.lineTo(bx - ux * ahLen, by + ahLen * 0.6);
            ctx.closePath();
            ctx.fill();
          }
        }

        // Pass 2: pills on top with hover/count indicators
        for (const p of pills) {
          const isHE = hoveredExport && hoveredExport.fileId === focusId && hoveredExport.name === p.name;
          const fadeForHover = hoveredExport && !isHE;
          const consumers = this.exportConsumers.get(`${focusId}|${p.name}`);
          const cnt = consumers ? consumers.size : 0;
          ctx.fillStyle = isHE
            ? `rgba(${SAND}, 0.96)`
            : bgAlpha(fadeForHover ? 0.4 : 0.85);
          ctx.fillRect(p.x, p.y, p.w, p.h);
          ctx.strokeStyle = isHE ? `rgba(${SAND}, 1)` : `rgba(${SAND}, ${fadeForHover ? 0.22 : (cnt ? 0.85 : 0.4)})`;
          ctx.lineWidth = (isHE ? 1.4 : 1) / z;
          ctx.strokeRect(p.x, p.y, p.w, p.h);
          ctx.fillStyle = isHE ? INVERT_TEXT : `rgba(${SAND}, ${fadeForHover ? 0.45 : 0.95})`;
          ctx.font = `400 11px ${FONT_MONO}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const labelText = (p.name + (p.kind === 'function' ? '()' : ''));
          ctx.fillText(this.truncate(ctx, labelText, p.w - 30), p.x + 6, p.y + p.h / 2 + 0.5);
          // Consumer count chip on the right
          if (cnt) {
            ctx.textAlign = 'right';
            ctx.fillStyle = isHE ? INVERT_TEXT : `rgba(${SAND}, ${fadeForHover ? 0.45 : 0.7})`;
            ctx.fillText(`→ ${cnt}`, p.x + p.w - 6, p.y + p.h / 2 + 0.5);
          }
        }
        // Connector from focused-file box to the first pill
        if (pills.length) {
          ctx.strokeStyle = `rgba(${SAND}, 0.45)`;
          ctx.lineWidth = 0.8 / z;
          ctx.beginPath();
          ctx.moveTo(f.x + f.w, f.y + f.h / 2);
          ctx.lineTo(pills[0].x - 2, pills[0].y + pills[0].h / 2);
          ctx.stroke();
        }
      }
    }

    // ----- AI activity now shows only as a transient glow on the touched node ----- //
    // (No flying lines from an AI orb — the orb was removed.)
    this.pulses = this.pulses.filter(p => (now - p.start) < p.duration);

    // ----- Edge debug HUD (top-right) -----
    if (this.debugEdges) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const diag = `${drawCount.total} edges · ${drawCount.api} API · ${drawCount.fk} FK · ${drawCount.dbq} DB · ${drawCount.internal} internal · ${drawCount.imp} import · ${drawCount.skipped} skipped`;
      ctx.font = `400 11px ${FONT_MONO}`;
      const tw = ctx.measureText(diag).width;
      const cssW = this.canvas.width / this.dpr;
      const bx = cssW - tw - 24;
      const by = cssW > 800 ? 60 : 92;
      ctx.fillStyle = bgAlpha(0.78);
      ctx.fillRect(bx - 8, by - 6, tw + 16, 22);
      ctx.fillStyle = `rgba(${SAND}, 0.85)`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(diag, bx, by + 5);
    }

    // ----- Banner (overlay coords) -----
    if (focusId || this.replaced.removed.size || this.replaced.added.size) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const focused = focusId ? this.files.get(focusId) : null;
      const banner = focused
        ? `${this.displayLabel(focused)}  ·  ${focused.id}  ·  CLICK EMPTY TO EXIT`
        : `${this.replaced.title}  ·  −${this.replaced.removed.size}  +${this.replaced.added.size}`;
      ctx.font = `400 11px ${FONT_MONO}`;
      const cssW = this.canvas.width / this.dpr;
      const maxTextW = Math.max(140, cssW - 78);
      const bannerText = ctx.measureText(banner).width <= maxTextW
        ? banner
        : this.truncate(ctx, banner, maxTextW);
      const tw = Math.min(cssW - 52, ctx.measureText(bannerText).width + 26);
      const bx = cssW / 2 - tw / 2;
      const by = this.topOcclusion() + 8;
      ctx.fillStyle = CANVAS_BG;
      ctx.fillRect(bx, by, tw, 28);
      ctx.strokeStyle = `rgba(${SAND}, 1)`;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, by, tw, 28);
      ctx.fillStyle = `rgba(${SAND}, 1)`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(bannerText, bx + tw / 2, by + 14);
    }
  }

  gitBadgeLabel(f) {
    const s = f && f.gitStatus;
    if (!s || !s.dirty) return '';
    if (s.untracked) return 'G ?';
    if (s.deleted) return 'G D';
    const code = String(s.code || '').replace(/\s/g, '');
    return `G ${code || 'M'}`;
  }

  dbOpsLabel(edge) {
    const ops = (edge && edge.dbOps && edge.dbOps.length)
      ? edge.dbOps
      : (edge && edge.operations) || [];
    const map = { read: 'READ', insert: 'INSERT', update: 'UPDATE', delete: 'DELETE', touch: 'TOUCH' };
    return ops.map(op => map[op] || String(op).toUpperCase()).join(' / ');
  }

  sqlStatsLabel(f) {
    const st = f && f.sqlStats;
    if (!st) return '';
    const parts = [];
    if (st.read) parts.push(`R ${st.read}`);
    if (st.write) parts.push(`W ${st.write}`);
    if (st.insert || st.update || st.delete) {
      const changes = [
        st.insert ? `I ${st.insert}` : '',
        st.update ? `U ${st.update}` : '',
        st.delete ? `D ${st.delete}` : '',
      ].filter(Boolean).join(' ');
      if (changes) parts.push(changes);
    }
    return parts.join(' · ');
  }

  agentMarksFor(f) {
    const byAgent = f && this.agentActivity.get(f.id);
    if (!byAgent) return [];
    return [...byAgent.values()].sort((a, b) => b.last - a.last).slice(0, 6);
  }

  drawAgentActivity(ctx, f, { z, dimmed = false, selectedLike = false } = {}) {
    const marks = this.agentMarksFor(f);
    if (!marks.length) return;
    ctx.save();
    ctx.globalAlpha = dimmed ? 0.58 : 1;
    ctx.lineJoin = 'miter';
    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i];
      const offset = (2 + i * 2) / z;
      ctx.strokeStyle = mark.color || `rgba(${SAND}, 0.95)`;
      ctx.lineWidth = (mark.kind === 'edit' ? 1.8 : 1.05) / z;
      if (mark.kind === 'edit') ctx.setLineDash([]);
      else ctx.setLineDash([4 / z, 3 / z]);
      ctx.strokeRect(f.x - offset, f.y - offset, f.w + offset * 2, f.h + offset * 2);
    }
    ctx.setLineDash([]);

    const tickW = 7 / z;
    const tickH = 3 / z;
    let x = f.x + 6 / z;
    for (const mark of marks.slice(0, 6)) {
      ctx.fillStyle = mark.color || `rgba(${SAND}, 0.95)`;
      ctx.fillRect(x, f.y + 2 / z, tickW, tickH);
      x += tickW + 3 / z;
      if (x > f.x + f.w - 8 / z) break;
    }
    ctx.restore();
  }

  drawMapBadges(ctx, f, { z, dimmed = false, selectedLike = false } = {}) {
    const badges = [];
    const git = this.gitBadgeLabel(f);
    if (git) badges.push({ text: git, short: 'G', alpha: dimmed ? 0.35 : 0.86 });
    if (f.kind === 'table') {
      const sql = this.sqlStatsLabel(f);
      if (sql) badges.push({ text: sql, short: f.sqlStats && f.sqlStats.write ? 'W' : 'R', alpha: dimmed ? 0.34 : 0.78, table: true });
    }
    if (!badges.length) return;

    const showText = selectedLike || z >= 0.86;
    const yOffset = (f.deadApiCalls && f.deadApiCalls.length && f.kind !== 'table') ? 19 / z : 5 / z;
    if (!showText) {
      let y = f.y + yOffset;
      const x = f.x + f.w - 8 / z;
      for (const b of badges.slice(0, 4)) {
        ctx.fillStyle = b.table ? tintRGB('table', b.alpha) : `rgba(${SAND}, ${b.alpha})`;
        ctx.fillRect(x, y, 5 / z, 5 / z);
        y += 8 / z;
      }
      return;
    }

    ctx.font = `400 10px ${FONT_MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let x = f.x + f.w - 5 / z;
    const y = f.y + yOffset;
    for (const b of badges.slice(0, 3).reverse()) {
      const text = b.text;
      const w = Math.min(f.w - 12 / z, ctx.measureText(text).width + 8 / z);
      const h = 13 / z;
      x -= w;
      ctx.fillStyle = CANVAS_BG;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = b.table ? tintRGB('table', b.alpha) : `rgba(${SAND}, ${b.alpha})`;
      ctx.lineWidth = 1 / z;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = b.table ? tintRGB('table', b.alpha) : `rgba(${SAND}, ${b.alpha})`;
      ctx.fillText(this.truncate(ctx, text, w - 6 / z), x + 4 / z, y + h / 2 + 0.5 / z);
      x -= 4 / z;
      if (x < f.x + 4 / z) break;
    }
  }

  drawEdgeLabel(ctx, a, b, text, z, color) {
    if (!text) return;
    const ax = a.x + a.w / 2;
    const ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2;
    const by = b.y + b.h / 2;
    const x = (ax + bx) / 2;
    const y = (ay + by) / 2;
    ctx.font = `400 10px ${FONT_MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const pad = 5 / z;
    const h = 15 / z;
    const w = ctx.measureText(text).width + pad * 2;
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.strokeStyle = color || `rgba(${SAND}, 0.9)`;
    ctx.lineWidth = 1 / z;
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    ctx.fillStyle = color || `rgba(${SAND}, 0.9)`;
    ctx.fillText(text, x - w / 2 + pad, y + 0.5 / z);
  }

  // ER-style table card: header bar (subtle), column rows below.
  // Visually consistent with other cthdrl cards — black bg, 1px sand stroke,
  // monospace text. Header is set apart by a horizontal rule, not a fill.
  drawTableCard(ctx, f, { isSel, isHover, dimmed, isMatch, z, vb, fast = false }) {
    const headerH = 26, rowH = 17;
    const baseAlpha = dimmed ? 0.58 : 1;
    const overview = z < this.TABLE_DETAIL_ZOOM && !isSel && !isHover && !isMatch;

    ctx.globalAlpha = baseAlpha;

    // Card body — black fill with a faint SQL tint so data nodes do not read
    // like generic files at a glance.
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.fillStyle = tintRGB('table', dimmed ? 0.025 : 0.06);
    ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.fillStyle = tintRGB('table', dimmed ? 0.42 : 0.95);
    ctx.fillRect(f.x, f.y, 4 / z, f.h);

    if (fast) {
      ctx.fillStyle = tintRGB('table', dimmed ? 0.72 : 1);
      ctx.font = `400 13px ${FONT_MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const tableLbl = (f.label || '').toUpperCase();
      ctx.fillText(this.truncate(ctx, tableLbl, f.w - 20), f.x + 10, f.y + Math.min(f.h - 12, headerH / 2 + 0.5));
      ctx.strokeStyle = tintRGB('table', isSel || isHover || isMatch ? 0.95 : (dimmed ? 0.16 : 0.42));
      ctx.lineWidth = (isSel || isHover ? 1.4 : 1) / z;
      ctx.strokeRect(f.x, f.y, f.w, f.h);
      this.drawAgentActivity(ctx, f, { z, dimmed, selectedLike: isSel || isHover || isMatch });
      ctx.globalAlpha = 1;
      return;
    }

    // Header text — sand, mono, uppercase
    ctx.fillStyle = tintRGB('table', dimmed ? 0.72 : 1);
    const overviewTitleSize = Math.min(13 / z, Math.max(24, f.h * 0.32));
    const overviewMetaSize = Math.min(11 / z, Math.max(20, f.h * 0.24));
    ctx.font = `400 ${overview ? overviewTitleSize : 13}px ${FONT_MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const tableLbl = (f.label || '').toUpperCase();
    const cnt = (f.columns || []).length;
    const sqlStats = this.sqlStatsLabel(f);
    const showStatsInHeader = sqlStats && (isSel || isHover || isMatch || z >= this.TABLE_DETAIL_ZOOM);
    ctx.fillText(this.truncate(ctx, tableLbl, showStatsInHeader ? f.w * 0.42 : f.w - 88), f.x + 10, f.y + headerH / 2 + 0.5);
    ctx.textAlign = 'right';
    ctx.fillStyle = tintRGB('table', dimmed ? 0.5 : 0.78);
    ctx.font = `400 ${overview ? overviewMetaSize : 13}px ${FONT_MONO}`;
    const rightLabel = showStatsInHeader
      ? `SQL × ${cnt} · ${sqlStats}`
      : `SQL × ${cnt}`;
    ctx.fillText(this.truncate(ctx, rightLabel, f.w * 0.55), f.x + f.w - 8, f.y + headerH / 2 + 0.5);

    // Header underline rule
    ctx.strokeStyle = tintRGB('table', dimmed ? 0.18 : 0.55);
    ctx.lineWidth = 1 / z;
    ctx.beginPath();
    ctx.moveTo(f.x, f.y + headerH);
    ctx.lineTo(f.x + f.w, f.y + headerH);
    ctx.stroke();

    // Column rows — preview by default, expanded only when the table is opened.
    // At overview zoom, rows are intentionally suppressed so SQL stays fast and
    // the table label remains legible instead of becoming a gray texture.
    if (overview) {
      ctx.fillStyle = `rgba(${SAND}, ${dimmed ? 0.42 : 0.62})`;
      ctx.font = `400 ${Math.min(10 / z, Math.max(18, f.h * 0.2))}px ${FONT_MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const summary = `${cnt} columns${sqlStats ? ` · ${sqlStats}` : ''}${f._moreCount ? ` · +${f._moreCount} more` : ''}`;
      ctx.fillText(this.truncate(ctx, summary, f.w - 20), f.x + 10, f.y + Math.min(f.h - 12, headerH + 17));
    } else {
    ctx.font = `400 11px ${FONT_MONO}`;
    ctx.textBaseline = 'middle';
    const cols = f._visibleCols || f.columns || [];
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const ry = f.y + headerH + i * rowH;
      if (vb && (ry + rowH < vb.minY || ry > vb.maxY)) continue;
      if (i > 0) {
        ctx.strokeStyle = tintRGB('table', dimmed ? 0.05 : 0.12);
        ctx.lineWidth = 1 / z;
        ctx.beginPath();
        ctx.moveTo(f.x + 8, ry);
        ctx.lineTo(f.x + f.w - 8, ry);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(${SAND}, ${dimmed ? 0.45 : 0.92})`;
      ctx.textAlign = 'left';
      let nameTxt = col.name;
      if (col.pk) nameTxt = '◆ ' + nameTxt;
      else if (col.fk) nameTxt = '↗ ' + nameTxt;
      ctx.fillText(this.truncate(ctx, nameTxt, f.w * 0.6 - 12), f.x + 10, ry + rowH / 2 + 0.5);
      ctx.fillStyle = tintRGB('table', dimmed ? 0.28 : 0.58);
      ctx.textAlign = 'right';
      ctx.fillText(this.truncate(ctx, col.type, f.w * 0.4 - 12), f.x + f.w - 10, ry + rowH / 2 + 0.5);
    }
    }

    if (f._showFooter && !f._tableExpanded) {
      const isHoverFooter = this.hovered && this.hovered.kind === 'table-toggle' && this.hovered.id === f.id;
      ctx.font = `400 10px ${FONT_MONO}`;
      ctx.fillStyle = tintRGB('table', isHoverFooter ? 1 : 0.72);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+ ${f._moreCount} columns · click to expand`, f.x + 10, f.y + f.h - 10);
      ctx.strokeStyle = tintRGB('table', 0.16);
      ctx.lineWidth = 1 / z;
      ctx.beginPath();
      ctx.moveTo(f.x + 8, f.y + f.h - 20);
      ctx.lineTo(f.x + f.w - 8, f.y + f.h - 20);
      ctx.stroke();
    } else if (f._showFooter && f._tableExpanded) {
      const isHoverFooter = this.hovered && this.hovered.kind === 'table-toggle' && this.hovered.id === f.id;
      ctx.font = `400 10px ${FONT_MONO}`;
      ctx.fillStyle = tintRGB('table', isHoverFooter ? 1 : 0.62);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('show fewer columns', f.x + 10, f.y + f.h - 10);
    }

    // Border
    let borderAlpha;
    if (isSel) borderAlpha = 1;
    else if (isHover) borderAlpha = 0.85;
    else if (isMatch) borderAlpha = 1;
    else borderAlpha = dimmed ? 0.18 : 0.55;
    ctx.strokeStyle = tintRGB('table', borderAlpha);
    ctx.lineWidth = (isSel || isHover ? 1.4 : 1) / z;
    ctx.strokeRect(f.x, f.y, f.w, f.h);

    ctx.globalAlpha = 1;
    this.drawAgentActivity(ctx, f, { z, dimmed, selectedLike: isSel || isHover || isMatch });
    this.drawMapBadges(ctx, f, { z, dimmed, selectedLike: isSel || isHover || isMatch });
  }

  // Lay out export pills as a vertical "function panel" attached to the right
  // edge of the focused node. Each pill is a single row so its outgoing
  // connector lines don't tangle.
  layoutExportPills(f, ctx) {
    ctx.font = `400 11px ${FONT_MONO}`;
    const exports = (f.exports || []).slice(0, 30);
    if (!exports.length) return [];
    const pillH = 22;
    const rowGap = 3;
    // Width = widest export label + count chip
    let maxLabelW = 0;
    for (const e of exports) {
      const lbl = e.name + (e.kind === 'function' ? '()' : '');
      const w = ctx.measureText(lbl).width;
      if (w > maxLabelW) maxLabelW = w;
    }
    const pillW = Math.min(280, Math.max(140, Math.ceil(maxLabelW + 70))); // room for "→ N"
    const totalH = exports.length * pillH + (exports.length - 1) * rowGap;
    // Place panel just right of the file box; y-centered on the file
    const startX = f.x + f.w + 24;
    const startY = f.y + f.h / 2 - totalH / 2;
    const pills = [];
    for (let i = 0; i < exports.length; i++) {
      const e = exports[i];
      pills.push({
        name: e.name, kind: e.kind,
        x: startX,
        y: startY + i * (pillH + rowGap),
        w: pillW,
        h: pillH,
      });
    }
    return pills;
  }

  drawEdge(ctx, a, b, withArrow = false, edge = null) {
    // FK edges between two table nodes — orthogonal routing so the line goes
    // around tables, never through. Source: leaves FK column horizontally,
    // jogs vertically through the corridor between table rows, then enters
    // target's PK column horizontally.
    if (edge && edge.isFk && a.kind === 'table' && b.kind === 'table') {
      const headerH = 26, rowH = 17;
      const aCols = a._visibleCols || a.columns || [];
      const bCols = b._visibleCols || b.columns || [];
      const arow = aCols.findIndex(c => c.name === edge.column);
      const brow = bCols.findIndex(c => c.name === edge.targetColumn);
      const ay = arow >= 0 ? a.y + headerH + arow * rowH + rowH / 2 : a.y + a.h / 2;
      const by = brow >= 0 ? b.y + headerH + brow * rowH + rowH / 2 : b.y + b.h / 2;
      const aSide = (b.x + b.w / 2 >= a.x + a.w / 2) ? a.x + a.w : a.x;
      const bSide = (a.x + a.w / 2 <= b.x + b.w / 2) ? b.x : b.x + b.w;
      const ux = Math.sign(bSide - aSide) || 1;
      const exitOffset = 18;     // how far the line travels horizontally before turning
      const ax2 = aSide + ux * exitOffset;
      const bx2 = bSide - ux * exitOffset;
      // If the corridor is too narrow (tables overlap horizontally), curve out further
      const corridorMid = (ax2 + bx2) / 2;
      const z = this.camera.zoom;
      const r = 6;  // corner radius

      // Path: aSide,ay → ax2,ay → ax2 down/up → corridorMid,ay-ish → … → bx2,by → bSide,by
      // Simplified: H from source, V via mid, H to target. Use small bezier corners.
      ctx.beginPath();
      ctx.moveTo(aSide, ay);
      ctx.lineTo(ax2 - ux * r, ay);
      ctx.quadraticCurveTo(ax2, ay, ax2, ay + Math.sign(by - ay || 1) * r);
      ctx.lineTo(ax2, by - Math.sign(by - ay || 1) * r);
      ctx.quadraticCurveTo(ax2, by, ax2 + ux * r, by);
      // If the two ax2 and bx2 are crossed (overlap), draw a U around the table
      if (ux > 0 ? ax2 > bx2 : ax2 < bx2) {
        // Route via the larger gap between rows: pick a Y between the two tables
        const aboveY = Math.min(a.y, b.y) - 24;
        ctx.lineTo(corridorMid, by); // straight line accept overlap (rare)
      } else {
        ctx.lineTo(bx2 - ux * r, by);
      }
      ctx.quadraticCurveTo(bx2, by, bx2, by);
      ctx.lineTo(bSide, by);
      ctx.stroke();

      // FK head: filled diamond on source row, arrowhead at target
      const z2 = this.camera.zoom;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      const ds = 3 / z2;
      ctx.moveTo(aSide + ux * ds, ay);
      ctx.lineTo(aSide + ux * ds * 2, ay - ds);
      ctx.lineTo(aSide + ux * ds * 3, ay);
      ctx.lineTo(aSide + ux * ds * 2, ay + ds);
      ctx.closePath();
      ctx.fill();
      const ah = 7 / z2;
      ctx.beginPath();
      ctx.moveTo(bSide, by);
      ctx.lineTo(bSide - ux * ah, by - ah * 0.55);
      ctx.lineTo(bSide - ux * ah, by + ah * 0.55);
      ctx.closePath();
      ctx.fill();
      return;
    }

    // Endpoints anchor on the box edge nearest the other box's centroid
    const dx = (b.x + b.w / 2) - (a.x + a.w / 2);
    const dy = (b.y + b.h / 2) - (a.y + a.h / 2);
    const goingDown = Math.abs(dy) >= Math.abs(dx);
    let ax, ay, bx, by;
    if (goingDown && dy > 0) {
      ax = a.x + a.w / 2; ay = a.y + a.h;
      bx = b.x + b.w / 2; by = b.y;
    } else if (goingDown && dy < 0) {
      ax = a.x + a.w / 2; ay = a.y;
      bx = b.x + b.w / 2; by = b.y + b.h;
    } else if (dx > 0) {
      ax = a.x + a.w; ay = a.y + a.h / 2;
      bx = b.x;       by = b.y + b.h / 2;
    } else {
      ax = a.x;       ay = a.y + a.h / 2;
      bx = b.x + b.w; by = b.y + b.h / 2;
    }
    const cpOff = Math.max(20, Math.abs(goingDown ? dy : dx) * 0.35);
    let cp1x, cp1y, cp2x, cp2y;
    if (goingDown) {
      cp1x = ax; cp1y = ay + Math.sign(by - ay) * cpOff;
      cp2x = bx; cp2y = by - Math.sign(by - ay) * cpOff;
    } else {
      cp1x = ax + Math.sign(bx - ax) * cpOff; cp1y = ay;
      cp2x = bx - Math.sign(bx - ax) * cpOff; cp2y = by;
    }
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, bx, by);
    ctx.stroke();

    if (withArrow) {
      // Arrow tangent at endpoint (derivative of bezier at t=1)
      const tx = bx - cp2x;
      const ty = by - cp2y;
      const len = Math.hypot(tx, ty) || 1;
      const ux = tx / len, uy = ty / len;
      const z = this.camera.zoom;
      const head = 7 / z;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - ux * head - uy * head * 0.6, by - uy * head + ux * head * 0.6);
      ctx.lineTo(bx - ux * head + uy * head * 0.6, by - uy * head - ux * head * 0.6);
      ctx.closePath();
      ctx.fill();
    }
  }

  truncate(ctx, text, maxW) {
    const raw = String(text || '');
    if (!raw) return '';
    if (ctx.measureText(raw).width <= maxW) return raw;
    let lo = 1;
    let hi = raw.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(raw.slice(0, mid) + '…').width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return raw.slice(0, Math.max(1, lo)) + '…';
  }

  wrapLabel(ctx, text, maxW, maxLines = 2) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return [''];
    if (ctx.measureText(raw).width <= maxW) return [raw];

    const tokens = raw.split(/(\s+|[\/_.:-])/).filter(Boolean);
    const lines = [];
    let line = '';
    let truncated = false;

    const finishLine = () => {
      const out = line.trim();
      if (out) lines.push(out);
      line = '';
      return lines.length < maxLines;
    };

    const appendLongToken = (token) => {
      let chunk = '';
      for (const ch of token) {
        const candidate = chunk + ch;
        if (!chunk || ctx.measureText(candidate).width <= maxW) {
          chunk = candidate;
          continue;
        }
        line = chunk;
        if (!finishLine()) { truncated = true; return false; }
        chunk = ch;
      }
      line = chunk;
      return true;
    };

    for (const token of tokens) {
      if (/^\s+$/.test(token) && !line) continue;
      const candidate = line + token;
      if (ctx.measureText(candidate).width <= maxW) {
        line = candidate;
        continue;
      }
      if (line && !finishLine()) { truncated = true; break; }
      const next = token.trimStart();
      if (!next) continue;
      if (ctx.measureText(next).width <= maxW) {
        line = next;
      } else if (!appendLongToken(next)) {
        break;
      }
    }

    if (!truncated && line.trim()) {
      if (lines.length < maxLines) lines.push(line.trim());
      else truncated = true;
    }
    if (truncated && lines.length) {
      let last = lines[lines.length - 1].trim();
      while (last.length > 1 && ctx.measureText(last + '…').width > maxW) {
        last = last.slice(0, -1);
      }
      lines[lines.length - 1] = `${last}…`;
    }
    return lines.length ? lines : [this.truncate(ctx, raw, maxW)];
  }

  roundRect(ctx, x, y, w, h, r) {
    if (r * 2 > w) r = w / 2;
    if (r * 2 > h) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

window.Graph = Graph;
