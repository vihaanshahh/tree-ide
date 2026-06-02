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
    inner.set(b, (inner.get(b) || 0) + 1);
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

function displayLabel(f) {
  return f.label || f.filename || f.id;
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
  const pillMinW = density === 'small' ? 112 : density === 'medium' ? 92 : 82;
  const pillMaxW = density === 'small' ? 360 : density === 'medium' ? 320 : 280;
  const pillH = density === 'small' ? 32 : 28;
  const labelLineH = 14;
  const itemGap = 8;
  const rowGap = 10;
  const sectionHeadH = 26;
  const sectionGap = 22;
  const panelPadX = 14;
  const panelPadTop = 32;
  const panelPadBottom = 14;
  const modXGap = density === 'small' ? 56 : 44;
  const modYGap = density === 'small' ? 64 : 56;

  const measureLabel = (f) => {
    if (f.kind === 'table') {
      let width = estimateTextWidth(String(f.label || '').toUpperCase(), 12) + 60;
      for (const c of f.columns || []) width = Math.max(width, estimateTextWidth(`${c.name} ${c.type}`, 11) + 56);
      return width;
    }
    return Math.min(pillMaxW, estimateTextWidth(displayLabel(f), 12) + 32);
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
        arr.sort((a, b) => endpointPathOf(a).localeCompare(endpointPathOf(b)) || endpointVerbRank(a) - endpointVerbRank(b));
      } else if (kind === 'table') {
        arr.sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')));
      } else {
        arr.sort((a, b) => (importance.get(b.id) || 0) - (importance.get(a.id) || 0) || displayLabel(a).localeCompare(displayLabel(b)));
      }
    }

    const widths = [];
    for (const kind of orderedKinds) {
      for (const f of byKind.get(kind)) widths.push(measureLabel(f));
    }
    widths.sort((a, b) => a - b);
    const median = widths.length ? widths[Math.floor(widths.length / 2)] : pillMinW;
    const maxWidth = widths.length ? widths[widths.length - 1] : pillMinW;
    const targetCols = Math.max(1, Math.min(3, Math.round(Math.sqrt(mod.files.length) / 1.8)));
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
        w = Math.min(pillMaxW, Math.ceil(w + Math.min(32, Math.log2(f._importance + 1) * 5)));
        if (w > section.w) w = section.w;
        f._labelLines = wrapLabel(displayLabel(f), Math.max(20, w - 32), f.kind === 'endpoint' ? 3 : 2);
        return {
          w,
          h: Math.max(f.kind === 'endpoint' ? 48 : pillH, f._labelLines.length * labelLineH + 14 + (f.kind === 'endpoint' ? 16 : 0)),
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
  const byTier = new Map();
  for (const mod of moduleMap.values()) {
    const t = tier.get(mod.id) || 0;
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t).push(mod);
  }

  const placedCenterX = new Map();
  let yCursor = topPad;
  for (const t of [...byTier.keys()].sort((a, b) => a - b)) {
    const rowMods = byTier.get(t);
    if (t === 0) {
      rowMods.sort((a, b) => b.files.length - a.files.length || a.id.localeCompare(b.id));
    } else {
      for (const mod of rowMods) {
        let sum = 0;
        let count = 0;
        for (const otherId of placedCenterX.keys()) {
          const fromOther = modOut.get(otherId);
          const fromSelf = modOut.get(mod.id);
          if ((fromOther && fromOther.has(mod.id)) || (fromSelf && fromSelf.has(otherId))) {
            sum += placedCenterX.get(otherId);
            count++;
          }
        }
        mod._barycenter = count ? sum / count : 0;
      }
      const orig = new Map(rowMods.map((m, i) => [m.id, i]));
      rowMods.sort((a, b) => a._barycenter - b._barycenter || orig.get(a.id) - orig.get(b.id));
    }

    const rowW = rowMods.reduce((sum, m) => sum + m._panelW, 0) + modXGap * Math.max(0, rowMods.length - 1);
    let xCursor = -rowW / 2;
    let rowH = 0;
    for (const mod of rowMods) {
      for (const section of mod.sections) {
        section.x += xCursor;
        section.y += yCursor;
        for (const id of section.fileIds) {
          const f = filesMap.get(id);
          if (f) {
            f.x += xCursor;
            f.y += yCursor;
          }
        }
      }
      mod.x = xCursor;
      mod.y = yCursor;
      placedCenterX.set(mod.id, xCursor + mod._panelW / 2);
      xCursor += mod._panelW + modXGap;
      rowH = Math.max(rowH, mod._panelH);
    }
    yCursor += rowH + modYGap;
  }

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
