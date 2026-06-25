// TokenMax usage engine — embedded in tree-ide.
//
// Lifted from the standalone TokenMax dashboard (its server.js) with the HTTP
// server, static file serving, and SSE streaming stripped out. tree-ide calls
// buildUsagePayload() in-process via src/usage/service.js, so the usage panel
// works with no separate service running.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { execFile, spawn } = require("node:child_process");
const { persistUsageSnapshot } = require("./warehouse");
const { buildUsageModel } = require("./model");

// The usage warehouse (sqlite history) must live somewhere writable, so it
// defaults under the user's home dir rather than next to the (read-only,
// asar-packed) app code. Overridable via env or configure().
let TOKENMAX_DATA_DIR = process.env.TREE_TOKENMAX_DATA_DIR || process.env.TOKENMAX_DATA_DIR || path.join(os.homedir(), ".tree-ide", "tokenmax");
let TOKENMAX_DB_PATH = process.env.TREE_TOKENMAX_DB_PATH || process.env.TOKENMAX_DB_PATH || path.join(TOKENMAX_DATA_DIR, "usage.sqlite");
const CODEX_STATE_DB = process.env.TOKENMAX_CODEX_STATE_DB || path.join(os.homedir(), ".codex", "state_5.sqlite");
const CLAUDE_PROJECTS_DIR = process.env.TOKENMAX_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
const CLAUDE_STATS_CACHE = process.env.TOKENMAX_CLAUDE_STATS_CACHE || path.join(os.homedir(), ".claude", "stats-cache.json");
const REFRESH_SECONDS = clamp(Number(process.env.TOKENMAX_REFRESH_SECONDS || 60), 15, 3600);
const CODEX_LIVE_TIMEOUT_MS = clamp(Number(process.env.TOKENMAX_CODEX_LIVE_TIMEOUT_MS || 20000), 3000, 60000);
const CLI_TIMEOUT_MS = clamp(Number(process.env.TOKENMAX_CLI_TIMEOUT_MS || 5000), 1000, 30000);
const CLAUDE_USAGE_TIMEOUT_MS = clamp(Number(process.env.TOKENMAX_CLAUDE_USAGE_TIMEOUT_MS || 24000), 8000, 45000);
const CLAUDE_USAGE_STALE_MAX_HOURS = clamp(Number(process.env.TOKENMAX_CLAUDE_USAGE_STALE_MAX_HOURS || 24), 1, 168);
const CLAUDE_USAGE_DIALOG_ENABLED = process.env.TOKENMAX_DISABLE_CLAUDE_USAGE_DIALOG !== "1";

let claudeUsageInflight = null;
let lastGoodClaudeUsageDialog = null;

// Point the warehouse at a specific writable directory (the backend passes the
// host app's data dir). Safe to call before the first snapshot.
function configure(opts = {}) {
  if (opts.dataDir) {
    TOKENMAX_DATA_DIR = opts.dataDir;
    TOKENMAX_DB_PATH = process.env.TREE_TOKENMAX_DB_PATH || process.env.TOKENMAX_DB_PATH || path.join(TOKENMAX_DATA_DIR, "usage.sqlite");
  }
  if (opts.dbPath) TOKENMAX_DB_PATH = opts.dbPath;
}

// A Finder-launched Electron app inherits a stripped PATH (no shell profile),
// so codex/claude installed under nvm/fnm/volta/homebrew/etc. aren't found and
// usage would read "unavailable". We rebuild a real PATH the same way the
// terminal does: a one-time login-shell probe (covers version managers), plus
// a static list of common bin dirs as a fallback. Cached for the process life.
const CLI_PATH_DIRS = [
  path.join(os.homedir(), ".local/bin"),
  path.join(os.homedir(), ".npm-global/bin"),
  path.join(os.homedir(), ".claude/local"),
  path.join(os.homedir(), ".claude/bin"),
  path.join(os.homedir(), ".bun/bin"),
  path.join(os.homedir(), ".cargo/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
];

// Capture the user's interactive login-shell PATH once. nvm/asdf/fnm/volta put
// their shims on PATH via .zshrc/.bash_profile, so only a login+interactive
// shell sees them. Markers fence off any prompt/banner noise the shell emits.
let cachedLoginPath = null;
function loginShellPath() {
  if (cachedLoginPath !== null) return cachedLoginPath;
  cachedLoginPath = "";
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = require("node:child_process").execFileSync(
      shell,
      ["-ilc", 'printf "__TM_PATH__%s__TM_END__" "$PATH"'],
      { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
    );
    const match = /__TM_PATH__([\s\S]*?)__TM_END__/.exec(String(out || ""));
    if (match) cachedLoginPath = match[1].trim();
  } catch {
    cachedLoginPath = "";
  }
  return cachedLoginPath;
}

function cliEnv(extra = {}) {
  const seen = new Set();
  const PATH = [
    ...loginShellPath().split(path.delimiter),
    ...CLI_PATH_DIRS,
    ...String(process.env.PATH || "").split(path.delimiter)
  ]
    .filter((dir) => dir && !seen.has(dir) && seen.add(dir))
    .join(path.delimiter);
  return { ...process.env, PATH, NO_COLOR: "1", ...extra };
}

async function buildUsagePayload(range, onProgress = () => {}) {
  const startedAt = Date.now();
  onProgress({ stage: "providers", label: "Reading Codex and Claude usage", pct: 12 });

  const openaiPromise = fetchOpenAI(range).then((result) => {
    onProgress({ stage: "codex", label: "Codex usage ready", pct: 45 });
    return result;
  });
  const anthropicPromise = fetchAnthropic(range).then((result) => {
    onProgress({ stage: "claude", label: "Claude usage ready", pct: 70 });
    return result;
  });
  const [openai, anthropic] = await Promise.all([openaiPromise, anthropicPromise]);

  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    range: {
      id: range.id,
      label: range.label,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      refreshSeconds: REFRESH_SECONDS
    },
    providers: { openai, anthropic },
    combined: combineProviders(openai, anthropic),
    sources: [
      {
        label: "Codex app-server account/rateLimits/read",
        url: "https://developers.openai.com/codex/app-server"
      },
      {
        label: "Codex app-server account/usage/read",
        url: "https://developers.openai.com/codex/app-server"
      },
      {
        label: "Claude Code /usage, auth status, and agents JSON",
        url: "https://code.claude.com/docs/en/cli-reference"
      },
      {
        label: "Claude Code /usage slash command",
        url: "https://docs.anthropic.com/en/docs/claude-code/slash-commands"
      },
      {
        label: "Local Codex state database",
        url: CODEX_STATE_DB
      },
      {
        label: "Local Claude project JSONL",
        url: CLAUDE_PROJECTS_DIR
      }
    ]
  };

  onProgress({ stage: "storage", label: "Updating warehouse history", pct: 84 });
  const storageResult = await attachUsageStorage(payload);
  payload.storage = storageResult.storage;
  payload.intelligence = storageResult.intelligence;
  onProgress({ stage: "model", label: "Building forecast model", pct: 96 });

  return payload;
}

async function attachUsageStorage(payload) {
  try {
    const result = await persistUsageSnapshot(payload, { dbPath: TOKENMAX_DB_PATH });
    return {
      storage: result.storage,
      intelligence: buildUsageModel(payload, result.history)
    };
  } catch (error) {
    return {
      storage: {
        status: "error",
        path: TOKENMAX_DB_PATH,
        error: cleanError(error)
      },
      intelligence: buildUsageModel(payload, {
        windowCycles: [],
        daily: [],
        agents: [],
        endpoints: []
      })
    };
  }
}

async function fetchOpenAI(range) {
  const [local, live] = await Promise.all([fetchCodexLocalUsage(range), fetchCodexLiveStatus(range)]);
  const provider = applyCodexLiveUsage(local, live, range);
  provider.live = live;
  provider.status = providerStatus(local.status, live.status);
  provider.summary = live.status === "ok"
    ? "Live Codex subscription limits from app-server; local thread history fills in projects and models."
    : "Local Codex history is available, but live app-server limits are not reachable.";
  return provider;
}

async function fetchCodexLocalUsage(range) {
  if (!fs.existsSync(CODEX_STATE_DB)) {
    return missingProvider("openai", "Codex", `No local Codex state database found at ${CODEX_STATE_DB}.`);
  }

  const timeExpr = "coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000)";
  const where = `${timeExpr} >= ${range.start.getTime()} and ${timeExpr} < ${range.end.getTime()}`;

  try {
    const [totalRows, dailyRows, modelRows, projectRows] = await Promise.all([
      sqliteJson(CODEX_STATE_DB, `
        select
          count(*) as requests,
          coalesce(sum(tokens_used), 0) as subscriptionTokens,
          min(${timeExpr}) as first_seen_ms,
          max(${timeExpr}) as last_seen_ms
        from threads
        where ${where};
      `),
      sqliteJson(CODEX_STATE_DB, `
        select
          date(${timeExpr} / 1000, 'unixepoch') as date,
          count(*) as requests,
          coalesce(sum(tokens_used), 0) as subscriptionTokens
        from threads
        where ${where}
        group by 1
        order by 1;
      `),
      sqliteJson(CODEX_STATE_DB, `
        select
          coalesce(model, model_provider, 'unknown') as model,
          count(*) as requests,
          coalesce(sum(tokens_used), 0) as subscriptionTokens
        from threads
        where ${where}
        group by 1
        order by subscriptionTokens desc
        limit 12;
      `),
      sqliteJson(CODEX_STATE_DB, `
        select
          coalesce(cwd, 'unknown project') as label,
          count(*) as requests,
          coalesce(sum(tokens_used), 0) as subscriptionTokens
        from threads
        where ${where}
        group by 1
        order by subscriptionTokens desc
        limit 12;
      `)
    ]);

    const total = totalRows[0] || {};
    const totals = emptyTotals();
    totals.requests = asNumber(total.requests);
    totals.subscriptionTokens = asNumber(total.subscriptionTokens);
    totals.codeSessions = asNumber(total.requests);

    const daily = new Map();
    for (const row of dailyRows) {
      addDaily(daily, row.date, {
        requests: asNumber(row.requests),
        subscriptionTokens: asNumber(row.subscriptionTokens),
        codeSessions: asNumber(row.requests)
      });
    }

    return {
      key: "openai",
      label: "Codex",
      status: "ok",
      summary: "Local Codex subscription history from ~/.codex/state_5.sqlite.",
      totals,
      daily: dailyArray(daily),
      endpoints: [
        {
          key: "codex_local_threads",
          label: "Local Codex threads",
          status: "ok",
          totals,
          source: CODEX_STATE_DB
        }
      ],
      modelBreakdown: modelRows.map((row) => ({
        model: row.model || "unknown",
        requests: asNumber(row.requests),
        subscriptionTokens: asNumber(row.subscriptionTokens)
      })),
      projectBreakdown: projectRows.map((row) => ({
        label: row.label || "unknown project",
        subscriptionTokens: asNumber(row.subscriptionTokens),
        requests: asNumber(row.requests)
      })),
      errors: [],
      live: emptyLive("openai")
    };
  } catch (error) {
    if (isSqliteLocked(error)) {
      return {
        ...missingProvider("openai", "Codex", "Local Codex history is temporarily locked by another Codex process; live subscription limits are still checked."),
        status: "partial",
        errors: [{
          area: "Local Codex history",
          message: "Codex state database is locked right now. TokenMax will retry on the next refresh."
        }]
      };
    }

    return {
      ...missingProvider("openai", "Codex", `Could not read local Codex usage: ${cleanError(error)}`),
      status: "error"
    };
  }
}

async function fetchCodexLiveStatus(range) {
  try {
    const responses = await codexAccountRequests();
    const account = responses.get(1);
    const limits = responses.get(2);
    const usage = responses.get(3);
    const errors = [];

    for (const [id, label] of [[1, "account/read"], [2, "account/rateLimits/read"], [3, "account/usage/read"]]) {
      const response = responses.get(id);
      if (!response) {
        errors.push({ area: "Codex app-server", message: `${label} did not return a response.` });
      } else if (response.error) {
        errors.push({ area: label, message: response.error.message || JSON.stringify(response.error) });
      }
    }

    const accountInfo = account?.result?.account || null;
    const usageResult = usage?.result || {};
    const windows = normalizeCodexRateLimits(limits?.result || {});
    const dailyUsageBuckets = asArray(usageResult.dailyUsageBuckets).map((bucket) => ({
      startDate: bucket.startDate,
      tokens: asNumber(bucket.tokens)
    }));

    return {
      provider: "openai",
      label: "Codex live account",
      status: errors.length ? (accountInfo || windows.length || dailyUsageBuckets.length ? "partial" : "error") : "ok",
      account: {
        loggedIn: Boolean(accountInfo),
        authMode: accountInfo?.type || null,
        planType: accountInfo?.planType || firstPlanType(windows),
        email: maskEmail(accountInfo?.email || "")
      },
      windows,
      usage: {
        summary: sanitizeUsageSummary(usageResult.summary || {}),
        dailyUsageBuckets,
        rangeTokens: rangeTokensFromBuckets(dailyUsageBuckets, range),
        todayTokens: tokensForDate(dailyUsageBuckets, isoDay(new Date()))
      },
      resetCredits: limits?.result?.rateLimitResetCredits || null,
      notes: [],
      errors,
      endpoints: [
        endpointFromRpc("account/read", account),
        endpointFromRpc("account/rateLimits/read", limits),
        endpointFromRpc("account/usage/read", usage)
      ]
    };
  } catch (error) {
    const [loginStatus, version] = await Promise.all([
      runCli("codex", ["login", "status"]),
      runCli("codex", ["--version"])
    ]);

    return {
      ...emptyLive("openai"),
      status: "error",
      label: "Codex live account",
      account: {
        loggedIn: loginStatus.stdout.includes("Logged in"),
        authMode: loginStatus.stdout.includes("ChatGPT") ? "chatgpt" : null,
        planType: null,
        email: null
      },
      cli: {
        loginStatus: cleanCliOutput(loginStatus.stdout || loginStatus.stderr),
        version: cleanCliOutput(version.stdout || version.stderr)
      },
      errors: [{ area: "Codex app-server", message: cleanError(error) }],
      notes: [
        "Live limit windows need Codex app-server access to ~/.codex and network access to ChatGPT."
      ]
    };
  }
}

function applyCodexLiveUsage(local, live, range) {
  const totals = { ...emptyTotals(), ...(local.totals || {}) };
  const daily = new Map();
  mergeDaily(daily, local.daily || []);

  const liveBuckets = asArray(live?.usage?.dailyUsageBuckets);
  if (liveBuckets.length) {
    let rangeTokens = 0;
    for (const bucket of liveBuckets) {
      if (!inRangeDay(bucket.startDate, range)) continue;
      rangeTokens += asNumber(bucket.tokens);
      const current = daily.get(bucket.startDate) || emptyTotals();
      current.subscriptionTokens = asNumber(bucket.tokens);
      daily.set(bucket.startDate, current);
    }
    totals.subscriptionTokens = rangeTokens;
  }

  return {
    ...local,
    totals,
    daily: dailyArray(daily),
    endpoints: [
      ...asArray(live?.endpoints),
      ...asArray(local.endpoints)
    ],
    errors: [
      ...asArray(live?.errors),
      ...asArray(local.errors)
    ]
  };
}

function codexAccountRequests() {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: cliEnv()
    });
    const lines = readline.createInterface({ input: child.stdout });
    const responses = new Map();
    let stderr = "";
    let initialized = false;
    let settled = false;

    const timeout = setTimeout(() => {
      finish(new Error(`Codex app-server timed out after ${CODEX_LIVE_TIMEOUT_MS} ms.`));
    }, CODEX_LIVE_TIMEOUT_MS);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish(error);
    });

    child.on("exit", (code) => {
      if (!settled && code !== 0 && responses.size === 0) {
        finish(new Error(stderr.trim() || `Codex app-server exited with code ${code}.`));
      }
    });

    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id !== undefined) {
        responses.set(message.id, message);
      }

      if (message.id === 0 && !initialized) {
        initialized = true;
        send({ method: "initialized", params: {} });
        send({ method: "account/read", id: 1, params: { refreshToken: true } });
        send({ method: "account/rateLimits/read", id: 2 });
        send({ method: "account/usage/read", id: 3 });
      }

      if ([1, 2, 3].every((id) => responses.has(id))) {
        finish();
      }
    });

    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "tokenmax",
          title: "TokenMax",
          version: "0.1.0"
        },
        capabilities: { experimentalApi: true }
      }
    });

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      if (!child.killed) child.kill();
      if (error) {
        reject(new Error(cleanError(error) + (stderr.trim() ? ` ${stderr.trim()}` : "")));
      } else {
        resolve(responses);
      }
    }
  });
}

async function fetchAnthropic(range) {
  const [local, live] = await Promise.all([fetchClaudeLocalUsage(range), fetchClaudeLiveStatus()]);
  return {
    ...local,
    status: providerStatus(local.status, live.status),
    summary: live.account.loggedIn
      ? "Claude CLI auth is live. Limit windows come from the Claude Code /usage dialog when available."
      : "Local Claude Code history is available, but the Claude CLI is not logged in for live subscription status.",
    live,
    endpoints: [
      ...asArray(live.endpoints),
      ...asArray(local.endpoints)
    ],
    errors: [
      ...asArray(live.errors),
      ...asArray(local.errors)
    ]
  };
}

async function fetchClaudeLocalUsage(range) {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return missingProvider("anthropic", "Claude", `No local Claude project history found at ${CLAUDE_PROJECTS_DIR}.`);
  }

  try {
    const files = await findJsonlFiles(CLAUDE_PROJECTS_DIR);
    const totals = emptyTotals();
    const daily = new Map();
    const dailySessions = new Map();
    const modelBreakdown = new Map();
    const projectBreakdown = new Map();
    const seenRequests = new Set();
    const sessions = new Set();
    let parseErrors = 0;
    let usageRows = 0;

    for (const file of files) {
      const text = await fsp.readFile(file, "utf8");
      const lines = text.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line || !line.includes("usage")) continue;

        let record;
        try {
          record = JSON.parse(line);
        } catch {
          parseErrors += 1;
          continue;
        }

        const usage = record.message?.usage || record.usage;
        const timestamp = Date.parse(record.timestamp || record.created_at || "");
        const inRange = Number.isFinite(timestamp) && timestamp >= range.start.getTime() && timestamp < range.end.getTime();

        if (!usage || !inRange) continue;

        const requestKey = record.requestId || record.uuid || `${file}:${index}`;
        if (seenRequests.has(requestKey)) continue;
        seenRequests.add(requestKey);

        const date = new Date(timestamp).toISOString().slice(0, 10);
        const sessionId = record.sessionId || record.conversationId || record.cwd || file;
        const metrics = emptyTotals();
        addClaudeLocalUsage(metrics, usage);
        metrics.requests = 1;
        metrics.costUsd += asNumber(record.costUSD || record.totalCostUSD || usage.costUSD);

        usageRows += 1;
        sessions.add(sessionId);
        addSetValue(dailySessions, date, sessionId);
        mergeTotals(totals, metrics);
        addDaily(daily, date, metrics);

        const model = record.message?.model || record.model || "claude";
        const current = modelBreakdown.get(model) || emptyTotals();
        mergeTotals(current, metrics);
        modelBreakdown.set(model, current);

        const project = record.cwd || path.basename(path.dirname(file)) || "unknown project";
        const projectTotals = projectBreakdown.get(project) || emptyTotals();
        mergeTotals(projectTotals, metrics);
        projectBreakdown.set(project, projectTotals);
      }
    }

    totals.claudeCodeSessions = sessions.size;
    for (const [date, sessionSet] of dailySessions) {
      addDaily(daily, date, { claudeCodeSessions: sessionSet.size });
    }

    const statsCache = await readClaudeStatsCache();
    const errors = parseErrors
      ? [{ area: "Local Claude parser", message: `${parseErrors} malformed JSONL rows were skipped.` }]
      : [];

    return {
      key: "anthropic",
      label: "Claude",
      status: errors.length ? "partial" : "ok",
      summary: "Local Claude Code subscription history from ~/.claude/projects JSONL.",
      totals,
      daily: dailyArray(daily),
      endpoints: [
        {
          key: "claude_local_jsonl",
          label: "Local Claude JSONL",
          status: "ok",
          totals,
          files: files.length,
          usageRows
        },
        {
          key: "claude_stats_cache",
          label: "Claude stats cache",
          status: statsCache.status,
          lastComputedDate: statsCache.lastComputedDate || null
        }
      ],
      modelBreakdown: Array.from(modelBreakdown, ([model, modelTotals]) => ({ model, ...modelTotals }))
        .sort((a, b) => totalTokensFromTotals(b) - totalTokensFromTotals(a))
        .slice(0, 12),
      projectBreakdown: Array.from(projectBreakdown, ([label, projectTotals]) => ({ label, ...projectTotals }))
        .sort((a, b) => totalTokensFromTotals(b) - totalTokensFromTotals(a))
        .slice(0, 12),
      claudeCode: {
        localSessions: sessions.size,
        usageRows,
        statsCache
      },
      errors,
      live: emptyLive("anthropic")
    };
  } catch (error) {
    return {
      ...missingProvider("anthropic", "Claude", `Could not read local Claude usage: ${cleanError(error)}`),
      status: "error"
    };
  }
}

async function fetchClaudeLiveStatus() {
  const [auth, agents, daemon, version, usageDialog] = await Promise.all([
    runCli("claude", ["auth", "status"]),
    runCli("claude", ["agents", "--json", "--all"]),
    runCli("claude", ["daemon", "status"]),
    runCli("claude", ["--version"]),
    fetchClaudeUsageDialog()
  ]);

  const authJson = parseJson(auth.stdout);
  const agentsJson = parseJson(agents.stdout);
  const loggedIn = Boolean(authJson?.loggedIn);
  const activeAgents = asArray(agentsJson).filter((agent) => {
    const status = String(agent.status || agent.state || "").toLowerCase();
    return !["completed", "stopped", "failed", "done"].includes(status);
  });
  const dialogWindows = sortClaudeWindows(usageDialog.windows);
  const windows = dialogWindows.length ? dialogWindows : sortClaudeWindows(extractLimitWindows(authJson));
  const errors = [];

  if (auth.status === "error" && !authJson) {
    errors.push({ area: "claude auth status", message: cleanCliOutput(auth.stderr || auth.error) });
  }

  if (agents.status === "error" && !Array.isArray(agentsJson)) {
    errors.push({ area: "claude agents", message: cleanCliOutput(agents.stderr || agents.error) });
  }

  if (usageDialog.status === "error" && !dialogWindows.length) {
    errors.push({ area: "claude /usage", message: usageDialog.error || "Claude /usage did not return live windows." });
  }

  return {
    provider: "anthropic",
    label: "Claude live account",
    status: claudeLiveStatus(errors, loggedIn, usageDialog.status),
    account: {
      loggedIn,
      authMode: authJson?.authMethod || authJson?.auth_method || null,
      planType: authJson?.planType || authJson?.subscriptionType || usageDialog.planType || null,
      apiProvider: authJson?.apiProvider || null,
      email: maskEmail(authJson?.email || authJson?.account?.email || "")
    },
    windows,
    usage: {
      summary: usageDialog.summary || {},
      dailyUsageBuckets: [],
      rangeTokens: 0,
      todayTokens: 0,
      behaviors: usageDialog.behaviors || []
    },
    activeAgents: activeAgents.length,
    agents: asArray(agentsJson).slice(0, 20),
    daemon: {
      running: daemon.status === "ok",
      text: cleanCliOutput(daemon.stdout || daemon.stderr)
    },
    cli: {
      version: cleanCliOutput(version.stdout || version.stderr)
    },
    notes: [
      ...asArray(usageDialog.notes),
      ...(windows.length ? [] : ["Claude /usage did not return subscription 5-hour or weekly reset windows on this run."])
    ],
    errors,
    endpoints: [
      endpointFromCapture("claude /usage dialog", usageDialog, dialogWindows.length),
      endpointFromCli("claude auth status", auth, Boolean(authJson)),
      endpointFromCli("claude agents --json --all", agents, Array.isArray(agentsJson)),
      endpointFromCli("claude daemon status", daemon, true)
    ]
  };
}

function claudeLiveStatus(errors, loggedIn, usageStatus) {
  if (errors.length) return "error";
  if (!loggedIn) return "partial";
  if (["partial", "stale"].includes(usageStatus)) return "partial";
  return "ok";
}

function fetchClaudeUsageDialog() {
  if (claudeUsageInflight) return claudeUsageInflight;
  claudeUsageInflight = fetchClaudeUsageDialogUncached()
    .finally(() => {
      claudeUsageInflight = null;
    });
  return claudeUsageInflight;
}

async function fetchClaudeUsageDialogUncached() {
  if (!CLAUDE_USAGE_DIALOG_ENABLED) {
    return {
      status: "missing",
      windows: [],
      summary: {},
      behaviors: [],
      notes: ["Claude /usage dialog capture is disabled by TOKENMAX_DISABLE_CLAUDE_USAGE_DIALOG=1."],
      error: null
    };
  }

  const attempts = [
    { name: "ready", expectTimeoutSec: 20, initialSleepSec: 1.2, killTimeoutMs: CLAUDE_USAGE_TIMEOUT_MS },
    { name: "settled", expectTimeoutSec: 28, initialSleepSec: 1.8, killTimeoutMs: Math.max(CLAUDE_USAGE_TIMEOUT_MS, 32000) }
  ];
  const errors = [];

  for (const attempt of attempts) {
    const result = await runClaudeUsageCapture(attempt);
    if (result.windows.length) return rememberClaudeUsageDialog(result);
    if (result.error) errors.push(result.error);
  }

  const fallback = await staleClaudeUsageDialog(errors);
  if (fallback) return fallback;

  return {
    status: "error",
    windows: [],
    summary: {},
    behaviors: [],
    notes: ["Claude /usage opened but did not return live limit windows before the capture timeout."],
    error: errors[0] || "Claude /usage did not return live window output."
  };
}

function runClaudeUsageCapture(attempt) {
  return new Promise((resolve) => {
    const script = buildClaudeUsageExpectScript(attempt);

    execFile("expect", ["-c", script], {
      timeout: attempt.killTimeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: cliEnv()
    }, async (error, stdout, stderr) => {
      const parsed = parseClaudeUsageDialog(stdout || "");
      const stabilized = await stabilizeClaudeUsageDialog(parsed);
      const hasWindows = stabilized.windows.length > 0;
      const notes = [...parsed.notes];

      if (hasWindows) {
        notes.unshift(`Claude limits captured from /usage (${attempt.name}).`);
      }
      notes.push(...stabilized.notes);

      resolve({
        status: hasWindows ? stabilized.status : "error",
        capturedAt: new Date().toISOString(),
        attempt: attempt.name,
        planType: stabilized.planType,
        windows: sortClaudeWindows(stabilized.windows),
        summary: { ...stabilized.summary, captureMode: stabilized.status === "ok" ? "live" : "guarded_live", attempt: attempt.name },
        behaviors: parsed.behaviors,
        notes,
        error: hasWindows ? null : claudeUsageCaptureError(stdout, stderr, error)
      });
    });
  });
}

async function stabilizeClaudeUsageDialog(parsed) {
  const windows = parsed.windows.map((window) => ({ ...window }));
  const notes = [];
  let status = "ok";

  for (const window of windows) {
    const previous = await latestStoredClaudeWindow(window).catch(() => null);
    if (!previous) continue;

    const sameReset = Boolean((window.resetIso && previous.resetIso === window.resetIso)
      || (window.resetText && previous.resetText === window.resetText));
    const priorUsed = asNumber(previous.usedPercent);
    const currentUsed = asNumber(window.usedPercent);
    const impossibleDrop = sameReset && priorUsed > 0 && currentUsed + 1 < priorUsed;

    if (impossibleDrop) {
      window.observedUsedPercent = currentUsed;
      window.usedPercent = priorUsed;
      window.resetIso = window.resetIso || previous.resetIso || null;
      window.resetText = window.resetText || previous.resetText || null;
      window.stale = true;
      window.suspect = true;
      window.quality = "guarded";
      window.source = "guarded_sqlite_fallback";
      status = "partial";
      notes.push(`${window.name || window.kind} dropped from ${priorUsed}% to ${currentUsed}% inside the same reset cycle; using last known good value.`);
    }
  }

  return {
    ...parsed,
    status,
    windows: sortClaudeWindows(windows),
    notes
  };
}

async function latestStoredClaudeWindow(window) {
  if (!fs.existsSync(TOKENMAX_DB_PATH)) return null;

  const resetFilter = window.resetIso
    ? `and reset_at = ${sqlString(window.resetIso)}`
    : window.resetText
      ? `and reset_label = ${sqlString(window.resetText)}`
      : "";
  const rows = await sqliteJson(TOKENMAX_DB_PATH, `
    select
      window_key as id,
      window_name as name,
      window_kind as kind,
      window_duration_mins as windowDurationMins,
      max(used_percent) as usedPercent,
      reset_at as resetIso,
      reset_label as resetText,
      max(captured_at) as capturedAt
    from fact_limit_window
    where provider_key = 'anthropic'
      and window_key = ${sqlString(window.id || "")}
      and window_duration_mins = ${sqlNumber(window.windowDurationMins)}
      ${resetFilter}
    group by window_key, window_name, window_kind, window_duration_mins, reset_at, reset_label
    limit 1;
  `).catch(() => []);

  return rows[0] || null;
}

function buildClaudeUsageExpectScript(attempt) {
  return [
    `set timeout ${Math.max(8, asNumber(attempt.expectTimeoutSec) || 20)}`,
    "log_user 1",
    "spawn env COLUMNS=120 LINES=50 TERM=xterm-256color claude",
    `sleep ${Math.max(0.5, Number(attempt.initialSleepSec || 1.2)).toFixed(1)}`,
    "send -- \"/usage\\r\"",
    "expect { -re \"Usage.*credits\" { } -re \"d.*to.*day.*w.*to.*week\" { } -re \"Current.*week\" { exp_continue -continue_timer } -re \"Current.*session\" { exp_continue -continue_timer } timeout { } eof { } }",
    "sleep 0.3",
    "catch { send -- \"\\033\" }",
    "sleep 0.2",
    "catch { close }",
    "catch { wait }",
    "exit 0"
  ].join("; ");
}

function rememberClaudeUsageDialog(result) {
  const remembered = {
    ...result,
    status: result.status || "ok",
    windows: result.windows.map((window) => ({ ...window })),
    notes: [...asArray(result.notes)]
  };
  lastGoodClaudeUsageDialog = remembered;
  return remembered;
}

async function staleClaudeUsageDialog(errors) {
  const memory = staleClaudeUsageFromMemory();
  if (memory) return memory;

  const stored = await staleClaudeUsageFromDb();
  if (stored) return stored;

  return null;
}

function staleClaudeUsageFromMemory() {
  if (!lastGoodClaudeUsageDialog?.capturedAt) return null;
  const ageMs = Date.now() - Date.parse(lastGoodClaudeUsageDialog.capturedAt);
  if (!Number.isFinite(ageMs) || ageMs > CLAUDE_USAGE_STALE_MAX_HOURS * 3600000) return null;

  return {
    ...lastGoodClaudeUsageDialog,
    status: "stale",
    windows: lastGoodClaudeUsageDialog.windows.map((window) => ({ ...window, stale: true, source: "memory_fallback" })),
    summary: { ...lastGoodClaudeUsageDialog.summary, captureMode: "stale_memory" },
    notes: [`Using last good Claude /usage snapshot from ${new Date(lastGoodClaudeUsageDialog.capturedAt).toLocaleString()}.`],
    error: null
  };
}

async function staleClaudeUsageFromDb() {
  if (!fs.existsSync(TOKENMAX_DB_PATH)) return null;

  try {
    const rows = await sqliteJson(TOKENMAX_DB_PATH, `
      with latest_window as (
        select f.window_key, f.reset_cycle_key
        from fact_limit_window f
        join (
          select window_key, max(captured_at) as captured_at
          from fact_limit_window
          where provider_key = 'anthropic'
            and window_duration_mins in (300, 10080)
            and captured_at >= datetime('now', '-${CLAUDE_USAGE_STALE_MAX_HOURS} hours')
          group by window_key
        ) latest
          on latest.window_key = f.window_key
         and latest.captured_at = f.captured_at
        where f.provider_key = 'anthropic'
      )
      select
        max(f.captured_at) as capturedAt,
        f.window_key as id,
        f.window_name as name,
        f.window_kind as kind,
        f.window_duration_mins as windowDurationMins,
        max(f.used_percent) as usedPercent,
        f.reset_at as resetIso,
        f.reset_label as resetText,
        f.plan_type as planType
      from fact_limit_window f
      join latest_window latest
        on latest.window_key = f.window_key
       and latest.reset_cycle_key = f.reset_cycle_key
      where f.provider_key = 'anthropic'
        and f.window_duration_mins in (300, 10080)
        and f.captured_at >= datetime('now', '-${CLAUDE_USAGE_STALE_MAX_HOURS} hours')
      group by f.window_key, f.window_name, f.window_kind, f.window_duration_mins, f.reset_at, f.reset_label, f.plan_type
      order by f.window_duration_mins asc, f.window_name asc;
    `);

    if (!rows.length) return null;
    const capturedAt = rows.reduce((latest, row) => (
      !latest || Date.parse(row.capturedAt) > Date.parse(latest) ? row.capturedAt : latest
    ), null);
    const windows = rows.map((row) => ({
      provider: "Claude",
      id: row.id || row.kind || "claude",
      name: row.name || "Claude",
      kind: row.kind || "live",
      planType: row.planType || null,
      usedPercent: asNumber(row.usedPercent),
      windowDurationMins: asNumber(row.windowDurationMins),
      windowLabel: windowLabel(asNumber(row.windowDurationMins)),
      resetsAt: 0,
      resetIso: row.resetIso || null,
      resetInSeconds: null,
      resetText: row.resetText || null,
      source: "sqlite_fallback",
      stale: true,
      quality: "stale"
    }));

    return {
      status: "stale",
      capturedAt,
      attempt: "sqlite_fallback",
      planType: rows.find((row) => row.planType)?.planType || null,
      windows: sortClaudeWindows(windows),
      summary: { captureMode: "stale_sqlite", capturedAt },
      behaviors: [],
      notes: [`Using last good Claude /usage snapshot from ${new Date(capturedAt).toLocaleString()}.`],
      error: null
    };
  } catch {
    return null;
  }
}

function claudeUsageCaptureError(stdout, stderr, error) {
  const output = `${stdout || ""}\n${stderr || ""}`;
  const clean = cleanCliOutput(output);

  if (/not logged in|login/i.test(clean)) {
    return "Claude CLI is not logged in for this shell.";
  }

  if (/Loading usage data/i.test(clean)) {
    return "Claude /usage opened but usage rows did not finish loading before the timeout.";
  }

  if (/Current\s+session|Current\s+week/i.test(clean)) {
    return "Claude /usage returned terminal output, but TokenMax could not parse live windows.";
  }

  if (error) {
    return "Claude /usage capture did not finish cleanly.";
  }

  return "Claude /usage did not return live window output.";
}

function parseClaudeUsageDialog(rawOutput) {
  const lines = ansiStreamLines(rawOutput);
  const windows = [];
  const summary = {};
  const notes = [];
  const behaviors = [];
  let current = null;
  let inBehavior = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    const key = line.toLowerCase().replace(/[^a-z0-9%]/g, "");

    if (line.includes("Claude Max")) summary.planName = "Claude Max";
    if (line.includes("Claude Pro")) summary.planName = "Claude Pro";

    if (/^curre.*session/.test(key)) {
      current = {
        provider: "Claude",
        id: "claude_five_hour",
        name: "Claude",
        kind: "five_hour",
        planType: summary.planName || null,
        usedPercent: null,
        windowDurationMins: 300,
        windowLabel: "5 hours",
        resetsAt: 0,
        resetIso: null,
        resetInSeconds: null,
        resetText: null,
        source: "/usage"
      };
      windows.push(current);
      inBehavior = false;
      continue;
    }

    if (key.includes("currentweek") && key.includes("allmodels")) {
      current = {
        provider: "Claude",
        id: "claude_seven_day",
        name: "Claude all models",
        kind: "seven_day",
        planType: summary.planName || null,
        usedPercent: null,
        windowDurationMins: 10080,
        windowLabel: "7 days",
        resetsAt: 0,
        resetIso: null,
        resetInSeconds: null,
        resetText: null,
        source: "/usage"
      };
      windows.push(current);
      inBehavior = false;
      continue;
    }

    if (key.includes("currentweek") && key.includes("sonnet")) {
      current = {
        provider: "Claude",
        id: "claude_seven_day_sonnet",
        name: "Claude Sonnet",
        kind: "seven_day_sonnet",
        planType: summary.planName || null,
        usedPercent: null,
        windowDurationMins: 10080,
        windowLabel: "7 days",
        resetsAt: 0,
        resetIso: null,
        resetInSeconds: null,
        resetText: null,
        source: "/usage"
      };
      windows.push(current);
      inBehavior = false;
      continue;
    }

    if (line.toLowerCase().includes("approximate") && line.toLowerCase().includes("local sessions")) {
      notes.push("Claude says behavior breakdowns are approximate and based on local sessions on this machine.");
    }

    if (/^Last\s+\d/.test(line)) {
      inBehavior = true;
      behaviors.push({ label: line, value: "" });
      current = null;
      continue;
    }

    if (inBehavior) {
      if (/usage credits/i.test(line) || /to day .* to week/i.test(line) || /Esc to cancel/i.test(line)) {
        inBehavior = false;
      } else if (!/breakdown/i.test(line)) {
        const percent = line.match(/(\d+(?:\.\d+)?)\s*%/);
        if (percent) {
          behaviors.push({ label: line.replace(percent[0], "").trim(), value: `${percent[1]}%` });
        }
      }
    }

    if (!current) continue;

    const percent = line.match(/(\d+(?:\.\d+)?)\s*%\s*used/i);
    if (percent) {
      current.usedPercent = asNumber(percent[1]);
      continue;
    }

    const resetText = extractClaudeResetText(line);
    if (resetText) {
      current.resetText = resetText;
    }
  }

  const allModels = windows.find((item) => item.kind === "seven_day");
  for (const window of windows) {
    if (!window.planType && summary.planName) window.planType = summary.planName;
    if (window.kind === "seven_day_sonnet" && !window.resetText && allModels?.resetText) {
      window.resetText = allModels.resetText;
    }
  }

  return {
    planType: summary.planName || null,
    summary,
    behaviors: behaviors.slice(0, 8),
    notes: Array.from(new Set(notes)),
    windows: sortClaudeWindows(windows.filter((item) => item.usedPercent !== null || item.resetText))
  };
}

function sortClaudeWindows(windows) {
  return asArray(windows).sort(compareClaudeWindows);
}

function compareClaudeWindows(a, b) {
  const duration = asNumber(a.windowDurationMins) - asNumber(b.windowDurationMins);
  if (duration) return duration;

  const priority = {
    five_hour: 0,
    seven_day: 1,
    seven_day_opus: 2,
    seven_day_sonnet: 3
  };
  const kind = (priority[a.kind] ?? 10) - (priority[b.kind] ?? 10);
  if (kind) return kind;

  return String(a.name || a.id || "").localeCompare(String(b.name || b.id || ""));
}

function ansiStreamLines(input) {
  const lines = [];
  let line = [];
  let column = 0;
  const chars = Array.from(String(input || ""));

  for (let index = 0; index < chars.length;) {
    const char = chars[index];

    if (char === "\u001b") {
      const parsed = parseAnsi(chars, index);
      if (parsed) {
        if (parsed.type === "cursor-column") {
          column = Math.max(0, parsed.column - 1);
        } else if (parsed.type === "cursor-forward") {
          column += parsed.count;
        } else if (parsed.type === "clear-line") {
          line = line.slice(0, column);
        }
        index = parsed.nextIndex;
        continue;
      }
    }

    if (char === "\r" || char === "\n") {
      pushAnsiLine(lines, line);
      line = [];
      column = 0;
      index += 1;
      continue;
    }

    const code = char.codePointAt(0);
    if (code < 32) {
      index += 1;
      continue;
    }

    while (line.length < column) line.push(" ");
    line[column] = char;
    column += 1;
    index += 1;
  }

  pushAnsiLine(lines, line);
  return lines.map((item) => item.trimEnd()).filter((item) => item.trim());
}

function parseAnsi(chars, startIndex) {
  const introducer = chars[startIndex + 1];
  if (!introducer) return null;

  if (introducer === "]") {
    let end = startIndex + 2;
    while (end < chars.length && chars[end] !== "\u0007") end += 1;
    return { type: "ignore", nextIndex: Math.min(chars.length, end + 1) };
  }

  if (introducer !== "[") {
    return { type: "ignore", nextIndex: Math.min(chars.length, startIndex + 2) };
  }

  let end = startIndex + 2;
  while (end < chars.length && !/[A-Za-z~]/.test(chars[end])) end += 1;
  if (end >= chars.length) return { type: "ignore", nextIndex: chars.length };

  const final = chars[end];
  const params = chars.slice(startIndex + 2, end).join("");
  const firstNumber = asNumber((params.match(/\d+/) || ["1"])[0]) || 1;
  const nextIndex = end + 1;

  if (final === "G") return { type: "cursor-column", column: firstNumber, nextIndex };
  if (final === "C") return { type: "cursor-forward", count: firstNumber, nextIndex };
  if (final === "K") return { type: "clear-line", nextIndex };
  return { type: "ignore", nextIndex };
}

function pushAnsiLine(lines, line) {
  const text = line.join("").trimEnd();
  if (text.trim()) lines.push(text);
}

function extractClaudeResetText(line) {
  if (!/rese/i.test(line)) return null;
  const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const pattern = new RegExp(`(${month}\\s+\\d{1,2}\\s+at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?\\s*(?:\\([^)]+\\))?|\\d{1,2}:\\d{2}\\s*(?:am|pm)?\\s*(?:\\([^)]+\\))?|\\d{1,2}\\s*(?:am|pm)\\s*(?:\\([^)]+\\))?)`, "i");
  const match = line.match(pattern);
  return match ? match[1].replace(/\s+/g, " ").trim() : null;
}

function normalizeCodexRateLimits(result) {
  const rows = [];
  const byLimitId = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === "object"
    ? Object.values(result.rateLimitsByLimitId)
    : result.rateLimits
      ? [result.rateLimits]
      : [];

  for (const limit of byLimitId) {
    if (!limit) continue;
    for (const field of ["primary", "secondary"]) {
      const window = limit[field];
      if (!window) continue;
      rows.push({
        provider: "Codex",
        id: limit.limitId || "codex",
        name: limit.limitName || (limit.limitId === "codex" ? "Codex" : limit.limitId) || "Codex",
        kind: field,
        planType: limit.planType || null,
        usedPercent: asNumber(window.usedPercent),
        windowDurationMins: asNumber(window.windowDurationMins),
        windowLabel: windowLabel(asNumber(window.windowDurationMins)),
        resetsAt: asNumber(window.resetsAt),
        resetIso: unixToIso(window.resetsAt),
        resetInSeconds: resetInSeconds(window.resetsAt),
        rateLimitReachedType: limit.rateLimitReachedType || null,
        credits: limit.credits || null
      });
    }
  }

  return rows.sort((a, b) => a.windowDurationMins - b.windowDurationMins || a.name.localeCompare(b.name));
}

function extractLimitWindows(source) {
  if (!source || typeof source !== "object") return [];
  const candidates = [];
  collectLimitObjects(source, candidates, new Set());
  return candidates.map((item) => ({
    provider: "Claude",
    id: item.id || item.limitId || item.name || "claude",
    name: item.name || item.limitName || "Claude",
    kind: item.kind || "live",
    planType: item.planType || item.subscriptionType || null,
    usedPercent: asNumber(item.usedPercent ?? item.percentUsed ?? item.usagePercent),
    windowDurationMins: asNumber(item.windowDurationMins ?? item.durationMins),
    windowLabel: windowLabel(asNumber(item.windowDurationMins ?? item.durationMins)),
    resetsAt: asNumber(item.resetsAt ?? item.resetAt ?? item.reset_at),
    resetIso: unixToIso(item.resetsAt ?? item.resetAt ?? item.reset_at),
    resetInSeconds: resetInSeconds(item.resetsAt ?? item.resetAt ?? item.reset_at),
    rateLimitReachedType: item.rateLimitReachedType || null,
    credits: item.credits || null
  })).filter((item) => item.usedPercent || item.resetsAt || item.windowDurationMins);
}

function collectLimitObjects(value, output, seen) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  const keys = Object.keys(value);
  const keyText = keys.join(" ").toLowerCase();
  const looksLikeLimit = keyText.includes("limit") || keyText.includes("reset") || keyText.includes("quota");
  const hasMetric = keys.some((key) => /used|percent|reset|duration/i.test(key));

  if (looksLikeLimit && hasMetric) {
    output.push(value);
  }

  for (const child of Object.values(value)) {
    if (typeof child === "object") collectLimitObjects(child, output, seen);
  }
}

async function readClaudeStatsCache() {
  if (!fs.existsSync(CLAUDE_STATS_CACHE)) return { status: "missing" };

  try {
    const data = JSON.parse(await fsp.readFile(CLAUDE_STATS_CACHE, "utf8"));
    return {
      status: "ok",
      lastComputedDate: data.lastComputedDate || null,
      totalSessions: asNumber(data.totalSessions),
      totalMessages: asNumber(data.totalMessages),
      longestSession: data.longestSession || null,
      totalSpeculationTimeSavedMs: asNumber(data.totalSpeculationTimeSavedMs),
      hourCounts: data.hourCounts || null
    };
  } catch (error) {
    return { status: "error", error: cleanError(error) };
  }
}

function runCli(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: cliEnv()
    }, (error, stdout, stderr) => {
      resolve({
        status: error ? "error" : "ok",
        exitCode: typeof error?.code === "number" ? error.code : 0,
        stdout: stdout || "",
        stderr: stderr || "",
        error: error ? cleanError(error) : null
      });
    });
  });
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

function runCommand(command, args, maxBuffer) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || "").trim() || cleanError(error)));
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function isSqliteLocked(error) {
  return /database is locked|SQLITE_BUSY|locked \(5\)/i.test(cleanError(error));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findJsonlFiles(root) {
  const files = [];

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  await walk(root);
  return files;
}

function getRange(rawRange) {
  const now = new Date();
  const id = ["24h", "7d", "30d", "90d"].includes(rawRange) ? rawRange : "7d";

  if (id === "24h") {
    return {
      id,
      label: "Last 24 hours",
      start: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      end: now
    };
  }

  const days = id === "90d" ? 90 : id === "30d" ? 30 : 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

  return {
    id,
    label: `Last ${days} days`,
    start,
    end
  };
}

function combineProviders(openai, anthropic) {
  const totals = emptyTotals();
  const daily = new Map();

  for (const provider of [openai, anthropic]) {
    mergeTotals(totals, provider.totals || emptyTotals());
    mergeDaily(daily, provider.daily || []);
  }

  const statuses = [openai.status, anthropic.status];
  const windows = [
    ...asArray(openai.live?.windows),
    ...asArray(anthropic.live?.windows)
  ];

  return {
    totals,
    daily: dailyArray(daily),
    windows,
    status: statuses.every((status) => status === "missing")
      ? "missing"
      : statuses.some((status) => status === "error")
        ? "partial"
        : statuses.some((status) => ["partial", "missing"].includes(status))
          ? "partial"
          : "ok"
  };
}

function emptyLive(provider) {
  return {
    provider,
    label: provider === "openai" ? "Codex live account" : "Claude live account",
    status: "missing",
    account: { loggedIn: false, authMode: null, planType: null, email: null },
    windows: [],
    usage: { summary: {}, dailyUsageBuckets: [], rangeTokens: 0, todayTokens: 0 },
    notes: [],
    errors: [],
    endpoints: []
  };
}

function missingProvider(key, label, message) {
  return {
    key,
    label,
    status: "missing",
    summary: message,
    totals: emptyTotals(),
    daily: [],
    endpoints: [],
    modelBreakdown: [],
    projectBreakdown: [],
    errors: [{ area: "Configuration", message }],
    live: emptyLive(key)
  };
}

function endpointFromRpc(label, response) {
  return {
    key: label.replaceAll("/", "_"),
    label,
    status: response && !response.error ? "ok" : "error",
    error: response?.error?.message || null
  };
}

function endpointFromCli(label, result, parsed) {
  return {
    key: label.replaceAll(" ", "_"),
    label,
    status: parsed || result.status === "ok" ? "ok" : "error",
    error: parsed ? null : cleanCliOutput(result.stderr || result.error)
  };
}

function endpointFromCapture(label, result, parsed) {
  const status = parsed
    ? result.status === "ok" ? "ok" : "partial"
    : result.status === "missing" ? "missing" : "error";

  return {
    key: label.replaceAll(" ", "_").replaceAll("/", "_"),
    label,
    status,
    error: parsed ? null : result.error || null
  };
}

function emptyTotals() {
  return {
    costUsd: 0,
    requests: 0,
    subscriptionTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    audioTokens: 0,
    codeSessions: 0,
    fileSearches: 0,
    webSearches: 0,
    claudeCodeSessions: 0
  };
}

function addClaudeLocalUsage(target, usage) {
  target.inputTokens += asNumber(usage.input_tokens);
  target.outputTokens += asNumber(usage.output_tokens);
  target.cacheTokens += asNumber(usage.cache_read_input_tokens) + asNumber(usage.cached_input_tokens);
  target.cacheTokens += asNumber(usage.cache_creation_input_tokens);
  target.webSearches += asNumber(usage.server_tool_use?.web_search_requests);
  target.webSearches += asNumber(usage.server_tool_use?.web_fetch_requests);
}

function mergeTotals(target, source) {
  for (const key of Object.keys(emptyTotals())) {
    target[key] += asNumber(source?.[key]);
  }
  return target;
}

function addDaily(daily, date, values) {
  if (!date) return;
  const key = typeof date === "string" ? date : bucketDate(date);
  const current = daily.get(key) || emptyTotals();
  mergeTotals(current, values);
  daily.set(key, current);
}

function mergeDaily(target, source) {
  if (source instanceof Map) {
    for (const [date, values] of source) addDaily(target, date, values);
    return;
  }

  for (const item of asArray(source)) addDaily(target, item.date, item);
}

function dailyArray(daily) {
  return Array.from(daily, ([date, totals]) => ({ date, ...totals }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function addSetValue(map, key, value) {
  const set = map.get(key) || new Set();
  set.add(value);
  map.set(key, set);
}

function totalTokensFromTotals(source) {
  return asNumber(source?.subscriptionTokens)
    + asNumber(source?.inputTokens)
    + asNumber(source?.outputTokens)
    + asNumber(source?.cacheTokens)
    + asNumber(source?.audioTokens);
}

function rangeTokensFromBuckets(buckets, range) {
  return asArray(buckets).reduce((sum, bucket) => (
    inRangeDay(bucket.startDate, range) ? sum + asNumber(bucket.tokens) : sum
  ), 0);
}

function tokensForDate(buckets, day) {
  return asArray(buckets).reduce((sum, bucket) => (
    bucket.startDate === day ? sum + asNumber(bucket.tokens) : sum
  ), 0);
}

function inRangeDay(day, range) {
  if (!day) return false;
  const date = new Date(`${day}T00:00:00.000Z`);
  return date >= startOfUtcDay(range.start) && date < range.end;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function bucketDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  if (typeof value === "number") return new Date(value * 1000).toISOString().slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function providerStatus(localStatus, liveStatus) {
  if (localStatus === "error" && liveStatus === "error") return "error";
  if (localStatus === "ok" && liveStatus === "ok") return "ok";
  if (localStatus === "missing" && liveStatus === "missing") return "missing";
  return "partial";
}

function firstPlanType(windows) {
  return asArray(windows).find((item) => item.planType)?.planType || null;
}

function sanitizeUsageSummary(summary) {
  return {
    lifetimeTokens: asNumber(summary.lifetimeTokens),
    peakDailyTokens: asNumber(summary.peakDailyTokens),
    longestRunningTurnSec: asNumber(summary.longestRunningTurnSec),
    currentStreakDays: asNumber(summary.currentStreakDays),
    longestStreakDays: asNumber(summary.longestStreakDays)
  };
}

function windowLabel(minutes) {
  if (!minutes) return "Live window";
  if (minutes === 300) return "5 hours";
  if (minutes === 10080) return "7 days";
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

function resetInSeconds(value) {
  const seconds = asNumber(value);
  if (!seconds) return null;
  return Math.max(0, seconds - Math.floor(Date.now() / 1000));
}

function unixToIso(value) {
  const seconds = asNumber(value);
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function maskEmail(value) {
  if (!value || !String(value).includes("@")) return value || null;
  const [name, domain] = String(value).split("@");
  const visible = name.slice(0, Math.min(3, name.length));
  return `${visible}${name.length > 3 ? "***" : "*"}@${domain}`;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cleanCliOutput(text) {
  return String(text || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim()
    .slice(0, 2000);
}

function sqlString(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "null";
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function cleanError(error) {
  return String(error?.message || error || "Unknown error");
}

module.exports = {
  buildUsagePayload,
  getRange,
  configure,
  get dbPath() { return TOKENMAX_DB_PATH; },
};
