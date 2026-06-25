const http = require('http');
const https = require('https');
const engine = require('./tokenmax/engine');

// TokenMax now ships inside tree-ide: usage is computed in-process by the
// embedded engine, so nothing needs to run on a separate port. An explicit
// TREE_TOKENMAX_URL / TOKENMAX_URL still routes to a remote TokenMax instead
// (e.g. when serving over SSH), but that's an opt-in override, not the default.
const EXPLICIT_TOKENMAX_URL = process.env.TREE_TOKENMAX_URL || process.env.TOKENMAX_URL || null;
const DEFAULT_TIMEOUT_MS = clampNumber(process.env.TREE_USAGE_TIMEOUT_MS, 60000, 1000, 90000);
const CACHE_MS = clampNumber(process.env.TREE_USAGE_CACHE_MS, 15000, 1000, 120000);

class UsageService {
  constructor(opts = {}) {
    const explicitUrl = opts.tokenmaxUrl || EXPLICIT_TOKENMAX_URL || null;
    // Embedded engine is the default; a URL override flips us to HTTP mode.
    this.useEngine = !explicitUrl;
    this.tokenmaxUrl = explicitUrl || 'embedded';
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.cacheMs = opts.cacheMs || CACHE_MS;
    this.lastSnapshot = null;
    this.lastFetchAt = 0;
    this.inflight = null;
    if (this.useEngine && opts.dataDir) engine.configure({ dataDir: opts.dataDir });
  }

  async snapshot({ agents = [], force = false, range = '7d', onProgress = null } = {}) {
    const now = Date.now();
    if (!force && this.lastSnapshot && now - this.lastFetchAt < this.cacheMs) {
      return this.withAgents(this.lastSnapshot, agents, false);
    }

    if (this.inflight) {
      try {
        const snapshot = await this.inflight;
        return this.withAgents(snapshot, agents, false);
      } catch {
        return this.unavailable(agents);
      }
    }

    this.inflight = this.fetchTokenMax(range, onProgress)
      .then((payload) => {
        const snapshot = buildTreeUsageSnapshot(payload, {
          tokenmaxUrl: this.tokenmaxUrl,
          fetchedAt: new Date().toISOString(),
        });
        this.lastSnapshot = snapshot;
        this.lastFetchAt = Date.now();
        return snapshot;
      })
      .finally(() => {
        this.inflight = null;
      });

    try {
      const snapshot = await this.inflight;
      return this.withAgents(snapshot, agents, false);
    } catch (error) {
      const stale = this.lastSnapshot ? {
        ...this.lastSnapshot,
        status: 'stale',
        stale: true,
        error: cleanError(error),
      } : null;
      if (stale) return this.withAgents(stale, agents, true);
      return this.unavailable(agents, error);
    }
  }

  withAgents(snapshot, agents, stale) {
    const activeAgents = normalizeAgents(agents);
    const providers = {};
    for (const [key, provider] of Object.entries(snapshot.providers || {})) {
      providers[key] = addAgentSimulation(provider, activeAgents);
    }
    return {
      ...snapshot,
      stale: Boolean(stale || snapshot.stale),
      activeAgents,
      providers,
      routing: buildRouting(providers),
    };
  }

  unavailable(agents, error = null) {
    const activeAgents = normalizeAgents(agents);
    const providers = {
      codex: addAgentSimulation(emptyProvider('codex', 'Codex'), activeAgents),
      claude: addAgentSimulation(emptyProvider('claude', 'Claude'), activeAgents),
    };
    return {
      ok: false,
      status: 'unavailable',
      generatedAt: new Date().toISOString(),
      tokenmaxUrl: this.tokenmaxUrl,
      error: error ? cleanError(error) : 'TokenMax is not reachable.',
      activeAgents,
      providers,
      stats: emptyStats(),
      routing: buildRouting(providers),
    };
  }

  fetchTokenMax(range, onProgress = null) {
    if (this.useEngine) {
      // Same payload shape the standalone TokenMax /api/usage endpoint returned,
      // so buildTreeUsageSnapshot consumes it unchanged.
      return engine.buildUsagePayload(
        engine.getRange(range || '7d'),
        typeof onProgress === 'function' ? onProgress : undefined,
      );
    }
    const url = new URL('/api/usage', this.tokenmaxUrl);
    url.searchParams.set('range', range || '7d');
    return getJson(url, this.timeoutMs);
  }
}

function buildTreeUsageSnapshot(payload, meta) {
  const intelligence = payload?.intelligence || {};
  const providers = intelligence.providers || {};
  const codex = normalizeProvider('codex', 'Codex', providers.openai, payload?.providers?.openai);
  const claude = normalizeProvider('claude', 'Claude', providers.anthropic, payload?.providers?.anthropic);
  return {
    ok: Boolean(payload?.ok),
    status: payload?.ok ? 'ok' : 'partial',
    generatedAt: payload?.generatedAt || meta.fetchedAt,
    fetchedAt: meta.fetchedAt,
    tokenmaxUrl: meta.tokenmaxUrl,
    tookMs: payload?.tookMs ?? null,
    storage: payload?.storage || null,
    providers: { codex, claude },
    stats: buildUsageStats(payload),
  };
}

function buildUsageStats(payload) {
  const sourceRows = arrayOf(payload?.intelligence?.series?.dailyStack);
  const byDate = new Map();
  for (const row of sourceRows) {
    if (!row?.date) continue;
    const codexTokens = finiteNumber(row.openaiTokens, 0);
    const claudeTokens = finiteNumber(row.anthropicTokens, 0);
    byDate.set(row.date, {
      date: row.date,
      codexTokens,
      claudeTokens,
      totalTokens: codexTokens + claudeTokens,
    });
  }

  const today = new Date();
  const daily = [];
  for (let offset = 55; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
    const key = date.toISOString().slice(0, 10);
    const row = byDate.get(key) || { date: key, codexTokens: 0, claudeTokens: 0, totalTokens: 0 };
    daily.push({
      ...row,
      weekday: date.getUTCDay(),
      label: shortDayLabel(date),
    });
  }

  const maxDailyTokens = Math.max(1, ...daily.map((row) => row.totalTokens));
  for (const row of daily) {
    row.intensity = row.totalTokens <= 0 ? 0 : Math.max(1, Math.ceil((row.totalTokens / maxDailyTokens) * 4));
  }

  const last7 = daily.slice(-7);
  const last28 = daily.slice(-28);
  const sum = (rows, key) => rows.reduce((total, row) => total + finiteNumber(row[key], 0), 0);
  const codex7 = sum(last7, 'codexTokens');
  const claude7 = sum(last7, 'claudeTokens');
  const total7 = codex7 + claude7;
  const codex28 = sum(last28, 'codexTokens');
  const claude28 = sum(last28, 'claudeTokens');
  const total28 = codex28 + claude28;
  const peak = daily.reduce((best, row) => row.totalTokens > best.totalTokens ? row : best, daily[0] || null);

  return {
    daily,
    maxDailyTokens,
    last7: {
      codexTokens: codex7,
      claudeTokens: claude7,
      totalTokens: total7,
      codexShare: total7 > 0 ? codex7 / total7 : null,
      claudeShare: total7 > 0 ? claude7 / total7 : null,
    },
    last28: {
      codexTokens: codex28,
      claudeTokens: claude28,
      totalTokens: total28,
      codexShare: total28 > 0 ? codex28 / total28 : null,
      claudeShare: total28 > 0 ? claude28 / total28 : null,
    },
    peakDay: peak,
  };
}

function normalizeProvider(key, label, model, raw) {
  const quota = model?.quota || {};
  const weekly = model?.windows?.weekly || model?.weekly || null;
  const fiveHour = model?.windows?.fiveHour || model?.fiveHour || null;
  const endpointHealth = model?.endpointHealth || {};
  const rawWindows = Array.isArray(raw?.live?.windows) ? raw.live.windows : [];
  const sourceStatus = sourceQuality(model, raw, weekly, fiveHour);
  return {
    key,
    label,
    status: model?.status || raw?.status || 'missing',
    state: model?.state || sourceStatus.state,
    score: finiteNumber(model?.score, 0),
    source: sourceStatus,
    quota: {
      weeklyUsedPercent: finiteNumber(quota.weeklyUsedPercent, weekly?.usedPercent),
      weeklyRemainingPercent: finiteNumber(quota.weeklyRemainingPercent, weekly?.remainingPercent),
      fiveHourUsedPercent: finiteNumber(quota.fiveHourUsedPercent, fiveHour?.usedPercent),
      fiveHourRemainingPercent: finiteNumber(quota.fiveHourRemainingPercent, fiveHour?.remainingPercent),
      projectedWeeklyPercent: finiteNumber(quota.projectedWeeklyPercent, weekly?.projectedPercent),
      expectedWeeklyPercent: finiteNumber(quota.expectedWeeklyPercent, weekly?.expectedPercent),
      weeklyPaceDeltaPercent: finiteNumber(quota.weeklyPaceDeltaPercent, weekly?.paceDeltaPercent),
      burnRate: finiteNumber(quota.burnRate, weekly?.burnRate),
      resetInDays: finiteNumber(quota.resetInDays, weekly?.resetInDays),
    },
    windows: {
      weekly: enrichWindow(weekly, rawWindows, 'weekly'),
      fiveHour: enrichWindow(fiveHour, rawWindows, 'five_hour'),
    },
    allowance: {
      todayPercent: finiteNumber(model?.allowance?.todayPercent, null),
      safeDailyPercent: finiteNumber(model?.forecast?.safeDailyPercent, null),
      schedule: Array.isArray(model?.allowance?.schedule) ? model.allowance.schedule.slice(0, 7) : [],
    },
    history: {
      weekly: model?.history?.weekly || weekly?.history || {},
      daily: model?.history?.daily || {},
    },
    endpointHealth: {
      state: endpointHealth.state || 'missing',
      ok: finiteNumber(endpointHealth.ok, 0),
      failed: finiteNumber(endpointHealth.failed, 0),
      stale: finiteNumber(endpointHealth.stale, 0),
    },
    errors: Array.isArray(raw?.errors) ? raw.errors.slice(0, 5) : [],
  };
}

function enrichWindow(window, rawWindows, fallbackKind) {
  if (!window) return null;
  const sameType = (item) => rawWindowMatchesType(item, fallbackKind);
  const raw = rawWindows.find((item) =>
    sameType(item) && (
      (item?.kind && item.kind === window.kind) ||
      (item?.id && item.id === window.id) ||
      (item?.name && item.name === window.name)
    )
  ) || rawWindows.find(sameType) || rawWindows.find((item) => item?.id === window.id) || {};
  return {
    ...window,
    windowDurationMins: finiteNumber(raw.windowDurationMins, fallbackKind === 'weekly' ? 7 * 24 * 60 : 5 * 60),
    quality: raw.quality || window.quality || null,
    stale: Boolean(raw.stale || window.stale),
    source: raw.source || window.source || null,
  };
}

function sourceQuality(model, raw, weekly, fiveHour) {
  const errors = Array.isArray(raw?.errors) ? raw.errors.length : 0;
  const status = model?.status || raw?.status || 'missing';
  const liveStatus = raw?.live?.status || null;
  const stale = Boolean(weekly?.stale || fiveHour?.stale);
  const missingWeekly = !Number.isFinite(Number(weekly?.usedPercent));
  let state = 'ok';
  if (status === 'error' || liveStatus === 'error') state = 'error';
  else if (stale) state = 'stale';
  else if (missingWeekly || status === 'missing') state = 'missing';
  else if (status === 'partial' || liveStatus === 'partial' || errors) state = 'partial';
  return { state, status, liveStatus, stale, errors, missingWeekly };
}

function addAgentSimulation(provider, activeAgents) {
  const providerAgents = activeAgents.filter((agent) => agent.provider === provider.key);
  const observedRate = estimateRates(provider);
  const divisor = Math.max(1, providerAgents.length || 1);
  const usageRate = {
    ...observedRate,
    observedPercentPerHour: observedRate.agentPercentPerHour,
    agentPercentPerHour: Number.isFinite(observedRate.agentPercentPerHour)
      ? observedRate.agentPercentPerHour / divisor
      : null,
  };
  const headroom = buildHeadroom(provider, usageRate, providerAgents.length);
  return {
    ...provider,
    activeAgents: providerAgents,
    rate: usageRate,
    headroom,
  };
}

function estimateRates(provider) {
  const weekly = provider.windows?.weekly;
  const fiveHour = provider.windows?.fiveHour;
  const weeklyElapsedHours = elapsedHours(weekly, 7 * 24);
  const fiveElapsedHours = elapsedHours(fiveHour, 5);
  const weeklyUsed = finiteNumber(provider.quota?.weeklyUsedPercent, weekly?.usedPercent);
  const fiveUsed = finiteNumber(provider.quota?.fiveHourUsedPercent, fiveHour?.usedPercent);
  const weeklyPerHour = rateFrom(weeklyUsed, weeklyElapsedHours);
  const fiveHourPerHour = rateFrom(fiveUsed, fiveElapsedHours);
  const blended = blendRates(weeklyPerHour, fiveHourPerHour);
  return {
    weeklyPercentPerHour: weeklyPerHour,
    fiveHourPercentPerHour: fiveHourPerHour,
    agentPercentPerHour: blended,
    confidence: rateConfidence(provider, weeklyPerHour, fiveHourPerHour),
  };
}

function buildHeadroom(provider, rate, activeCount) {
  const horizons = [0.5, 1, 2, 4, 8];
  const weeklyUsed = finiteNumber(provider.quota?.weeklyUsedPercent, null);
  const fiveUsed = finiteNumber(provider.quota?.fiveHourUsedPercent, null);
  const divisor = Math.max(1, activeCount || 1);
  const weeklyRateRaw = finiteNumber(rate.weeklyPercentPerHour, null);
  const fiveRateRaw = finiteNumber(rate.fiveHourPercentPerHour, null);
  const weeklyRate = Number.isFinite(weeklyRateRaw) ? weeklyRateRaw / divisor : null;
  const fiveRate = Number.isFinite(fiveRateRaw) ? fiveRateRaw / divisor : null;
  const agentRate = finiteNumber(rate.agentPercentPerHour, null);
  const rows = horizons.map((hours) => {
    const watch = maxAgentsFor({ weeklyUsed, fiveUsed, weeklyRate, fiveRate, agentRate, hours, threshold: 80 });
    const hard = maxAgentsFor({ weeklyUsed, fiveUsed, weeklyRate, fiveRate, agentRate, hours, threshold: 95 });
    return {
      hours,
      label: hours < 1 ? '30m' : `${hours}h`,
      active: activeCount,
      watchAgents: watch,
      hardAgents: hard,
      state: headroomState(activeCount, watch, hard),
    };
  });
  const limiting = limitingWindow({ weeklyUsed, fiveUsed, weeklyRate, fiveRate, agentRate, hours: 1 });
  return {
    active: activeCount,
    limitingWindow: limiting,
    rows,
    oneHour: rows.find((row) => row.hours === 1) || rows[0],
  };
}

function maxAgentsFor(input) {
  const caps = [];
  if (Number.isFinite(input.weeklyUsed) && Number.isFinite(input.weeklyRate) && input.weeklyRate > 0) {
    caps.push((input.threshold - input.weeklyUsed) / (input.weeklyRate * input.hours));
  }
  if (Number.isFinite(input.fiveUsed) && Number.isFinite(input.fiveRate) && input.fiveRate > 0) {
    caps.push((input.threshold - input.fiveUsed) / (input.fiveRate * input.hours));
  }
  if (!caps.length && Number.isFinite(input.agentRate) && input.agentRate > 0) {
    caps.push((input.threshold - 0) / (input.agentRate * input.hours));
  }
  if (!caps.length) return null;
  return Math.max(0, Math.floor(Math.min(...caps)));
}

function limitingWindow(input) {
  const weeklyCap = Number.isFinite(input.weeklyUsed) && Number.isFinite(input.weeklyRate) && input.weeklyRate > 0
    ? (95 - input.weeklyUsed) / (input.weeklyRate * input.hours)
    : Infinity;
  const fiveCap = Number.isFinite(input.fiveUsed) && Number.isFinite(input.fiveRate) && input.fiveRate > 0
    ? (95 - input.fiveUsed) / (input.fiveRate * input.hours)
    : Infinity;
  if (weeklyCap === Infinity && fiveCap === Infinity) return 'unknown';
  return fiveCap < weeklyCap ? '5h' : 'weekly';
}

function headroomState(active, watch, hard) {
  if (hard === null || watch === null) return 'unknown';
  if (active > hard) return 'limit';
  if (active > watch) return 'watch';
  return 'ok';
}

function buildRouting(providers) {
  return Object.values(providers)
    .map((provider) => ({
      key: provider.key,
      label: provider.label,
      score: provider.score,
      state: provider.state,
      activeAgents: provider.headroom?.active || 0,
      oneHourWatchAgents: provider.headroom?.oneHour?.watchAgents ?? null,
      limitingWindow: provider.headroom?.limitingWindow || 'unknown',
    }))
    .sort((a, b) => {
      const stateScore = (state) => ({ ok: 0, partial: 1, stale: 2, missing: 3, error: 4, unavailable: 5 }[state] ?? 3);
      const sd = stateScore(a.state) - stateScore(b.state);
      if (sd) return sd;
      return b.score - a.score;
    });
}

function normalizeAgents(agents) {
  return (Array.isArray(agents) ? agents : [])
    .map((agent) => ({
      id: String(agent.id || ''),
      provider: normalizeProviderName(agent.provider),
      cwd: agent.cwd || '',
      pid: agent.pid || null,
      ageSeconds: finiteNumber(agent.ageSeconds, null),
      lastOutputAgeSeconds: finiteNumber(agent.lastOutputAgeSeconds, null),
    }))
    .filter((agent) => agent.id && agent.provider !== 'shell');
}

function normalizeProviderName(provider) {
  if (provider === 'openai' || provider === 'codex') return 'codex';
  if (provider === 'anthropic' || provider === 'claude') return 'claude';
  return 'shell';
}

function emptyProvider(key, label) {
  return {
    key,
    label,
    status: 'missing',
    state: 'missing',
    score: 0,
    source: { state: 'missing', status: 'missing', missingWeekly: true },
    quota: {
      weeklyUsedPercent: null,
      weeklyRemainingPercent: null,
      fiveHourUsedPercent: null,
      fiveHourRemainingPercent: null,
      projectedWeeklyPercent: null,
      expectedWeeklyPercent: null,
      weeklyPaceDeltaPercent: null,
      burnRate: null,
      resetInDays: null,
    },
    windows: { weekly: null, fiveHour: null },
    allowance: { todayPercent: null, safeDailyPercent: null, schedule: [] },
    history: { weekly: {}, daily: {} },
    endpointHealth: { state: 'missing', ok: 0, failed: 0, stale: 0 },
    errors: [],
  };
}

function emptyStats() {
  return {
    daily: [],
    maxDailyTokens: 0,
    last7: { codexTokens: 0, claudeTokens: 0, totalTokens: 0, codexShare: null, claudeShare: null },
    last28: { codexTokens: 0, claudeTokens: 0, totalTokens: 0, codexShare: null, claudeShare: null },
    peakDay: null,
  };
}

function elapsedHours(window, fallbackHours) {
  const used = finiteNumber(window?.usedPercent, null);
  if (!Number.isFinite(used)) return null;
  const reset = Date.parse(window?.resetIso || '');
  const durationMins = finiteNumber(window?.windowDurationMins, fallbackHours * 60);
  if (!Number.isFinite(reset) || !Number.isFinite(durationMins) || durationMins <= 0) {
    return fallbackHours / 2;
  }
  const start = reset - durationMins * 60 * 1000;
  return Math.max(0.08, (Date.now() - start) / 3600000);
}

function rateFrom(usedPercent, elapsed) {
  if (!Number.isFinite(usedPercent) || !Number.isFinite(elapsed) || elapsed <= 0) return null;
  return Math.max(0, usedPercent / elapsed);
}

function blendRates(weekly, five) {
  const values = [weekly, five].filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return null;
  if (values.length === 1) return values[0];
  return values[0] * 0.35 + values[1] * 0.65;
}

function rateConfidence(provider, weeklyRate, fiveRate) {
  if (provider.source?.state === 'error' || provider.source?.state === 'missing') return 'low';
  if (provider.source?.state === 'stale' || !Number.isFinite(weeklyRate)) return 'low';
  if (!Number.isFinite(fiveRate)) return 'medium';
  return 'high';
}

function isWeeklyKind(kind) {
  return String(kind || '').includes('weekly') || String(kind || '').includes('seven_day');
}

function isFiveHourKind(kind) {
  return String(kind || '').includes('five') || String(kind || '').includes('5');
}

function rawWindowMatchesType(item, fallbackKind) {
  const mins = finiteNumber(item?.windowDurationMins, null);
  const kind = String(item?.kind || '');
  if (fallbackKind === 'weekly') {
    return isWeeklyKind(kind) || kind === 'secondary' || (Number.isFinite(mins) && mins >= 24 * 60);
  }
  return isFiveHourKind(kind) || kind === 'primary' || (Number.isFinite(mins) && mins <= 6 * 60);
}

function getJson(url, timeoutMs) {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 3_000_000) req.destroy(new Error('response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanError(error) {
  return String(error?.message || error || '').replace(/\s+/g, ' ').trim();
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function shortDayLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

module.exports = { UsageService };
