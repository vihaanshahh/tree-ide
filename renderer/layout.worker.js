// Off-main-thread layout path for large Tree IDE graphs.
// Small and medium graphs still use the canvas-measured layout in graph.js;
// this worker keeps large incremental relayouts from blocking interaction.

const LAYER_DEFS = [
  { id: 'interface', name: 'INTERFACE', kinds: ['page', 'layout', 'template', 'component', 'hook', 'store', 'styles', 'loading', 'error', 'notfound', 'app', 'document', 'default', 'special'] },
  { id: 'server', name: 'SERVER', kinds: ['service', 'endpoint', 'route', 'middleware', 'server-action', 'job'] },
  { id: 'data', name: 'DATA', kinds: ['table', 'schema', 'model'] },
  { id: 'support', name: 'SUPPORT', kinds: ['infra', 'config', 'test', 'docs', 'module', 'other', 'external'] },
];

const KIND_ORDER = new Map();
for (const L of LAYER_DEFS) {
  for (const k of L.kinds) KIND_ORDER.set(k, KIND_ORDER.size);
}

const KIND_PRETTY = {
  page: 'Pages',
  component: 'Components',
  hook: 'Hooks',
  store: 'Stores',
  layout: 'Layouts',
  styles: 'Styles',
  loading: 'Loading',
  error: 'Errors',
  template: 'Templates',
  notfound: 'Not Found',
  app: 'App Shell',
  document: 'HTML Doc',
  default: 'Parallel',
  special: 'Special',
  service: 'Services',
  endpoint: 'Endpoints',
  route: 'Route Files',
  middleware: 'Middleware',
  'server-action': 'Server Actions',
  job: 'Jobs',
  table: 'Tables',
  schema: 'Schemas',
  model: 'Models',
  infra: 'Infra',
  config: 'Config',
  test: 'Tests',
  docs: 'Docs',
  module: 'Modules',
  other: 'Other',
  external: 'External Deps',
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

function moduleKeyOf(f, depth) {
  const raw = f.dir || (f.id && f.id.includes('/') ? f.id.slice(0, f.id.lastIndexOf('/')) : '');
  if (!raw) return '__root__';
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length) return '__root__';
  return parts.slice(0, depth).join('/');
}

function moduleDisplayName(key) {
  if (!key || key === '__root__') return 'ROOT';
  return key;
}

function pickModuleDepth(files) {
  let best = { depth: 1, score: -Infinity };
  for (let d = 1; d <= 3; d++) {
    const counts = new Map();
    for (const f of files) {
      const k = moduleKeyOf(f, d);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const mods = counts.size;
    const mean = files.length / Math.max(1, mods);
    let score = 0;
    if (mods >= 4 && mods <= 24) score += 100;
    if (mods >= 6 && mods <= 16) score += 40;
    if (mods < 2) score -= 200;
    if (mods > 40) score -= 100;
    if (mean >= 3 && mean <= 30) score += 60;
    if (mean < 1.5) score -= 40;
    if (score > best.score) best = { depth: d, score };
  }
  return best.depth;
}

function buildModuleAdjacency(fileEdges, filesMap, modOf, moduleIds) {
  const out = new Map();
  for (const m of moduleIds) out.set(m, new Map());
  for (const e of fileEdges) {
    const sf = filesMap.get(e.source);
    const tf = filesMap.get(e.target);
    if (!sf || !tf || sf.hidden || tf.hidden) continue;
    const a = modOf(sf);
    const b = modOf(tf);
    if (a === b || !moduleIds.has(a) || !moduleIds.has(b)) continue;
    const inner = out.get(a);
    inner.set(b, (inner.get(b) || 0) + edgeTypeWeight(e));
  }
  return out;
}

function computeModuleTiers(out, moduleIds) {
  const tier = new Map();
  for (const m of moduleIds) tier.set(m, 0);
  const max = 24;
  for (let i = 0; i < max; i++) {
    let changed = false;
    for (const [a, targets] of out) {
      const ta = tier.get(a);
      for (const b of targets.keys()) {
        const tb = tier.get(b);
        if (ta + 1 > tb) {
          tier.set(b, Math.min(max, ta + 1));
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return tier;
}

function edgeTypeWeight(e) {
  if (!e) return 1;
  if (e.type === 'db-query') return 7;
  if (e.type === 'api-call') return 6;
  if (e.type === 'endpoint-internal') return 4;
  if (e.type === 'fk') return 3;
  if (e.type === 'import') return e.transitive ? 0.35 : 1;
  return e.transitive ? 0.25 : 1;
}

function baseFeatureScore(f, { matchSet, activeFileIds } = {}) {
  let score = 0;
  if (f.gitStatus && (f.gitStatus.dirty || f.gitStatus.unpushed)) {
    score += f.gitStatus.untracked ? 12 : f.gitStatus.unpushed ? 10 : 16;
  }
  if (activeFileIds && activeFileIds.has(f.id)) score += 18;
  if (matchSet && matchSet.has(f.id)) score += 14;
  return score;
}

function computeFeatureScores(files, edges, opts = {}) {
  const filesMap = files instanceof Map ? files : new Map(files.map(f => [f.id, f]));
  const base = new Map();
  for (const f of filesMap.values()) {
    const score = baseFeatureScore(f, opts);
    if (score) base.set(f.id, score);
  }
  const scores = new Map(base);
  for (const e of edges || []) {
    const sf = filesMap.get(e.source);
    const tf = filesMap.get(e.target);
    if (!sf || !tf || sf.hidden || tf.hidden) continue;
    const w = edgeTypeWeight(e);
    const sourceScore = base.get(e.source) || 0;
    const targetScore = base.get(e.target) || 0;
    if (sourceScore) scores.set(e.target, (scores.get(e.target) || 0) + sourceScore * w * 0.16);
    if (targetScore) scores.set(e.source, (scores.get(e.source) || 0) + targetScore * w * 0.12);
  }
  return scores;
}

function modulePairWeight(out, a, b) {
  if (!out || !a || !b || a === b) return 0;
  return (out.get(a)?.get(b) || 0) + (out.get(b)?.get(a) || 0);
}

function orderModulesByFeatureFlow(modules, out) {
  if (modules.length <= 2) return modules.slice();
  const remaining = new Map(modules.map(mod => [mod.id, mod]));
  const ordered = [];
  const moduleRank = (mod) => (
    (mod._featureScore || 0) * 7 +
    (mod._componentScore || 0) * 2.2 +
    Math.log2((mod._score || 0) + 1) * 10 +
    mod.files.length * 0.35
  );
  const pickBest = (scoreFor) => {
    let best = null;
    let bestScore = -Infinity;
    for (const mod of remaining.values()) {
      const score = scoreFor(mod);
      if (score > bestScore || (score === bestScore && best && mod.id.localeCompare(best.id) < 0)) {
        best = mod;
        bestScore = score;
      }
    }
    if (best) remaining.delete(best.id);
    return best;
  };

  const first = pickBest(moduleRank);
  if (first) ordered.push(first);

  while (remaining.size) {
    const last = ordered[ordered.length - 1];
    const next = pickBest((mod) => {
      let placedConnection = 0;
      for (const placed of ordered) placedConnection += modulePairWeight(out, mod.id, placed.id);
      const lastConnection = last ? modulePairWeight(out, mod.id, last.id) : 0;
      const tierDistance = last ? Math.abs((mod._tier || 0) - (last._tier || 0)) : 0;
      return placedConnection * 54 + lastConnection * 32 + moduleRank(mod) - tierDistance * 0.7;
    });
    if (next) ordered.push(next);
  }
  return ordered;
}

function packModulePicture(modules, { xGap, yGap, topPad, targetAspect = 1.08, translate }) {
  if (!modules.length) return;
  if (modules.length === 1) {
    translate(modules[0], 0, topPad);
    return;
  }

  const totalArea = modules.reduce((sum, mod) => sum + (mod._panelW + xGap) * (mod._panelH + yGap), 0);
  const maxPanelW = Math.max(...modules.map(mod => mod._panelW));
  const naturalW = Math.sqrt(Math.max(1, totalArea) * targetAspect);
  const minTargetW = Math.max(maxPanelW, naturalW * 0.68);
  const maxTargetW = Math.max(minTargetW, naturalW * 1.42);
  let best = null;

  const packAtWidth = (targetW) => {
    const rows = [];
    let row = { mods: [], w: 0, h: 0 };
    for (const mod of modules) {
      const nextW = row.mods.length ? row.w + xGap + mod._panelW : mod._panelW;
      if (row.mods.length && nextW > targetW) {
        rows.push(row);
        row = { mods: [], w: 0, h: 0 };
      }
      row.mods.push(mod);
      row.w = row.mods.length === 1 ? mod._panelW : nextW;
      row.h = Math.max(row.h, mod._panelH);
    }
    if (row.mods.length) rows.push(row);
    const w = Math.max(...rows.map(r => r.w));
    const h = rows.reduce((sum, r) => sum + r.h, 0) + yGap * Math.max(0, rows.length - 1);
    const aspect = w / Math.max(1, h);
    const aspectPenalty = Math.abs(Math.log(aspect / targetAspect));
    const lonelyRows = rows.filter(r => r.mods.length === 1).length;
    const rowPenalty = Math.abs(rows.length - Math.sqrt(modules.length)) * 0.035;
    const lonelyPenalty = lonelyRows / modules.length * 0.22;
    return { rows, w, h, score: aspectPenalty + rowPenalty + lonelyPenalty };
  };

  for (let i = 0; i < 18; i++) {
    const t = i / 17;
    const candidate = packAtWidth(minTargetW + (maxTargetW - minTargetW) * t);
    if (!best || candidate.score < best.score) best = candidate;
  }

  let y = topPad;
  for (const row of best.rows) {
    let x = -row.w / 2;
    for (const mod of row.mods) {
      translate(mod, x, y);
      x += mod._panelW + xGap;
    }
    y += row.h + yGap;
  }
}

function displayLabel(f) {
  if (!f) return '';
  if (f.kind === 'route' && f.sublabel) return `${f.label} ${f.sublabel}`;
  if (f.kind === 'page' && f.sublabel) return pageDisplayLabel(f);
  if ((f.kind === 'layout' || f.kind === 'template') && f.sublabel) return routeFileDisplayLabel(f);
  if (f.kind === 'component') return componentDisplayLabel(f);
  if (f.kind === 'hook' && f.sublabel) return f.sublabel;
  if (['config', 'infra', 'docs', 'schema'].includes(f.kind) && (f.sublabel || f.filename)) {
    return f.sublabel || f.filename;
  }
  const generic = ['store', 'job', 'service', 'server-action', 'test', 'styles', 'model'];
  if (generic.includes(f.kind)) {
    const name = f.sublabel || (f.filename ? f.filename.replace(/\.[^.]+$/, '') : '') || f.id;
    const genericNames = new Set(['index', 'main', 'route', 'server', 'app', 'handler', 'router']);
    if (genericNames.has(String(name).toLowerCase()) && f.dir) {
      const folder = f.dir.split('/').pop();
      if (folder) return `${folder}/${name}`;
    }
    return name;
  }
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

function estimateTextWidth(text, size = 12) {
  return Math.ceil(String(text || '').length * size * 0.62);
}

function wrapLabel(text, maxWidth, maxLines) {
  const raw = String(text || '');
  const maxChars = Math.max(4, Math.floor(maxWidth / 7.2));
  if (raw.length <= maxChars) return [raw];
  const parts = raw.split(/([/_\-.])/);
  const lines = [];
  let line = '';
  for (const part of parts) {
    if ((line + part).length > maxChars && line) {
      lines.push(line);
      line = part.replace(/^[/_\-.]/, '');
      if (lines.length >= maxLines) break;
    } else {
      line += part;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (!lines.length) lines.push(raw.slice(0, maxChars));
  const last = lines.length - 1;
  if (raw.length > lines.join('').length) lines[last] = lines[last].slice(0, Math.max(1, maxChars - 3)) + '...';
  return lines;
}

function performLayout(nodes, edges, opts = {}) {
  const visibleKinds = new Set(opts.visibleKinds || []);
  const matchSet = new Set(opts.matchSet || []);
  const activeFileIds = new Set(opts.activeFileIds || []);
  const expandedTables = new Set(opts.expandedTables || []);
  const importance = new Map(opts.importance || []);
  const topPad = Number(opts.topPad || 108);
  const tablePreviewRows = Number(opts.tablePreviewRows || 7);

  const filesMap = new Map();
  for (const n of nodes) filesMap.set(n.id, n);

  const allVisible = [];
  for (const f of nodes) {
    const forceVisible = opts.searchQuery && matchSet.has(f.id);
    if (!visibleKinds.has(f.kind) && !forceVisible) {
      f.hidden = true;
      continue;
    }
    f.hidden = false;
    allVisible.push(f);
  }

  if (!allVisible.length) return { nodes, layers: [] };

  const n = allVisible.length;
  const density = n <= 80 ? 'small' : n <= 320 ? 'medium' : 'large';
  const featureScores = computeFeatureScores(new Map(allVisible.map(f => [f.id, f])), edges, {
    matchSet,
    activeFileIds,
  });
  for (const f of allVisible) f._featureScore = featureScores.get(f.id) || 0;
  const pillPadX = 18;
  const pillMinW = density === 'small' ? 132 : density === 'medium' ? 118 : 104;
  const pillMaxW = density === 'small' ? 460 : density === 'medium' ? 420 : 380;
  const pillH = density === 'small' ? 36 : 34;
  const labelLineH = 14;
  const itemGap = 14;
  const rowGap = 16;
  const sectionHeadH = 30;
  const sectionGap = 32;
  const panelPadX = 20;
  const panelPadTop = 40;
  const panelPadBottom = 22;
  const modXGap = density === 'small' ? 84 : 72;
  const modYGap = density === 'small' ? 88 : 76;

  const measureLabel = (f) => {
    if (f.kind === 'table') {
      let width = estimateTextWidth(String(f.label || '').toUpperCase(), 12) + 60;
      for (const c of f.columns || []) width = Math.max(width, estimateTextWidth(`${c.name} ${c.type}`, 11) + 56);
      return width;
    }
    return Math.min(pillMaxW, estimateTextWidth(displayLabel(f), 12) + pillPadX * 2);
  };

  const modDepth = pickModuleDepth(allVisible);
  const modOf = (f) => moduleKeyOf(f, modDepth);
  const moduleMap = new Map();
  for (const f of allVisible) {
    f._mod = modOf(f);
    if (!moduleMap.has(f._mod)) moduleMap.set(f._mod, { id: f._mod, name: moduleDisplayName(f._mod), files: [] });
    moduleMap.get(f._mod).files.push(f);
  }
  const moduleIds = new Set(moduleMap.keys());

  for (const mod of moduleMap.values()) {
    const byKind = new Map();
    for (const f of mod.files) {
      if (!byKind.has(f.kind)) byKind.set(f.kind, []);
      byKind.get(f.kind).push(f);
    }
    const orderedKinds = [...byKind.keys()].sort((a, b) => {
      const ra = KIND_ORDER.has(a) ? KIND_ORDER.get(a) : 99;
      const rb = KIND_ORDER.has(b) ? KIND_ORDER.get(b) : 99;
      return ra - rb || a.localeCompare(b);
    });

    for (const kind of orderedKinds) {
      const arr = byKind.get(kind);
      if (kind === 'endpoint') {
        arr.sort((a, b) => {
          const fa = a._featureScore || 0;
          const fb = b._featureScore || 0;
          if (fa !== fb) return fb - fa;
          return endpointPathOf(a).localeCompare(endpointPathOf(b)) || endpointVerbRank(a) - endpointVerbRank(b);
        });
      } else if (kind === 'table') {
        arr.sort((a, b) => {
          const fa = a._featureScore || 0;
          const fb = b._featureScore || 0;
          if (fa !== fb) return fb - fa;
          return String(a.label || '').localeCompare(String(b.label || ''));
        });
      } else {
        arr.sort((a, b) => {
          const fa = a._featureScore || 0;
          const fb = b._featureScore || 0;
          if (fa !== fb) return fb - fa;
          return (importance.get(b.id) || 0) - (importance.get(a.id) || 0) || displayLabel(a).localeCompare(displayLabel(b));
        });
      }
    }

    const widths = [];
    for (const kind of orderedKinds) {
      for (const f of byKind.get(kind)) widths.push(measureLabel(f));
    }
    widths.sort((a, b) => a - b);
    const median = widths.length ? widths[Math.floor(widths.length / 2)] : pillMinW;
    const maxWidth = widths.length ? widths[widths.length - 1] : pillMinW;
    const targetCols = Math.max(1, Math.min(2, Math.round(Math.sqrt(mod.files.length) / 2.4)));
    const innerW = Math.ceil(Math.max(pillMinW, maxWidth, median * targetCols + itemGap * (targetCols - 1)));
    const panelW = innerW + panelPadX * 2;
    const sections = [];
    let yCursor = panelPadTop;

    for (const kind of orderedKinds) {
      const filesK = byKind.get(kind);
      const section = {
        kind,
        name: KIND_PRETTY[kind] || kind,
        fileIds: [],
        allCount: filesK.length,
        hiddenCount: 0,
        canExpand: false,
        expanded: true,
        x: panelPadX,
        y: yCursor,
        w: innerW,
        h: 0,
      };
      const innerLeft = section.x + 2;
      const innerRight = section.x + section.w - 2;
      let placeX = innerLeft;
      let rowY = yCursor + sectionHeadH;
      let rowMaxBottom = rowY;

      const placeNode = (f, w, h) => {
        if (placeX + w > innerRight && placeX !== innerLeft) {
          placeX = innerLeft;
          rowY = rowMaxBottom + rowGap;
        }
        f.w = w;
        f.h = h;
        f.x = placeX;
        f.y = rowY;
        f.hidden = false;
        section.fileIds.push(f.id);
        placeX += w + itemGap;
        rowMaxBottom = Math.max(rowMaxBottom, rowY + h);
      };

      const sizeDefault = (f) => {
        if (f.kind === 'table') {
          const cols = f.columns || [];
          const expanded = expandedTables.has(f.id);
          const visibleCols = expanded ? cols : cols.slice(0, tablePreviewRows);
          f._visibleCols = visibleCols;
          f._tableExpanded = expanded;
          f._showFooter = cols.length > tablePreviewRows;
          f._moreCount = Math.max(0, cols.length - visibleCols.length);
          return { w: section.w, h: 26 + visibleCols.length * 17 + (f._showFooter ? 24 : 8) };
        }
        f._endpointCompact = false;
        f._endpointPath = '';
        f._endpointVerb = '';
        f._importance = importance.get(f.id) || 0;
        let w = Math.max(pillMinW, Math.min(pillMaxW, measureLabel(f)));
        w = Math.min(pillMaxW, Math.ceil(w + Math.min(44, Math.log2(f._importance + 1) * 6)));
        if (w > section.w) w = section.w;
        const maxLabelLines = (f.kind === 'endpoint' || f.kind === 'page' || f.kind === 'component') ? 3 : 2;
        f._labelLines = wrapLabel(displayLabel(f), Math.max(20, w - pillPadX * 2), maxLabelLines);
        const decisionMetaH = f.kind === 'endpoint' ? 0 : 14;
        return {
          w,
          h: Math.max(
            f.kind === 'endpoint' ? 48 : pillH + decisionMetaH,
            f._labelLines.length * labelLineH + 14 + (f.kind === 'endpoint' ? 16 : decisionMetaH),
          ),
        };
      };

      if (kind === 'endpoint') {
        const groups = [];
        for (const f of filesK) {
          const key = endpointPathOf(f);
          const last = groups[groups.length - 1];
          if (last && last.key === key) last.files.push(f);
          else groups.push({ key, files: [f] });
        }
        for (const group of groups) {
          if (group.files.length > 1) {
            if (placeX !== innerLeft) {
              placeX = innerLeft;
              rowY = rowMaxBottom + rowGap;
            }
            const minMethodW = 90;
            const cols = Math.max(1, Math.min(group.files.length, Math.floor((section.w + itemGap) / (minMethodW + itemGap))));
            const compactW = Math.max(minMethodW, Math.min(124, Math.floor((section.w - itemGap * (cols - 1)) / cols)));
            for (const f of group.files) {
              f._endpointCompact = true;
              f._endpointPath = group.key;
              f._endpointVerb = endpointVerbOf(f) || 'API';
              f._labelLines = [f._endpointVerb, group.key];
              f._importance = importance.get(f.id) || 0;
              placeNode(f, compactW, 48);
            }
            placeX = innerLeft;
            rowY = rowMaxBottom + rowGap;
          } else {
            const f = group.files[0];
            const box = sizeDefault(f);
            placeNode(f, box.w, box.h);
          }
        }
      } else {
        for (const f of filesK) {
          const box = sizeDefault(f);
          placeNode(f, box.w, box.h);
        }
      }

      section.h = (rowMaxBottom + (filesK.some(f => f.kind === 'table') ? 6 : 12)) - yCursor;
      sections.push(section);
      yCursor = rowMaxBottom + sectionGap;
    }

    mod.sections = sections;
    mod._panelW = panelW;
    mod._panelH = Math.max(70, (yCursor - sectionGap) + panelPadBottom);
  }

  const modOut = buildModuleAdjacency(edges, filesMap, modOf, moduleIds);
  const tier = computeModuleTiers(modOut, moduleIds);
  for (const mod of moduleMap.values()) {
    mod._tier = tier.get(mod.id) || 0;
    mod._score = mod.files.reduce((sum, f) => sum + (importance.get(f.id) || 0), 0);
    mod._featureScore = mod.files.reduce((sum, f) => sum + (f._featureScore || 0), 0);
    mod._componentScore = mod.files.reduce((sum, f) => {
      return sum + (['page', 'component', 'hook', 'store'].includes(f.kind) ? (importance.get(f.id) || 1) : 0);
    }, 0);
  }

  const orderedModules = orderModulesByFeatureFlow([...moduleMap.values()], modOut);
  packModulePicture(orderedModules, {
    xGap: modXGap,
    yGap: modYGap,
    topPad,
    targetAspect: 1.08,
    translate: (mod, x, y) => {
      for (const section of mod.sections) {
        section.x += x;
        section.y += y;
        for (const id of section.fileIds) {
          const f = filesMap.get(id);
          if (f) {
            f.x += x;
            f.y += y;
          }
        }
      }
      mod.x = x;
      mod.y = y;
    },
  });

  return {
    nodes,
    layers: [...moduleMap.values()].map(m => ({
      id: 'mod:' + m.id,
      name: m.name,
      isModule: true,
      fileCount: m.files.length,
      x: m.x,
      y: m.y,
      w: m._panelW,
      h: m._panelH,
      sections: m.sections,
    })),
  };
}

self.onmessage = function onmessage(event) {
  const { action, data, seq } = event.data || {};
  if (action !== 'layout') return;
  try {
    self.postMessage({ action: 'layout-complete', seq, result: performLayout(data.nodes || [], data.edges || [], data.opts || {}) });
  } catch (err) {
    self.postMessage({ action: 'layout-complete', seq, error: err && err.message ? err.message : String(err) });
  }
};
