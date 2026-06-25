function buildUsageModel(payload, history) {
  const providers = {
    openai: buildProviderModel("openai", payload.providers?.openai, history),
    anthropic: buildProviderModel("anthropic", payload.providers?.anthropic, history)
  };

  const routing = rankProviders(providers);

  return {
    version: "usage_model_v2",
    generatedAt: payload.generatedAt,
    providers,
    routing,
    series: {
      dailyStack: buildDailyStack(history.daily),
      weeklyComparison: Object.values(providers).map((provider) => ({
        key: provider.key,
        label: provider.label,
        state: provider.state,
        score: provider.score,
        usedPercent: provider.quota.weeklyUsedPercent,
        projectedPercent: provider.quota.projectedWeeklyPercent,
        averagePeakPercent: provider.history.weekly.averagePeakPercent,
        p95PeakPercent: provider.history.weekly.p95PeakPercent,
        todayAllowancePercent: provider.allowance.todayPercent,
        burnRate: provider.quota.burnRate
      }))
    }
  };
}

function buildProviderModel(providerKey, provider, history) {
  const live = provider?.live || {};
  const windows = asArray(live.windows);
  const weeklyWindow = primaryWeeklyWindow(providerKey, windows);
  const fiveHourWindow = primaryFiveHourWindow(providerKey, windows);
  const weekly = forecastWindow(providerKey, weeklyWindow, history);
  const fiveHour = forecastWindow(providerKey, fiveHourWindow, history);
  const weekdayProfile = buildWeekdayProfile(providerKey, history.daily);
  const allowance = buildAllowanceSchedule(weekly, weekdayProfile);
  const forecast = buildForecast(weekly, fiveHour, allowance);
  const budget = buildBudget(weekly, fiveHour, forecast, live);
  const agentHealth = buildAgentHealth(providerKey, live, history);
  const endpointHealth = buildEndpointHealth(providerKey, provider, history);
  const state = providerState(weekly, fiveHour, agentHealth, endpointHealth);
  const score = providerScore({ weekly, fiveHour, allowance, agentHealth, endpointHealth, state });

  return {
    key: providerKey,
    label: provider?.label || providerKey,
    status: provider?.status || "missing",
    state,
    score,
    windows: {
      weekly,
      fiveHour
    },
    quota: {
      weeklyUsedPercent: weekly?.usedPercent ?? null,
      weeklyRemainingPercent: weekly?.remainingPercent ?? null,
      expectedWeeklyPercent: weekly?.expectedPercent ?? null,
      projectedWeeklyPercent: weekly?.projectedPercent ?? null,
      weeklyPaceDeltaPercent: weekly?.paceDeltaPercent ?? null,
      burnRate: weekly?.burnRate ?? null,
      fiveHourUsedPercent: fiveHour?.usedPercent ?? null,
      fiveHourRemainingPercent: fiveHour?.remainingPercent ?? null,
      resetInDays: weekly?.resetInDays ?? null
    },
    allowance,
    forecast,
    budget,
    history: {
      weekly: weekly?.history || emptyWindowHistory(),
      daily: weekdayProfile
    },
    agentHealth,
    endpointHealth,

    // Compatibility keys for the existing dashboard renderer.
    weekly,
    fiveHour,
    dayPattern: {
      weekdays: weekdayProfile.weekdays,
      recent: weekdayProfile.recent,
      quietDays: weekdayProfile.offDays,
      overallAverageTokens: weekdayProfile.meanDailyTokens,
      activeDayAverageTokens: weekdayProfile.meanActiveDayTokens,
      last7Tokens: weekdayProfile.last7Tokens,
      last28Tokens: weekdayProfile.last28Tokens
    },
    agents: agentHealth
  };
}

function forecastWindow(providerKey, window, history) {
  if (!window) return null;

  const now = new Date();
  const resetDate = resetDateFromWindow(window, now);
  const durationMs = Math.max(1, asNumber(window.windowDurationMins)) * 60 * 1000;
  const startDate = resetDate ? new Date(resetDate.getTime() - durationMs) : null;
  const elapsedFraction = startDate && resetDate
    ? clamp((now.getTime() - startDate.getTime()) / durationMs, 0.01, 1)
    : null;
  const usedPercent = boundedPercent(window.usedPercent);
  const expectedPercent = elapsedFraction === null ? null : boundedPercent(elapsedFraction * 100);
  const projectedPercent = elapsedFraction === null ? null : usedPercent / Math.max(0.01, elapsedFraction);
  const burnRate = expectedPercent ? usedPercent / Math.max(1, expectedPercent) : null;

  // Time-to-exhaustion: project the moment usedPercent reaches 100 at the
  // current observed burn rate (percent-of-cap consumed per millisecond).
  const elapsedMs = startDate ? now.getTime() - startDate.getTime() : null;
  const usedRatePerMs = elapsedMs && elapsedMs > 0 ? usedPercent / elapsedMs : null;
  const msToLimit = usedRatePerMs && usedRatePerMs > 0 && usedPercent < 100
    ? (100 - usedPercent) / usedRatePerMs
    : null;
  const exhaustionDate = msToLimit === null
    ? (usedPercent >= 100 ? now : null)
    : new Date(now.getTime() + msToLimit);
  const exhaustionInSeconds = exhaustionDate
    ? Math.max(0, (exhaustionDate.getTime() - now.getTime()) / 1000)
    : null;
  const willHitBeforeReset = Boolean(
    exhaustionDate && resetDate && exhaustionDate.getTime() <= resetDate.getTime()
  );
  const resetCycleKey = window.resetIso || window.resetText || null;
  const rows = historyForWindow(providerKey, window, history.windowCycles);
  const completeRows = resetCycleKey ? rows.filter((row) => row.resetCycleKey !== resetCycleKey) : rows;
  const modelRows = completeRows.length ? completeRows : rows;
  const peaks = modelRows.map((row) => asNumber(row.peakUsedPercent)).filter((value) => value > 0);

  return {
    id: window.id || null,
    name: window.name || null,
    kind: window.kind || null,
    windowLabel: window.windowLabel || windowLabel(window.windowDurationMins),
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    expectedPercent,
    projectedPercent,
    paceDeltaPercent: expectedPercent === null ? null : usedPercent - expectedPercent,
    burnRate,
    resetIso: resetDate ? resetDate.toISOString() : window.resetIso || null,
    resetText: window.resetText || null,
    resetInDays: resetDate ? Math.max(0, (resetDate.getTime() - now.getTime()) / 86400000) : null,
    exhaustionIso: exhaustionDate ? exhaustionDate.toISOString() : null,
    exhaustionInSeconds,
    willHitBeforeReset,
    history: {
      cycles: rows.length,
      completedCycles: completeRows.length,
      samples: rows.reduce((sum, row) => sum + asNumber(row.samples), 0),
      averagePeakPercent: average(peaks),
      medianPeakPercent: percentile(peaks, 0.5),
      p95PeakPercent: percentile(peaks, 0.95),
      maxPeakPercent: peaks.length ? Math.max(...peaks) : 0
    }
  };
}

function buildWeekdayProfile(providerKey, dailyRows) {
  const now = new Date();
  const byDate = new Map(asArray(dailyRows)
    .filter((row) => row.providerKey === providerKey)
    .map((row) => [row.date, row]));
  const recent = [];

  for (let offset = 55; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
    const key = date.toISOString().slice(0, 10);
    const row = byDate.get(key);
    recent.push({
      date: key,
      weekday: date.getUTCDay(),
      tokens: row ? asNumber(row.tokens) : 0,
      requests: row ? asNumber(row.requests) : 0,
      sessions: row ? asNumber(row.sessions) : 0,
      observed: Boolean(row)
    });
  }

  const meanDailyTokens = average(recent.map((row) => row.tokens));
  const meanActiveDayTokens = average(recent.filter((row) => row.tokens > 0).map((row) => row.tokens));
  const smoothing = Math.max(1, meanDailyTokens * 0.15);
  const weekdays = [];

  for (let weekday = 0; weekday < 7; weekday += 1) {
    const rows = recent.filter((row) => row.weekday === weekday);
    const avgTokens = average(rows.map((row) => row.tokens));
    const activeRate = rows.length ? rows.filter((row) => row.tokens > 0).length / rows.length : 0;
    const weight = meanDailyTokens > 0 ? clamp((avgTokens + smoothing) / (meanDailyTokens + smoothing), 0.2, 2.25) : 1;
    weekdays.push({
      weekday,
      label: weekdayLabel(weekday),
      avgTokens,
      activeRate,
      weight,
      offDayScore: meanDailyTokens > 0 ? 1 - Math.min(1, avgTokens / meanDailyTokens) : 0,
      quiet: meanDailyTokens > 0 && avgTokens < meanDailyTokens * 0.45
    });
  }

  return {
    horizonDays: recent.length,
    observedDays: recent.filter((row) => row.observed).length,
    activeDays: recent.filter((row) => row.tokens > 0).length,
    meanDailyTokens,
    meanActiveDayTokens,
    last7Tokens: recent.slice(-7).reduce((sum, row) => sum + row.tokens, 0),
    last28Tokens: recent.slice(-28).reduce((sum, row) => sum + row.tokens, 0),
    offDays: weekdays.filter((row) => row.quiet).map((row) => row.label),
    weekdays,
    recent: recent.slice(-28)
  };
}

function buildAllowanceSchedule(weekly, weekdayProfile) {
  if (!weekly?.resetIso) {
    return {
      todayPercent: null,
      steadyDailyPercent: null,
      remainingPercent: weekly?.remainingPercent ?? null,
      schedule: []
    };
  }

  const reset = new Date(weekly.resetIso);
  if (Number.isNaN(reset.getTime())) {
    return {
      todayPercent: weekly.remainingPercent,
      steadyDailyPercent: weekly.remainingPercent,
      remainingPercent: weekly.remainingPercent,
      schedule: []
    };
  }

  const today = startOfLocalDay(new Date());
  const resetDay = startOfLocalDay(reset);
  const days = [];
  for (let cursor = new Date(today); cursor <= resetDay && days.length < 14; cursor.setDate(cursor.getDate() + 1)) {
    const weekday = cursor.getDay();
    const profile = weekdayProfile.weekdays.find((row) => row.weekday === weekday);
    days.push({
      date: cursor.toISOString().slice(0, 10),
      weekday,
      label: weekdayLabel(weekday),
      weight: profile?.weight || 1,
      offDayScore: profile?.offDayScore || 0,
      quiet: Boolean(profile?.quiet)
    });
  }

  const totalWeight = days.reduce((sum, day) => sum + day.weight, 0) || 1;
  const schedule = days.map((day) => ({
    ...day,
    allowancePercent: weekly.remainingPercent * day.weight / totalWeight
  }));
  const daysLeft = Math.max(1, weekly.resetInDays || days.length || 1);

  return {
    todayPercent: schedule[0]?.allowancePercent ?? weekly.remainingPercent,
    steadyDailyPercent: weekly.remainingPercent / daysLeft,
    remainingPercent: weekly.remainingPercent,
    schedule
  };
}

function buildForecast(weekly, fiveHour, allowance) {
  if (!weekly) {
    return {
      available: false,
      headline: "No live weekly window",
      verdict: "unknown",
      points: []
    };
  }

  const used = boundedPercent(weekly.usedPercent);
  const remaining = Math.max(0, 100 - used);
  const windowDays = 7;
  const daysLeft = clamp(asNumber(weekly.resetInDays), 0, windowDays) || null;
  const elapsedDays = daysLeft === null ? null : Math.max(0.25, windowDays - daysLeft);

  // Current observed daily burn (percent of the weekly cap consumed per day so
  // far) versus the steady pace that would spend the rest exactly at reset.
  const currentDailyPercent = elapsedDays ? used / elapsedDays : null;
  const safeDailyPercent = daysLeft ? remaining / Math.max(0.25, daysLeft) : null;
  const recommendedTodayPercent = asNumber(allowance?.todayPercent) || safeDailyPercent;
  const paceRatio = currentDailyPercent && safeDailyPercent
    ? currentDailyPercent / Math.max(0.01, safeDailyPercent)
    : null;

  // Burn-down trajectory: from today to reset, plot the projected cumulative
  // use (current daily burn held flat) against the safe steady pace and the
  // 100% limit ceiling. This is the chart that answers "will I run out, when".
  const horizon = daysLeft === null ? 0 : Math.min(10, Math.max(1, Math.ceil(daysLeft)));
  const points = [];
  for (let day = 0; day <= horizon; day += 1) {
    const projected = currentDailyPercent === null ? used : used + currentDailyPercent * day;
    const safe = safeDailyPercent === null ? used : used + safeDailyPercent * day;
    points.push({
      day,
      label: day === 0 ? "now" : `+${day}d`,
      projected: Math.max(0, projected),
      safe: clamp(safe, 0, 100),
      limit: 100
    });
  }

  // Pick the most urgent exhaustion signal across the 5h and weekly windows.
  const candidates = [
    fiveHour?.willHitBeforeReset ? { scope: "5h", seconds: fiveHour.exhaustionInSeconds, iso: fiveHour.exhaustionIso } : null,
    weekly?.willHitBeforeReset ? { scope: "weekly", seconds: weekly.exhaustionInSeconds, iso: weekly.exhaustionIso } : null
  ].filter((row) => row && Number.isFinite(row.seconds));
  candidates.sort((a, b) => a.seconds - b.seconds);
  const exhaustion = candidates[0] || null;

  let verdict = "on_track";
  if (used >= 100 || (fiveHour && asNumber(fiveHour.usedPercent) >= 100)) verdict = "exhausted";
  else if (exhaustion) verdict = "will_hit";
  else if (paceRatio !== null && paceRatio >= 1.15) verdict = "over_pace";
  else if (paceRatio !== null && paceRatio <= 0.6) verdict = "under_pace";

  const headline = forecastHeadline(verdict, exhaustion, paceRatio, remaining);

  return {
    available: true,
    verdict,
    headline,
    exhaustion,
    usedPercent: used,
    remainingPercent: remaining,
    daysLeft,
    currentDailyPercent,
    safeDailyPercent,
    recommendedTodayPercent,
    paceRatio,
    confidenceCycles: asNumber(weekly.history?.completedCycles),
    points
  };
}

function buildBudget(weekly, fiveHour, forecast, live) {
  const used5h = fiveHour ? boundedPercent(fiveHour.usedPercent) : null;
  const room5h = used5h === null ? null : Math.max(0, 100 - used5h);
  const weeklyRoom = weekly ? Math.max(0, 100 - boundedPercent(weekly.usedPercent)) : null;
  const safeDaily = forecast?.safeDailyPercent ?? null;
  const currentDaily = forecast?.currentDailyPercent ?? null;
  const safeToday = forecast?.recommendedTodayPercent ?? null;

  // Influx headroom: how many multiples of the load you have already put on the
  // 5h window you could still absorb before the short limit bites.
  const surgeMultiple = used5h && used5h > 0 && room5h !== null ? room5h / used5h : null;

  // Concurrent agents. Estimate one agent's load, then how many more fit inside
  // the sustainable daily budget and the immediate 5h burst budget.
  const activeAgents = Math.max(0, Math.round(asNumber(live?.activeAgents)));
  let perAgentDaily = null;
  let basis = "no recent activity to size agents";
  if (currentDaily && currentDaily > 0) {
    if (activeAgents > 0) {
      perAgentDaily = currentDaily / activeAgents;
      basis = `${activeAgents} live agent${activeAgents === 1 ? "" : "s"} now`;
    } else {
      perAgentDaily = currentDaily;
      basis = "current pace counts as 1 agent";
    }
  }
  const running = activeAgents > 0 ? activeAgents : (perAgentDaily ? 1 : 0);
  const sustainableAgents = perAgentDaily && safeDaily != null
    ? Math.floor(safeDaily / perAgentDaily)
    : null;
  const addSustained = sustainableAgents === null ? null : Math.max(0, sustainableAgents - running);

  const perAgent5h = used5h && used5h > 0
    ? (activeAgents > 0 ? used5h / activeAgents : used5h)
    : null;
  const burstAgents = perAgent5h && room5h !== null ? Math.floor(room5h / perAgent5h) : null;
  const addBurst = burstAgents === null ? null : Math.max(0, burstAgents - running);

  const addCandidates = [addSustained, addBurst].filter((value) => value !== null);
  const concurrentAdd = addCandidates.length ? Math.min(...addCandidates) : null;
  const limitedBy = addCandidates.length
    ? (addSustained !== null && addSustained === concurrentAdd ? "weekly budget" : "5h burst")
    : null;

  return {
    available: Boolean(weekly || fiveHour),
    room5h,
    weeklyRoom,
    safeToday,
    safeDaily,
    currentDaily,
    used5h,
    surgeMultiple,
    activeAgents,
    perAgentDailyPercent: perAgentDaily,
    concurrentAdd,
    sustainableAgents,
    burstAgents,
    limitedBy,
    basis
  };
}

function forecastHeadline(verdict, exhaustion, paceRatio, remaining) {
  if (verdict === "exhausted") return "Limit reached - throttled until reset";
  if (verdict === "will_hit" && exhaustion) {
    const scope = exhaustion.scope === "5h" ? "5h cap" : "weekly limit";
    return `Hits ${scope} in ${humanizeSeconds(exhaustion.seconds)} at this pace`;
  }
  if (verdict === "over_pace") {
    const over = paceRatio ? Math.round((paceRatio - 1) * 100) : 0;
    return `Burning ${over}% over safe pace - ${Math.round(remaining)}% left this week`;
  }
  if (verdict === "under_pace") {
    return `Comfortably under pace - ${Math.round(remaining)}% headroom left`;
  }
  return `On track - ${Math.round(remaining)}% of the week left`;
}

function humanizeSeconds(seconds) {
  const total = Math.max(0, Math.round(asNumber(seconds)));
  if (total <= 0) return "moments";
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function buildAgentHealth(providerKey, live, history) {
  const latest = asArray(history.agents).find((row) => row.providerKey === providerKey);
  const raw = parseJson(latest?.rawJson) || {};
  const rows = asArray(raw.rows);
  const total = asNumber(latest?.total ?? raw.total);
  const failed = asNumber(latest?.failed ?? raw.failed);
  const stale = asNumber(latest?.stale ?? raw.stale);
  const endpointOk = latest ? Boolean(asNumber(latest.endpointOk)) : Boolean(raw.endpointOk);
  const state = !endpointOk ? "error" : failed > 0 || stale > 0 ? "watch" : "ok";

  return {
    providerKey,
    label: providerKey === "anthropic" ? "Claude agents" : "Codex endpoints",
    state,
    status: state,
    endpointOk,
    total,
    active: asNumber(latest?.active ?? raw.active),
    idle: asNumber(latest?.idle ?? raw.idle),
    busy: asNumber(latest?.busy ?? raw.busy),
    waiting: asNumber(latest?.waiting ?? raw.waiting),
    stale,
    failed,
    daemonRunning: latest?.daemonRunning === null || latest?.daemonRunning === undefined
      ? raw.daemonRunning ?? null
      : Boolean(asNumber(latest.daemonRunning)),
    rows: rows.slice(0, 12),
    items: rows.slice(0, 12)
  };
}

function buildEndpointHealth(providerKey, provider, history) {
  const latestByKey = new Map();
  for (const row of asArray(history.endpoints).filter((item) => item.providerKey === providerKey)) {
    if (!latestByKey.has(row.endpointKey)) latestByKey.set(row.endpointKey, row);
  }

  const rows = latestByKey.size
    ? Array.from(latestByKey.values())
    : asArray(provider?.endpoints).map((endpoint) => ({
        endpointKey: endpoint.key || endpoint.label,
        endpointLabel: endpoint.label || endpoint.key,
        status: endpoint.status || "unknown",
        error: endpoint.error || null
      }));
  const failed = rows.filter((row) => row.status !== "ok").length;

  return {
    state: failed ? "error" : rows.length ? "ok" : "missing",
    total: rows.length,
    ok: rows.filter((row) => row.status === "ok").length,
    failed,
    rows: rows.slice(0, 12)
  };
}

function rankProviders(providers) {
  const ordered = Object.values(providers)
    .map((provider) => ({
      key: provider.key,
      label: provider.label,
      score: provider.score,
      state: provider.state,
      todayAllowancePercent: provider.allowance.todayPercent,
      fiveHourUsedPercent: provider.quota.fiveHourUsedPercent,
      projectedWeeklyPercent: provider.quota.projectedWeeklyPercent,
      burnRate: provider.quota.burnRate
    }))
    .sort((a, b) => b.score - a.score);

  return {
    defaultProviderKey: ordered[0]?.key || null,
    ordered
  };
}

function providerState(weekly, fiveHour, agentHealth, endpointHealth) {
  if (agentHealth.state === "error" || endpointHealth.state === "error") return "error";
  if (fiveHour?.usedPercent >= 90) return "limit";
  if ((weekly?.projectedPercent ?? 0) >= 110) return "overpace";
  if (fiveHour?.usedPercent >= 75 || (weekly?.burnRate ?? 0) >= 1.2 || agentHealth.state === "watch") return "watch";
  return "ok";
}

function providerScore({ weekly, fiveHour, allowance, agentHealth, endpointHealth, state }) {
  let score = 100;
  const statePenalty = { ok: 0, watch: 18, overpace: 32, limit: 65, error: 80, missing: 30 };
  score -= statePenalty[state] || 0;
  score -= Math.min(35, asNumber(fiveHour?.usedPercent) * 0.25);
  score -= Math.max(0, asNumber(weekly?.projectedPercent) - 95) * 0.45;
  score += Math.min(12, asNumber(allowance?.todayPercent) * 0.5);
  score -= asNumber(agentHealth.failed) * 8;
  score -= asNumber(agentHealth.stale) * 4;
  score -= asNumber(endpointHealth.failed) * 10;
  return Math.max(0, Math.round(score));
}

function buildDailyStack(dailyRows) {
  const dates = Array.from(new Set(asArray(dailyRows).map((row) => row.date))).sort().slice(-90);
  return dates.map((date) => {
    const rows = asArray(dailyRows).filter((row) => row.date === date);
    return {
      date,
      openaiTokens: sum(rows.filter((row) => row.providerKey === "openai").map((row) => row.tokens)),
      anthropicTokens: sum(rows.filter((row) => row.providerKey === "anthropic").map((row) => row.tokens))
    };
  });
}

function primaryWeeklyWindow(providerKey, windows) {
  const rows = asArray(windows).filter((item) => asNumber(item.windowDurationMins) === 10080);
  if (providerKey === "anthropic") {
    return rows.find((item) => item.kind === "seven_day")
      || rows.find((item) => !String(item.kind || "").includes("sonnet"))
      || rows[0]
      || null;
  }
  return rows.find((item) => String(item.id || item.name || "").toLowerCase() === "codex")
    || rows.find((item) => String(item.name || "").toLowerCase().includes("codex") && !String(item.name || "").toLowerCase().includes("spark"))
    || rows[0]
    || null;
}

function primaryFiveHourWindow(providerKey, windows) {
  const rows = asArray(windows).filter((item) => asNumber(item.windowDurationMins) === 300);
  if (providerKey === "anthropic") return rows.find((item) => item.kind === "five_hour") || rows[0] || null;
  return rows.find((item) => String(item.id || item.name || "").toLowerCase() === "codex")
    || rows.find((item) => String(item.name || "").toLowerCase().includes("codex") && !String(item.name || "").toLowerCase().includes("spark"))
    || rows[0]
    || null;
}

function historyForWindow(providerKey, window, rows) {
  const candidates = asArray(rows).filter((row) => (
    row.providerKey === providerKey
    && asNumber(row.windowDurationMins) === asNumber(window.windowDurationMins)
  ));
  const exact = candidates.filter((row) => row.windowKey === window.id);
  if (exact.length) return exact;
  const sameKind = candidates.filter((row) => row.windowKind === window.kind);
  return sameKind.length ? sameKind : candidates;
}

function resetDateFromWindow(window, now = new Date()) {
  if (window?.resetIso) {
    const date = new Date(window.resetIso);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return resetDateFromText(window?.resetText, now);
}

function resetDateFromText(text, now = new Date()) {
  if (!text) return null;
  const clean = String(text).replace(/\s*\([^)]+\)/g, "").replace(/\s+/g, " ").trim();
  const dateMatch = clean.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (dateMatch) {
    const [, monthName, day, hour, minute = "0", meridiem] = dateMatch;
    const month = monthIndex(monthName);
    if (month !== null) {
      const date = new Date(now.getFullYear(), month, Number(day), hour24(hour, meridiem), Number(minute));
      if (date.getTime() < now.getTime() - 86400000) date.setFullYear(date.getFullYear() + 1);
      return date;
    }
  }

  const timeMatch = clean.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i) || clean.match(/^(\d{1,2}):(\d{2})/);
  if (!timeMatch) return null;
  const [, hour, minute = "0", meridiem] = timeMatch;
  const date = new Date(now);
  date.setHours(hour24(hour, meridiem), Number(minute), 0, 0);
  if (date <= now) date.setDate(date.getDate() + 1);
  return date;
}

function monthIndex(value) {
  const index = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(String(value).toLowerCase());
  return index >= 0 ? index : null;
}

function hour24(hour, meridiem) {
  let value = Number(hour);
  const suffix = String(meridiem || "").toLowerCase();
  if (suffix === "pm" && value < 12) value += 12;
  if (suffix === "am" && value === 12) value = 0;
  return value;
}

function emptyWindowHistory() {
  return {
    cycles: 0,
    completedCycles: 0,
    samples: 0,
    averagePeakPercent: 0,
    medianPeakPercent: 0,
    p95PeakPercent: 0,
    maxPeakPercent: 0
  };
}

function windowLabel(minutes) {
  const value = asNumber(minutes);
  if (!value) return "Live window";
  if (value === 300) return "5 hours";
  if (value === 10080) return "7 days";
  if (value % 1440 === 0) return `${value / 1440} days`;
  if (value % 60 === 0) return `${value / 60} hours`;
  return `${value} minutes`;
}

function weekdayLabel(weekday) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday] || "Day";
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function boundedPercent(value) {
  return clamp(asNumber(value), 0, 100);
}

function percentile(values, p) {
  const sorted = values.map(asNumber).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function average(values) {
  const numbers = values.map(asNumber).filter((value) => Number.isFinite(value));
  if (!numbers.length) return 0;
  return sum(numbers) / numbers.length;
}

function sum(values) {
  return values.reduce((total, value) => total + asNumber(value), 0);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

module.exports = {
  buildUsageModel
};
