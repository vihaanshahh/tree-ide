const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

async function persistUsageSnapshot(payload, options) {
  const dbPath = options.dbPath;
  await ensureWarehouse(dbPath);
  await writeSnapshot(dbPath, payload);
  const history = await readWarehouseHistory(dbPath);

  return {
    storage: {
      status: "ok",
      path: dbPath,
      schema: "tokenmax_usage_warehouse_v2",
      tables: await tableCounts(dbPath)
    },
    history
  };
}

async function ensureWarehouse(dbPath) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await sqliteExec(dbPath, `
    pragma journal_mode = wal;

    create table if not exists dim_provider (
      provider_key text primary key,
      provider_label text not null,
      first_seen_at text not null,
      last_seen_at text not null
    );

    create table if not exists fact_limit_window (
      id integer primary key autoincrement,
      captured_at text not null,
      provider_key text not null,
      window_key text not null,
      window_name text,
      window_kind text,
      window_duration_mins integer,
      used_percent real,
      remaining_percent real,
      reset_at text,
      reset_label text,
      reset_cycle_key text,
      plan_type text,
      raw_json text
    );

    create index if not exists idx_fact_limit_window_lookup
      on fact_limit_window(provider_key, window_duration_mins, window_key, captured_at);

    create table if not exists fact_daily_usage (
      provider_key text not null,
      date text not null,
      weekday integer not null,
      updated_at text not null,
      tokens real not null default 0,
      requests real not null default 0,
      sessions real not null default 0,
      input_tokens real not null default 0,
      output_tokens real not null default 0,
      cache_tokens real not null default 0,
      cost_usd real not null default 0,
      raw_json text,
      primary key(provider_key, date)
    );

    create index if not exists idx_fact_daily_usage_provider_date
      on fact_daily_usage(provider_key, date);

    create table if not exists fact_endpoint_health (
      id integer primary key autoincrement,
      captured_at text not null,
      provider_key text not null,
      endpoint_key text not null,
      endpoint_label text,
      status text,
      error text
    );

    create index if not exists idx_fact_endpoint_health_lookup
      on fact_endpoint_health(provider_key, endpoint_key, captured_at);

    create table if not exists fact_agent_health (
      id integer primary key autoincrement,
      captured_at text not null,
      provider_key text not null,
      total integer not null default 0,
      active integer not null default 0,
      idle integer not null default 0,
      busy integer not null default 0,
      waiting integer not null default 0,
      stale integer not null default 0,
      failed integer not null default 0,
      endpoint_ok integer not null default 0,
      daemon_running integer,
      raw_json text
    );

    create index if not exists idx_fact_agent_health_lookup
      on fact_agent_health(provider_key, captured_at);
  `);
}

async function writeSnapshot(dbPath, payload) {
  const capturedAt = payload.generatedAt || new Date().toISOString();
  const statements = [];

  for (const [providerKey, provider] of Object.entries(payload.providers || {})) {
    const label = provider.label || providerKey;
    statements.push(`
      insert into dim_provider(provider_key, provider_label, first_seen_at, last_seen_at)
      values(${sqlString(providerKey)}, ${sqlString(label)}, ${sqlString(capturedAt)}, ${sqlString(capturedAt)})
      on conflict(provider_key) do update set
        provider_label = excluded.provider_label,
        last_seen_at = excluded.last_seen_at;
    `);

    for (const item of asArray(provider.live?.windows)) {
      const resetLabel = item.resetText || null;
      const resetAt = item.resetIso || null;
      const resetCycleKey = resetAt || resetLabel || `${item.id || item.kind || "window"}:${item.windowDurationMins || 0}`;
      const used = boundedPercent(item.usedPercent);
      statements.push(`
        insert into fact_limit_window (
          captured_at, provider_key, window_key, window_name, window_kind,
          window_duration_mins, used_percent, remaining_percent, reset_at, reset_label,
          reset_cycle_key, plan_type, raw_json
        ) values (
          ${sqlString(capturedAt)},
          ${sqlString(providerKey)},
          ${sqlString(item.id || item.name || item.kind || "window")},
          ${sqlString(item.name || item.id || "window")},
          ${sqlString(item.kind || null)},
          ${sqlNumber(item.windowDurationMins)},
          ${sqlNumber(used)},
          ${sqlNumber(100 - used)},
          ${sqlString(resetAt)},
          ${sqlString(resetLabel)},
          ${sqlString(resetCycleKey)},
          ${sqlString(item.planType || provider.live?.account?.planType || null)},
          ${sqlString(JSON.stringify(item))}
        );
      `);
    }

    for (const day of asArray(provider.daily)) {
      if (!day.date) continue;
      const tokens = totalTokens(day);
      const sessions = asNumber(day.codeSessions) + asNumber(day.claudeCodeSessions);
      statements.push(`
        insert into fact_daily_usage (
          provider_key, date, weekday, updated_at, tokens, requests, sessions,
          input_tokens, output_tokens, cache_tokens, cost_usd, raw_json
        ) values (
          ${sqlString(providerKey)},
          ${sqlString(day.date)},
          ${sqlNumber(weekday(day.date))},
          ${sqlString(capturedAt)},
          ${sqlNumber(tokens)},
          ${sqlNumber(day.requests)},
          ${sqlNumber(sessions)},
          ${sqlNumber(day.inputTokens)},
          ${sqlNumber(day.outputTokens)},
          ${sqlNumber(day.cacheTokens)},
          ${sqlNumber(day.costUsd)},
          ${sqlString(JSON.stringify(day))}
        )
        on conflict(provider_key, date) do update set
          weekday = excluded.weekday,
          updated_at = excluded.updated_at,
          tokens = excluded.tokens,
          requests = excluded.requests,
          sessions = excluded.sessions,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_tokens = excluded.cache_tokens,
          cost_usd = excluded.cost_usd,
          raw_json = excluded.raw_json;
      `);
    }

    for (const endpoint of asArray(provider.endpoints)) {
      statements.push(`
        insert into fact_endpoint_health (
          captured_at, provider_key, endpoint_key, endpoint_label, status, error
        ) values (
          ${sqlString(capturedAt)},
          ${sqlString(providerKey)},
          ${sqlString(endpoint.key || endpoint.label || "endpoint")},
          ${sqlString(endpoint.label || endpoint.key || "endpoint")},
          ${sqlString(endpoint.status || "unknown")},
          ${sqlString(endpoint.error || null)}
        );
      `);
    }

    const agents = summarizeAgents(providerKey, provider.live || {});
    statements.push(`
      insert into fact_agent_health (
        captured_at, provider_key, total, active, idle, busy, waiting, stale,
        failed, endpoint_ok, daemon_running, raw_json
      ) values (
        ${sqlString(capturedAt)},
        ${sqlString(providerKey)},
        ${sqlNumber(agents.total)},
        ${sqlNumber(agents.active)},
        ${sqlNumber(agents.idle)},
        ${sqlNumber(agents.busy)},
        ${sqlNumber(agents.waiting)},
        ${sqlNumber(agents.stale)},
        ${sqlNumber(agents.failed)},
        ${agents.endpointOk ? 1 : 0},
        ${agents.daemonRunning === null ? "null" : agents.daemonRunning ? 1 : 0},
        ${sqlString(JSON.stringify(agents))}
      );
    `);
  }

  statements.push("delete from fact_limit_window where captured_at < datetime('now', '-365 days');");
  statements.push("delete from fact_endpoint_health where captured_at < datetime('now', '-90 days');");
  statements.push("delete from fact_agent_health where captured_at < datetime('now', '-90 days');");
  statements.push("delete from fact_daily_usage where date < date('now', '-365 days');");

  await sqliteExec(dbPath, statements.join("\n"));
}

async function readWarehouseHistory(dbPath) {
  const [windowCycles, daily, agents, endpoints] = await Promise.all([
    sqliteJson(dbPath, `
      select
        provider_key as providerKey,
        window_key as windowKey,
        window_name as windowName,
        window_kind as windowKind,
        window_duration_mins as windowDurationMins,
        reset_cycle_key as resetCycleKey,
        max(used_percent) as peakUsedPercent,
        avg(used_percent) as avgUsedPercent,
        min(captured_at) as firstSeenAt,
        max(captured_at) as lastSeenAt,
        count(*) as samples
      from fact_limit_window
      where captured_at >= datetime('now', '-365 days')
      group by provider_key, window_key, window_name, window_kind, window_duration_mins, reset_cycle_key
      order by lastSeenAt desc;
    `),
    sqliteJson(dbPath, `
      select
        provider_key as providerKey,
        date,
        weekday,
        tokens,
        requests,
        sessions,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        cache_tokens as cacheTokens,
        cost_usd as costUsd,
        updated_at as updatedAt
      from fact_daily_usage
      where date >= date('now', '-365 days')
      order by date asc;
    `),
    sqliteJson(dbPath, `
      select
        provider_key as providerKey,
        captured_at as capturedAt,
        total,
        active,
        idle,
        busy,
        waiting,
        stale,
        failed,
        endpoint_ok as endpointOk,
        daemon_running as daemonRunning,
        raw_json as rawJson
      from fact_agent_health
      where captured_at >= datetime('now', '-90 days')
      order by captured_at desc
      limit 500;
    `),
    sqliteJson(dbPath, `
      select
        provider_key as providerKey,
        captured_at as capturedAt,
        endpoint_key as endpointKey,
        endpoint_label as endpointLabel,
        status,
        error
      from fact_endpoint_health
      where captured_at >= datetime('now', '-30 days')
      order by captured_at desc
      limit 1000;
    `)
  ]);

  return { windowCycles, daily, agents, endpoints };
}

async function tableCounts(dbPath) {
  const rows = await sqliteJson(dbPath, `
    select 'dim_provider' as name, count(*) as rows from dim_provider
    union all select 'fact_limit_window', count(*) from fact_limit_window
    union all select 'fact_daily_usage', count(*) from fact_daily_usage
    union all select 'fact_endpoint_health', count(*) from fact_endpoint_health
    union all select 'fact_agent_health', count(*) from fact_agent_health;
  `);
  return rows.reduce((acc, row) => {
    acc[row.name] = asNumber(row.rows);
    return acc;
  }, {});
}

function summarizeAgents(providerKey, live) {
  if (providerKey !== "anthropic") {
    const endpoints = asArray(live.endpoints);
    const failed = endpoints.filter((endpoint) => endpoint.status !== "ok").length;
    return {
      providerKey,
      total: endpoints.length,
      active: endpoints.filter((endpoint) => endpoint.status === "ok").length,
      idle: 0,
      busy: 0,
      waiting: 0,
      stale: 0,
      failed,
      endpointOk: endpoints.length > 0 && failed === 0,
      daemonRunning: null,
      rows: endpoints.map((endpoint) => ({
        id: endpoint.key || endpoint.label,
        label: endpoint.label || endpoint.key,
        status: endpoint.status || "unknown",
        failed: endpoint.status !== "ok"
      }))
    };
  }

  const agents = asArray(live.agents);
  const now = Date.now();
  const rows = agents.map((agent) => {
    const status = String(agent.status || agent.state || agent.phase || "unknown").toLowerCase();
    const failed = /fail|error|crash|cancel/.test(status);
    const terminal = /complete|stop|done|finish|success/.test(status);
    const timestamp = agent.updatedAt || agent.updated_at || agent.lastActivityAt || agent.last_activity_at || agent.lastActiveAt || agent.createdAt || agent.created_at;
    const lastSeenMs = Date.parse(timestamp || "");
    const stale = !failed && !terminal && Number.isFinite(lastSeenMs) && now - lastSeenMs > 30 * 60 * 1000;
    return {
      id: agent.id || agent.agentId || agent.uuid || agent.name || "agent",
      label: agent.name || agent.id || agent.agentId || agent.uuid || "Claude agent",
      status,
      active: !failed && !terminal,
      idle: status === "idle",
      busy: /busy|running|working/.test(status),
      waiting: /wait|queued|pending/.test(status),
      failed,
      stale,
      lastSeen: Number.isFinite(lastSeenMs) ? new Date(lastSeenMs).toISOString() : null
    };
  });

  const endpoint = asArray(live.endpoints).find((item) => item.label === "claude agents --json --all");
  return {
    providerKey,
    total: rows.length,
    active: rows.filter((row) => row.active).length,
    idle: rows.filter((row) => row.idle).length,
    busy: rows.filter((row) => row.busy).length,
    waiting: rows.filter((row) => row.waiting).length,
    stale: rows.filter((row) => row.stale).length,
    failed: rows.filter((row) => row.failed).length,
    endpointOk: !endpoint || endpoint.status === "ok",
    daemonRunning: live.daemon?.running ?? null,
    rows: rows.slice(0, 50)
  };
}

async function sqliteJson(dbPath, sql) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await runCommand("sqlite3", ["-cmd", ".timeout 10000", "-json", dbPath, sql], 20 * 1024 * 1024);
      return result.stdout.trim() ? JSON.parse(result.stdout) : [];
    } catch (error) {
      lastError = error;
      if (!isSqliteLocked(error) || attempt === 2) break;
      await delay(250 * (attempt + 1));
    }
  }
  throw lastError;
}

async function sqliteExec(dbPath, sql) {
  await runCommand("sqlite3", ["-cmd", ".timeout 10000", dbPath, sql], 20 * 1024 * 1024);
}

function runCommand(command, args, maxBuffer) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || "").trim() || error.message));
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function isSqliteLocked(error) {
  return /database is locked|SQLITE_BUSY|locked \(5\)/i.test(String(error?.message || error || ""));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function totalTokens(source) {
  return asNumber(source?.subscriptionTokens)
    + asNumber(source?.inputTokens)
    + asNumber(source?.outputTokens)
    + asNumber(source?.cacheTokens)
    + asNumber(source?.audioTokens);
}

function weekday(date) {
  const value = new Date(`${date}T00:00:00Z`).getUTCDay();
  return Number.isFinite(value) ? value : 0;
}

function boundedPercent(value) {
  return Math.max(0, Math.min(100, asNumber(value)));
}

function sqlString(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "null";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

module.exports = {
  persistUsageSnapshot
};
