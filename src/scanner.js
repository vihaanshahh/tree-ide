const fs = require('fs');
const path = require('path');
const ignore = require('ignore');

const CODE_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.rb', '.php', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.sh', '.lua', '.dart', '.scala', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.md', '.html', '.css', '.scss',
  '.sql', '.prisma', '.tf', '.gradle',
]);

const CODE_FILENAMES = new Set([
  'Dockerfile', 'Containerfile', 'Makefile', 'Podfile', 'Gemfile',
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'settings.gradle', 'build.gradle',
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lock', 'bun.lockb', 'Cargo.lock', 'Pipfile.lock', 'poetry.lock',
  'Gemfile.lock', 'composer.lock', 'pubspec.lock', 'gradle.lockfile',
]);

const SEARCH_BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.icns', '.bmp', '.tiff', '.heic',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wav', '.flac', '.ogg',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.pdf', '.dmg', '.pkg', '.exe', '.dll', '.so', '.dylib', '.node',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);
const MAX_SEARCH_FILE_BYTES = 500_000;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.expo',
  '.cache', 'venv', '.venv', 'env', '.env', '__pycache__', 'target', '.idea',
  '.vscode', 'coverage', '.turbo', 'out', '.parcel-cache', '.svelte-kit',
  '.angular', '.docusaurus', 'vendor', '.gradle', 'pkg', '.dart_tool',
  'Pods', 'DerivedData', '.next-env.d', '.serverless', '.firebase',
  '.terraform', 'cdk.out', '.output', 'bower_components',
  'uploads', 'tmp', 'temp', '.tmp',
]);
// Skip directories whose name begins with one of these prefixes (venv variants, etc.)
const SKIP_DIR_PREFIXES = ['.venv', 'venv-', 'env-', '.virtualenv'];

const JS_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const STYLE_EXTS = new Set(['.css', '.scss', '.sass', '.less']);
const COMPANION_STYLE_SOURCE_EXTS = ['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs', '.vue', '.svelte', '.html'];
const LOCAL_REFERENCE_EXTS = new Set([...CODE_EXT, '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf']);
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const ANALYSIS_CACHE = new Map();
const MAX_ROOT_CACHES = 4;

function cloneData(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function cacheKeyForFile(f) {
  return `${f.size || 0}:${Math.round(f.mtimeMs || 0)}`;
}

function cacheForRoot(root) {
  let cache = ANALYSIS_CACHE.get(root);
  if (!cache) {
    cache = new Map();
    ANALYSIS_CACHE.set(root, cache);
    while (ANALYSIS_CACHE.size > MAX_ROOT_CACHES) {
      const oldest = ANALYSIS_CACHE.keys().next().value;
      ANALYSIS_CACHE.delete(oldest);
    }
  }
  return cache;
}

function loadIgnore(root) {
  const ig = ignore();
  const giPath = path.join(root, '.gitignore');
  if (fs.existsSync(giPath)) {
    try { ig.add(fs.readFileSync(giPath, 'utf8')); } catch {}
  }
  ig.add(['.git', 'node_modules']);
  return ig;
}

// Parse tsconfig.json / jsconfig.json compilerOptions.paths into a list of
// { prefix, replacements: [absDir, ...] } entries. Recognizes Next.js's "@/*"
// and similar aliases so imports like "@/components/Button" resolve to
// "<base>/components/Button".
function loadPathAliases(root) {
  const candidates = ['tsconfig.json', 'jsconfig.json'];
  for (const name of candidates) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
    // Strip JSONC comments and trailing commas, best-effort
    raw = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    raw = raw.replace(/(^|[^:])\/\/.*$/gm, '$1');
    raw = raw.replace(/,(\s*[}\]])/g, '$1');
    let cfg;
    try { cfg = JSON.parse(raw); } catch { continue; }
    const co = cfg.compilerOptions || {};
    const baseUrl = path.resolve(root, co.baseUrl || '.');
    const paths = co.paths || {};
    const out = [];
    for (const key of Object.keys(paths)) {
      const star = key.endsWith('/*');
      const prefix = star ? key.slice(0, -2) : key;
      const replacements = (paths[key] || []).map(r => {
        const cleaned = r.endsWith('/*') ? r.slice(0, -2) : r;
        return path.resolve(baseUrl, cleaned);
      });
      out.push({ prefix, star, replacements });
    }
    // Implicit Next.js default: "@/*" → "./src/*" or "./*"
    if (!out.some(a => a.prefix === '@')) {
      out.push({
        prefix: '@', star: true,
        replacements: [
          path.resolve(root, 'src'),
          path.resolve(root, '.'),
        ],
      });
    }
    // Always include baseUrl-relative resolution for bare imports starting
    // with a folder name (Next.js convention for `app/`, `components/`, etc.)
    return { aliases: out, baseUrl };
  }
  // No tsconfig: still try the "@/*" → "./src/*" or root convention
  return {
    aliases: [{
      prefix: '@', star: true,
      replacements: [
        path.resolve(root, 'src'),
        path.resolve(root, '.'),
      ],
    }],
    baseUrl: path.resolve(root),
  };
}

function loadGitStatus(root) {
  const { execFileSync } = require('child_process');
  const statusByRel = new Map();
  let gitRoot = root;
  try {
    gitRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || root;
  } catch {
    return statusByRel;
  }

  const relFromGitPath = (relToGit) => {
    const abs = path.join(gitRoot, relToGit);
    let relToRoot = path.relative(root, abs);
    if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null;
    return relToRoot.split(path.sep).join('/');
  };
  const mergeStatus = (relToRoot, next) => {
    if (!relToRoot) return;
    const prev = statusByRel.get(relToRoot) || {};
    statusByRel.set(relToRoot, {
      ...prev,
      ...next,
      dirty: Boolean(prev.dirty || next.dirty),
      unpushed: Boolean(prev.unpushed || next.unpushed),
    });
  };

  let raw = '';
  try {
    raw = execFileSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return statusByRel;
  }
  const parts = raw.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const index = entry[0];
    const worktree = entry[1];
    const relToGit = entry.slice(3);
    if ((index === 'R' || index === 'C') && i + 1 < parts.length) {
      i++;
    }
    const relToRoot = relFromGitPath(relToGit);
    const staged = index !== ' ' && index !== '?';
    const unstaged = worktree !== ' ';
    const untracked = index === '?' && worktree === '?';
    const deleted = index === 'D' || worktree === 'D';
    mergeStatus(relToRoot, {
      index,
      worktree,
      code: `${index}${worktree}`,
      staged,
      unstaged,
      untracked,
      deleted,
      dirty: true,
    });
  }

  let upstream = '';
  try {
    upstream = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  if (upstream) {
    let aheadRaw = '';
    try {
      aheadRaw = execFileSync('git', ['-C', root, 'diff', '--name-only', '-z', `${upstream}...HEAD`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {}
    for (const relToGit of aheadRaw.split('\0').filter(Boolean)) {
      mergeStatus(relFromGitPath(relToGit), {
        committed: true,
        unpushed: true,
      });
    }
  }
  return statusByRel;
}

async function walkRepo(root, opts = {}) {
  const ig = loadIgnore(root);
  const files = [];

  const isSkipDir = (name) => {
    if (SKIP_DIRS.has(name)) return true;
    for (const p of SKIP_DIR_PREFIXES) if (name.startsWith(p)) return true;
    return false;
  };

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Probe for "looks like a Python virtualenv" — presence of pyvenv.cfg or bin/activate
    // is a strong signal we should skip the whole dir even if name doesn't match.
    if (entries.some(e => e.isFile() && (e.name === 'pyvenv.cfg' || e.name === 'activate'))) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (!rel || rel.startsWith('..')) continue;
      if (e.isDirectory()) {
        if (isSkipDir(e.name)) continue;
        if (ig.ignores(rel + '/')) continue;
        await walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        let size = 0;
        let mtimeMs = 0;
        try {
          const st = await fs.promises.stat(full);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch {}
        if (!isSearchIndexedFile(e.name, ext, size)) continue;
        const indexOnly = !isCodeIndexedFile(e.name, ext);
        if (!indexOnly && ig.ignores(rel)) continue;
        files.push({ rel, full, ext, size, mtimeMs, indexOnly });
      }
    }
  }
  await walk(root);
  return files;
}

// Lightweight framework detection from package.json + presence of `app/`.
// Lets us treat Expo Router files correctly without confusing them with Next.js.
function detectFrameworks(root) {
  const out = {
    next: false,
    vite: false,
    react: false,
    expo: false,
    expoRouter: false,
    electron: false,
    nodeApi: false,
    python: false,
    rust: false,
    flutter: false,
    docker: false,
    infra: false,
    db: false,
  };
  try {
    const p = path.join(root, 'package.json');
    if (fs.existsSync(p)) {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps['next']) out.next = true;
      if (deps['vite']) out.vite = true;
      if (deps['react']) out.react = true;
      if (deps['expo']) out.expo = true;
      if (deps['expo-router']) out.expoRouter = true;
      if (deps['electron']) out.electron = true;
      if (deps['express'] || deps['fastify'] || deps['hono'] || deps['@nestjs/core']) out.nodeApi = true;
      if (deps['drizzle-orm'] || deps['prisma'] || deps['@prisma/client'] || deps['knex'] || deps['@supabase/supabase-js']) out.db = true;
    }
  } catch {}
  if (fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'pyproject.toml'))) out.python = true;
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) out.rust = true;
  if (fs.existsSync(path.join(root, 'pubspec.yaml'))) out.flutter = true;
  if (fs.existsSync(path.join(root, 'Dockerfile')) || fs.existsSync(path.join(root, 'docker-compose.yml'))) out.docker = true;
  if (fs.existsSync(path.join(root, 'terraform')) || fs.existsSync(path.join(root, 'vercel.json')) || fs.existsSync(path.join(root, 'netlify.toml'))) out.infra = true;
  if (fs.existsSync(path.join(root, 'drizzle.config.ts')) || fs.existsSync(path.join(root, 'prisma')) || fs.existsSync(path.join(root, 'supabase'))) out.db = true;
  // Sub-projects: also probe frontend/, backend/ for their own package.json
  return out;
}

function frameworkTags(fw) {
  const tags = [];
  if (fw.next) tags.push('Next');
  if (fw.vite) tags.push('Vite');
  if (fw.expo || fw.expoRouter) tags.push('Expo');
  if (fw.react) tags.push('React');
  if (fw.electron) tags.push('Electron');
  if (fw.nodeApi) tags.push('Node API');
  if (fw.python) tags.push('Python');
  if (fw.rust) tags.push('Rust');
  if (fw.flutter) tags.push('Flutter');
  if (fw.db) tags.push('DB');
  if (fw.docker) tags.push('Docker');
  if (fw.infra) tags.push('Infra');
  return tags;
}

function isCodeIndexedFile(name, ext) {
  return CODE_EXT.has(ext) || CODE_FILENAMES.has(name);
}

function isSearchIndexedFile(name, ext, size) {
  if (isCodeIndexedFile(name, ext)) return true;
  if (size > MAX_SEARCH_FILE_BYTES) return false;
  return !SEARCH_BINARY_EXT.has(ext);
}

function detectIndexOnlySemantic(rel) {
  const base = path.basename(rel);
  const lower = base.toLowerCase();
  const baseNoExt = base.replace(/\.[^.]+$/, '');
  if (
    lower === '.env' ||
    lower.startsWith('.env.') ||
    lower.endsWith('.env') ||
    lower === '.npmrc' ||
    lower === '.yarnrc' ||
    lower === '.nvmrc' ||
    lower === '.node-version' ||
    lower === '.ruby-version' ||
    lower === '.python-version' ||
    lower === '.gitignore' ||
    lower === '.dockerignore' ||
    lower === '.editorconfig'
  ) {
    return { kind: 'config', label: 'Config', sublabel: base };
  }
  if (/^(license|licence|notice|authors|contributors|changelog|changes)$/i.test(baseNoExt)) {
    return { kind: 'docs', label: 'Docs', sublabel: base };
  }
  return { kind: 'other', label: 'File', sublabel: base };
}

// ===== Semantic detection =====
// Returns { kind, label, sublabel?, methods? } or null.
function detectSemantic(rel, content, frameworks = {}) {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  const lowerBase = base.toLowerCase();
  const baseNoExt = base.replace(/\.[^.]+$/, '');
  const dir = parts.slice(0, -1);

  const lowerParts = parts.map(p => p.toLowerCase());
  const lowerRel = rel.toLowerCase();

  // Deploy / infra roots. These need to be visible in non-web repos and
  // monorepos, but they are neither app UI nor generic code modules.
  if (
    base === 'Dockerfile' ||
    base === 'Containerfile' ||
    /^docker-compose\.ya?ml$/i.test(base) ||
    /^compose\.ya?ml$/i.test(base) ||
    /\.tf$/i.test(base) ||
    base === 'vercel.json' ||
    base === 'netlify.toml' ||
    lowerParts.includes('terraform') ||
    lowerParts.includes('k8s') ||
    lowerParts.includes('kubernetes')
  ) {
    return { kind: 'infra', label: 'Infra', sublabel: base };
  }

  // Mobile/native project markers.
  if (base === 'pubspec.yaml') return { kind: 'config', label: 'Flutter', sublabel: 'pubspec' };
  if (base === 'Podfile' || /\.xcodeproj$/i.test(base) || /\.xcworkspace$/i.test(base)) {
    return { kind: 'infra', label: 'Native', sublabel: base };
  }
  if (base === 'AndroidManifest.xml' || base === 'build.gradle' || base === 'settings.gradle') {
    return { kind: 'config', label: 'Android', sublabel: baseNoExt };
  }

  if (
    lowerBase === 'package-lock.json' ||
    lowerBase === 'package.lock' ||
    lowerBase === 'npm-shrinkwrap.json' ||
    lowerBase === 'yarn.lock' ||
    lowerBase === 'pnpm-lock.yaml' ||
    lowerBase === 'bun.lock' ||
    lowerBase === 'bun.lockb' ||
    lowerBase === 'cargo.lock' ||
    lowerBase === 'pipfile.lock' ||
    lowerBase === 'poetry.lock' ||
    lowerBase === 'gemfile.lock' ||
    lowerBase === 'composer.lock' ||
    lowerBase === 'pubspec.lock' ||
    lowerBase === 'gradle.lockfile'
  ) {
    return { kind: 'config', label: 'Lockfile', sublabel: base };
  }

  const inJobDir = lowerParts.some(p => ['jobs', 'job', 'workers', 'worker', 'queues', 'queue', 'cron', 'scripts'].includes(p));
  if (inJobDir && /\.(t|j)sx?$|\.py$|\.rs$/.test(base)) {
    return { kind: 'job', label: 'Job', sublabel: baseNoExt };
  }

  // Next.js App Router (app/...) — only when we KNOW it's Next.js, otherwise
  // a same-named file in an Expo Router project would be misidentified.
  const appIdx = lowerParts.indexOf('app');
  if (appIdx !== -1 && frameworks.next && /^(page|route|layout|loading|error|template|not-found|default|opengraph-image|icon|sitemap|robots|manifest)\.(t|j)sx?$/i.test(base)) {
    const segs = parts.slice(appIdx + 1, -1).filter(p => !/^\(.+\)$/.test(p));
    const p2 = segs.length ? '/' + segs.join('/') : '/';
    if (/^page\./i.test(base))     return { kind: 'page',     label: 'Page',     sublabel: p2 };
    if (/^route\./i.test(base)) {
      const methods = HTTP_METHODS.filter(m => new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${m}\\b`).test(content));
      return { kind: 'route', label: methods.length ? methods.join(' ') : 'Route', sublabel: p2, methods };
    }
    if (/^layout\./i.test(base))   return { kind: 'layout',   label: 'Layout',   sublabel: p2 };
    if (/^loading\./i.test(base))  return { kind: 'loading',  label: 'Loading',  sublabel: p2 };
    if (/^error\./i.test(base))    return { kind: 'error',    label: 'Error',    sublabel: p2 };
    if (/^template\./i.test(base)) return { kind: 'template', label: 'Template', sublabel: p2 };
    if (/^not-found\./i.test(base)) return { kind: 'notfound', label: 'Not Found', sublabel: p2 };
    if (/^default\./i.test(base))  return { kind: 'default',  label: 'Parallel', sublabel: p2 };
    return { kind: 'special', label: baseNoExt, sublabel: p2 };
  }

  // Expo Router (file-based routing in `app/`, layouts named `_layout.tsx`)
  if (appIdx !== -1 && frameworks.expoRouter && JS_EXTS.has(path.extname(base))) {
    const segs = parts.slice(appIdx + 1).map(s => s);
    // strip route groups like (tabs)
    const cleanedSegs = segs.map(s => s.replace(/^\(.+\)$/, '__group__')).filter(s => s !== '__group__');
    // reconstruct route path from segments minus last
    const lastSeg = baseNoExt;
    const pathSegs = cleanedSegs.slice(0, -1);
    if (lastSeg === '_layout') {
      const p2 = pathSegs.length ? '/' + pathSegs.join('/') : '/';
      return { kind: 'layout', label: 'Layout', sublabel: p2 };
    }
    // Page: filename becomes the trailing segment, "index" becomes empty
    const fullSegs = [...pathSegs, lastSeg === 'index' ? '' : lastSeg].filter(Boolean);
    const p2 = fullSegs.length ? '/' + fullSegs.join('/') : '/';
    return { kind: 'page', label: 'Page', sublabel: p2 };
  }

  // Next.js Pages Router (pages/...)
  const pagesIdx = lowerParts.indexOf('pages');
  if (pagesIdx !== -1 && JS_EXTS.has(path.extname(base))) {
    const segs = parts.slice(pagesIdx + 1).map(s => s.replace(/\.[^.]+$/, ''));
    if (segs[0] === 'api') {
      const apiPath = '/api/' + segs.slice(1).filter(s => s !== 'index').join('/');
      const methods = HTTP_METHODS.filter(m => new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${m}\\b`).test(content));
      return { kind: 'route', label: methods.length ? methods.join(' ') : 'API', sublabel: apiPath, methods };
    }
    if (segs[0] === '_app') return { kind: 'app', label: 'App shell', sublabel: '_app' };
    if (segs[0] === '_document') return { kind: 'document', label: 'HTML doc', sublabel: '_document' };
    const pagePath = '/' + segs.filter(s => s !== 'index').join('/');
    return { kind: 'page', label: 'Page', sublabel: pagePath };
  }

  // Middleware (root file or anything inside a `middleware/` dir)
  if (/^middleware\.(t|j)sx?$/i.test(base)) return { kind: 'middleware', label: 'Middleware', sublabel: '*' };
  if (lowerParts.includes('middleware') || lowerParts.includes('middlewares')) {
    if (JS_EXTS.has(path.extname(base))) {
      return { kind: 'middleware', label: 'Middleware', sublabel: baseNoExt };
    }
  }

  // Server actions (Next): files starting with 'use server' directive
  if (JS_EXTS.has(path.extname(base)) && /^['"]use server['"]/.test(content.trim())) {
    return { kind: 'server-action', label: 'Server Action', sublabel: baseNoExt };
  }

  // Python API frameworks: FastAPI, Flask, Django-ish route files.
  if (base.endsWith('.py')) {
    const routeDecorators = (content.match(/@\s*(?:app|router|api|blueprint)\.(?:get|post|put|patch|delete|route)\s*\(/g) || []).length;
    const createsApi = /\b(?:FastAPI|APIRouter|Flask|Blueprint)\s*\(/.test(content);
    const djangoUrls = /\burlpatterns\s*=/.test(content) || /\bpath\s*\(\s*['"]/.test(content);
    if (routeDecorators || djangoUrls) {
      const verbs = [...content.matchAll(/@\s*(?:app|router|api|blueprint)\.(get|post|put|patch|delete|route)\s*\(/g)]
        .map(m => m[1] === 'route' ? 'ROUTE' : m[1].toUpperCase());
      return { kind: 'route', label: verbs.length ? [...new Set(verbs)].slice(0, 3).join(' ') : 'Route', sublabel: baseNoExt };
    }
    if (createsApi || /\buvicorn\.run\s*\(/.test(content)) {
      return { kind: 'service', label: 'Python API', sublabel: baseNoExt };
    }
    if (/\b(?:BaseModel|DeclarativeBase|db\.Model)\b/.test(content) || /Column\s*\(/.test(content)) {
      return { kind: 'model', label: 'Model', sublabel: baseNoExt };
    }
  }

  // Express / Hono / Fastify router file (heuristic).
  // Distinguish "router file" (defines its own routes) from "server entry"
  // (mostly mounts other routers via app.use(path, fooRouter)).
  if (JS_EXTS.has(path.extname(base))) {
    const verbMatches = (content.match(/\b(?:router|app|server)\.(get|post|put|delete|patch)\(/g) || []).length;
    const useMatches  = (content.match(/\b(?:app|server)\.use\(\s*['"`][^'"`]+['"`]\s*,/g) || []).length;
    const declaresRouter = /\b(?:Router|express\.Router|new\s+Router|new\s+Hono|Fastify)\s*\(/.test(content);
    const importsServerFramework =
      /\bfrom\s+['"](?:express|hono|fastify|koa|@nestjs\/core)['"]/.test(content) ||
      /\brequire\(\s*['"](?:express|hono|fastify|koa)['"]\s*\)/.test(content) ||
      /\bnew\s+Hono\s*\(/.test(content) ||
      /\bexpress\s*\(/.test(content);
    const routeishPath = lowerParts.some(p => ['routes', 'route', 'api', 'server', 'backend', 'controllers', 'controller'].includes(p));
    const isServerEntry = useMatches >= 2 && useMatches > verbMatches;
    if (isServerEntry && (importsServerFramework || routeishPath || /^(server|app|index|main)\./i.test(base))) {
      return { kind: 'service', label: 'Server', sublabel: baseNoExt };
    }
    if ((verbMatches >= 1 || declaresRouter) && (importsServerFramework || routeishPath)) {
      const subPaths = [...content.matchAll(/\brouter\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)/g)]
        .slice(0, 8).map(m => `${m[1].toUpperCase()} ${m[2]}`);
      const verbs = [...new Set(subPaths.map(s => s.split(' ')[0]))];
      return {
        kind: 'route',
        label: verbs.length ? verbs.slice(0, 3).join(' ') : 'ROUTER',
        sublabel: '/' + baseNoExt,           // placeholder; mount pass overrides
        routerSubPaths: subPaths,
        isExpressLike: true,
      };
    }
  }

  // Rust service / route files. Keep this heuristic conservative: Axum,
  // Actix, Rocket, and common main/lib entry points.
  if (base.endsWith('.rs')) {
    if (base === 'main.rs') return { kind: 'service', label: 'Rust App', sublabel: dir.slice(-1)[0] || 'main' };
    if (/\bRouter::new\s*\(|\.route\s*\(|#\[(get|post|put|patch|delete)\(/.test(content)) {
      return { kind: 'route', label: 'Rust Route', sublabel: baseNoExt };
    }
    if (/\b(?:tokio::main|actix_web::main|rocket::main)\b/.test(content)) {
      return { kind: 'service', label: 'Rust App', sublabel: baseNoExt };
    }
  }

  // Flutter / Dart UI.
  if (base.endsWith('.dart')) {
    if (lowerParts.some(p => ['screens', 'screen', 'pages', 'page', 'routes'].includes(p))) {
      return { kind: 'page', label: 'Screen', sublabel: baseNoExt };
    }
    if (/\b(?:StatelessWidget|StatefulWidget|ConsumerWidget|HookWidget)\b/.test(content)) {
      return { kind: 'component', label: 'Widget', sublabel: baseNoExt };
    }
  }

  // Swift / Kotlin UI.
  if (base.endsWith('.swift')) {
    if (/\bimport\s+SwiftUI\b/.test(content) || /\bstruct\s+\w+\s*:\s*View\b/.test(content)) {
      return { kind: lowerParts.some(p => p.includes('screen') || p.includes('view')) ? 'page' : 'component', label: 'SwiftUI', sublabel: baseNoExt };
    }
  }
  if (/\.(kt|java)$/i.test(base)) {
    if (/\bclass\s+\w+(Activity|Fragment)\b/.test(content)) return { kind: 'page', label: 'Android', sublabel: baseNoExt };
    if (/\bclass\s+\w+(ViewModel|Adapter|Controller|Service)\b/.test(content)) return { kind: 'component', label: 'Android', sublabel: baseNoExt };
  }

  // State store (Zustand / Redux / Pinia / Jotai). Detected by location OR
  // by the export creating a store via `create(...)` / `createStore`.
  if (JS_EXTS.has(path.extname(base))) {
    const inStoreDir = lowerParts.includes('stores') || lowerParts.includes('store');
    const looksLikeStore =
      /\bcreate\s*<[^>]*>\s*\(/.test(content) ||
      /\bcreate\s*\(\s*\(\s*set\b/.test(content) ||
      /\bcreateStore\s*\(/.test(content) ||
      /\bcreateSlice\s*\(/.test(content) ||
      /\bdefineStore\s*\(/.test(content) ||
      /\batom\s*\(/.test(content);
    if (inStoreDir || looksLikeStore) {
      return { kind: 'store', label: 'Store', sublabel: baseNoExt };
    }
  }

  // React hook
  if (JS_EXTS.has(path.extname(base)) && /^use[A-Z][A-Za-z0-9_]*$/.test(baseNoExt)) {
    return { kind: 'hook', label: 'Hook', sublabel: baseNoExt };
  }

  // React component (capitalized .tsx/.jsx, contains JSX)
  if (/\.(tsx|jsx)$/i.test(base) && /^[A-Z]/.test(baseNoExt)) {
    return { kind: 'component', label: 'Component', sublabel: baseNoExt };
  }
  // Inline React components (exports a capitalized JSX-returning function)
  if (/\.(tsx|jsx)$/i.test(base) && /export\s+(default\s+)?function\s+[A-Z]/.test(content)) {
    return { kind: 'component', label: 'Component', sublabel: baseNoExt };
  }

  // Tests
  if (/\.(test|spec)\.(t|j)sx?$/i.test(base)) return { kind: 'test', label: 'Test', sublabel: baseNoExt };
  if (/^test_.+\.py$/.test(base) || /_test\.py$/.test(base)) return { kind: 'test', label: 'Test', sublabel: baseNoExt };

  // Configs
  if (/(^|\.)config\.(t|j)sx?$/i.test(base) ||
      /^(tsconfig|next|vite|tailwind|webpack|babel|postcss|jest|vitest|rollup|eslint|prettier|playwright|drizzle|prisma)\..+/i.test(base) ||
      ['package.json', 'tsconfig.json', 'app.json', '.eslintrc', '.prettierrc'].includes(base)) {
    return { kind: 'config', label: 'Config', sublabel: baseNoExt };
  }

  // Schemas / Migrations
  if (/migrations?\//.test(rel.toLowerCase()) || /\.sql$/.test(base)) return { kind: 'schema', label: 'Migration', sublabel: baseNoExt };
  if (/(^|\.)schema\.(ts|js|prisma|sql)$/i.test(base)) return { kind: 'schema', label: 'Schema', sublabel: baseNoExt };

  // Styles
  if (/\.(css|scss|sass|less)$/i.test(base)) return { kind: 'styles', label: 'Styles', sublabel: baseNoExt };

  // Markdown / docs
  if (/\.md$/i.test(base)) return { kind: 'docs', label: 'Doc', sublabel: baseNoExt };

  // Generic source
  if (JS_EXTS.has(path.extname(base))) return { kind: 'module', label: baseNoExt, sublabel: '' };

  // Python module
  if (/\.py$/.test(base)) return { kind: 'module', label: baseNoExt, sublabel: '' };

  // Other source stacks.
  if (/\.(rs|go|dart|swift|kt|java|rb|php|cs|scala)$/.test(base)) {
    return { kind: 'module', label: baseNoExt, sublabel: '' };
  }

  return null;
}

// ===== Exports + import names extraction (regex heuristic) =====
function extractExports(content, ext) {
  const out = [];
  const seen = new Set();
  const add = (name, kind, line) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, kind, line });
  };
  const lineOf = (idx) => content.slice(0, idx).split('\n').length;

  if (JS_EXTS.has(ext)) {
    const fn = /export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z0-9_$]+)/g;
    let m;
    while ((m = fn.exec(content)) !== null) add(m[1], 'function', lineOf(m.index));
    const cn = /export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/g;
    while ((m = cn.exec(content)) !== null) add(m[1], 'class', lineOf(m.index));
    const va = /export\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)/g;
    while ((m = va.exec(content)) !== null) {
      // Determine arrow function vs constant by peeking at right side
      const after = content.slice(m.index + m[0].length, m.index + m[0].length + 200);
      const isFn = /^\s*[:=][^=]*?(?:\([^)]*\)\s*=>|function\b)/.test(after);
      add(m[1], isFn ? 'function' : 'const', lineOf(m.index));
    }
    const named = /export\s*\{([^}]+)\}/g;
    while ((m = named.exec(content)) !== null) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) add(name, 'named', lineOf(m.index));
      }
    }
    if (/export\s+default\b/.test(content) && !seen.has('default')) {
      const idx = content.indexOf('export default');
      add('default', 'default', lineOf(idx));
    }
    // CommonJS: module.exports = { foo, bar } or exports.foo = ...
    const objExp = /module\.exports\s*=\s*\{([^}]+)\}/g;
    while ((m = objExp.exec(content)) !== null) {
      for (const part of m[1].split(',')) {
        const k = part.trim().split(/[:\s]/)[0];
        if (k && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) add(k, 'named', lineOf(m.index));
      }
    }
    const propExp = /\bexports\.([A-Za-z0-9_$]+)\s*=/g;
    while ((m = propExp.exec(content)) !== null) add(m[1], 'named', lineOf(m.index));
    if (/module\.exports\s*=\s*function/.test(content)) add('default', 'function', 1);
    if (/module\.exports\s*=\s*class/.test(content)) add('default', 'class', 1);
  } else if (ext === '.py') {
    const fn = /^\s*def\s+([A-Za-z0-9_]+)/gm;
    let m;
    while ((m = fn.exec(content)) !== null) {
      const n = m[1];
      if (n.startsWith('_')) continue;
      add(n, 'function', lineOf(m.index));
    }
    const cn = /^\s*class\s+([A-Za-z0-9_]+)/gm;
    while ((m = cn.exec(content)) !== null) {
      const n = m[1];
      if (n.startsWith('_')) continue;
      add(n, 'class', lineOf(m.index));
    }
  } else if (ext === '.rs') {
    let m;
    const fn = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/gm;
    while ((m = fn.exec(content)) !== null) add(m[1], 'function', lineOf(m.index));
    const ty = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/gm;
    while ((m = ty.exec(content)) !== null) add(m[1], 'class', lineOf(m.index));
  } else if (ext === '.dart' || ext === '.swift' || ext === '.kt' || ext === '.java') {
    let m;
    const cn = /\b(?:class|struct|enum|interface)\s+([A-Za-z0-9_]+)/g;
    while ((m = cn.exec(content)) !== null) add(m[1], 'class', lineOf(m.index));
    const fn = ext === '.swift'
      ? /\bfunc\s+([A-Za-z0-9_]+)/g
      : /\b(?:fun|void|Future<[^>]+>|Future|Widget|String|int|double|bool)\s+([A-Za-z0-9_]+)\s*\(/g;
    while ((m = fn.exec(content)) !== null) add(m[1], 'function', lineOf(m.index));
  }
  return out.slice(0, 30); // cap to avoid runaway
}

function stripReferenceSuffix(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.split('#')[0].split('?')[0].trim();
}

function isSkippableReference(raw) {
  const s = String(raw || '').trim();
  return !s || s.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(s);
}

function normalizeReferenceSource(raw) {
  if (isSkippableReference(raw)) return null;
  const stripped = stripReferenceSuffix(raw);
  return stripped || null;
}

function referenceExt(raw) {
  return path.extname(stripReferenceSuffix(raw).toLowerCase());
}

function looksLikeLocalFileReference(raw) {
  if (!raw) return false;
  if (raw.startsWith('.') || raw.startsWith('/')) return true;
  if (raw.startsWith('@') || raw.startsWith('~')) return false;
  const ext = referenceExt(raw);
  return !!ext && LOCAL_REFERENCE_EXTS.has(ext);
}

function parseAttrs(attrText) {
  const attrs = new Map();
  const re = /([A-Za-z_:][A-Za-z0-9_:.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m;
  while ((m = re.exec(attrText || '')) !== null) {
    attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function assetImport(source, reason) {
  return {
    source,
    names: [],
    local: true,
    asset: true,
    reason,
  };
}

function extractHtmlReferences(content) {
  const out = [];
  const seen = new Set();
  const add = (raw, reason) => {
    const source = normalizeReferenceSource(raw);
    if (!source) return;
    const key = `${reason}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(assetImport(source, reason));
  };

  const tagRe = /<\s*([A-Za-z][A-Za-z0-9:-]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(content)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    if (tag === 'link') {
      const href = attrs.get('href');
      const rel = String(attrs.get('rel') || '').toLowerCase();
      if (href && /\bstylesheet\b/.test(rel)) add(href, 'stylesheet');
      else if (href && /\b(?:preload|modulepreload|icon)\b/.test(rel)) add(href, 'asset');
      continue;
    }
    if (tag === 'script') {
      add(attrs.get('src'), 'script');
      continue;
    }
    if (tag === 'a') {
      const href = attrs.get('href');
      if (href && /\.html?([?#]|$)/i.test(href)) add(href, 'asset');
      continue;
    }
    if (['img', 'source', 'video', 'audio', 'iframe', 'embed', 'object'].includes(tag)) {
      add(attrs.get(tag === 'object' ? 'data' : 'src'), 'asset');
    }
  }
  return out;
}

function extractCssReferences(content) {
  const out = [];
  const seen = new Set();
  const add = (raw, reason = 'stylesheet') => {
    const source = normalizeReferenceSource(raw);
    if (!source) return;
    const key = `${reason}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(assetImport(source, reason));
  };

  let m;
  const importRe = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^'")\s;]+))\s*\)?/gi;
  while ((m = importRe.exec(content)) !== null) add(m[1] || m[2] || m[3], 'stylesheet');

  const sassRe = /@(use|forward)\s+(?:"([^"]+)"|'([^']+)')/gi;
  while ((m = sassRe.exec(content)) !== null) add(m[2] || m[3], 'stylesheet');

  return out;
}

function extractAssetReferences(content, ext) {
  if (ext === '.html') return extractHtmlReferences(content);
  if (STYLE_EXTS.has(ext)) return extractCssReferences(content);
  return [];
}

function findCompanionStyleSources(styleFile, fileByRel) {
  const dir = path.dirname(styleFile.rel);
  const inDir = (name) => dir === '.' ? name : `${dir}/${name}`;
  const base = path.basename(styleFile.rel, styleFile.ext);
  const stem = base.replace(/\.(?:module|style|styles)$/i, '');
  const lowerStem = stem.toLowerCase();
  const candidates = new Set();

  if (stem && !['style', 'styles', 'global', 'globals'].includes(lowerStem)) {
    for (const ext of COMPANION_STYLE_SOURCE_EXTS) candidates.add(inDir(stem + ext));
  }

  if (['style', 'styles', 'global', 'globals'].includes(lowerStem)) {
    for (const name of [
      'index.html',
      'index.tsx',
      'index.jsx',
      'main.tsx',
      'main.jsx',
      'main.ts',
      'main.js',
      'app.tsx',
      'app.jsx',
      'layout.tsx',
      'layout.jsx',
      '_app.tsx',
      '_app.jsx',
      'root.tsx',
      'root.jsx',
    ]) {
      candidates.add(inDir(name));
    }
  }

  return [...candidates]
    .map(rel => fileByRel.get(rel))
    .filter(f => f && f.rel !== styleFile.rel)
    .map(f => f.rel);
}

// Returns array of { source, names: string[], local: boolean }
function extractImportsDetailed(content, ext) {
  const out = [];
  if (!JS_EXTS.has(ext)) {
    // fall back to source-only plus HTML/CSS asset references
    return mergeImports(
      extractImportsSimple(content).map(s => ({ source: s, names: [], local: s.startsWith('.') || s.startsWith('/') })),
      extractAssetReferences(content, ext)
    );
  }
  // import defaultName from "src"
  // import * as ns from "src"
  // import { a, b as c } from "src"
  // import "src"  (side-effect)
  // import defaultName, { a, b } from "src"
  const re = /^[\t ]*import\s+(?:(?:type\s+)?([^'";]+?)\s+from\s+)?['"]([^'"]+)['"];?/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const lhs = (m[1] || '').trim();
    const source = m[2];
    const names = [];
    if (lhs) {
      // strip braces / asterisks, split by comma
      const cleaned = lhs.replace(/[{}*]/g, ' ');
      for (const part of cleaned.split(',')) {
        const t = part.trim().replace(/^as\s+/, '');
        if (!t) continue;
        const renamed = t.split(/\s+as\s+/);
        const local = renamed[renamed.length - 1].trim();
        if (local && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(local)) names.push(local);
      }
    }
    out.push({ source, names, local: source.startsWith('.') || source.startsWith('/') });
  }
  // require()
  const reqRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqRe.exec(content)) !== null) {
    out.push({ source: m[1], names: [], local: m[1].startsWith('.') || m[1].startsWith('/') });
  }
  // Dynamic import() — `const x = lazy(() => import('@/foo'))`, `dynamic(() => import('./bar'))`
  const dynRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(content)) !== null) {
    out.push({ source: m[1], names: [], local: !m[1].includes('node_modules') && (m[1].startsWith('.') || m[1].startsWith('/') || m[1].startsWith('@') || m[1].startsWith('~')) });
  }
  return out;
}

function extractImportsSimple(content) {
  const out = new Set();
  const patterns = [
    /^\s*import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm,
    /^\s*from\s+([\w\.]+)\s+import\b/gm,
    /^\s*import\s+([\w\.]+)/gm,
    /^\s*use\s+([\w:]+);/gm,
    /^\s*#include\s+["<]([^">]+)[">]/gm,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) out.add(m[1]);
  }
  return [...out];
}

function tryResolveBase(base, fileIndex) {
  // TS NodeNext / ESM convention: imports point at the compiled `.js` (or `.jsx`)
  // even though source is `.ts`/`.tsx`. Try the TS source first.
  const swappedBases = [];
  if (/\.js$/.test(base))   swappedBases.push(base.replace(/\.js$/, '.ts'),   base.replace(/\.js$/, '.tsx'));
  if (/\.jsx$/.test(base))  swappedBases.push(base.replace(/\.jsx$/, '.tsx'), base.replace(/\.jsx$/, '.ts'));
  if (/\.mjs$/.test(base))  swappedBases.push(base.replace(/\.mjs$/, '.ts'),  base.replace(/\.mjs$/, '.mts'));
  if (/\.cjs$/.test(base))  swappedBases.push(base.replace(/\.cjs$/, '.ts'),  base.replace(/\.cjs$/, '.cts'));

  const styleBases = [];
  const baseName = path.basename(base);
  const baseDir = path.dirname(base);
  for (const ext of STYLE_EXTS) {
    styleBases.push(base + ext);
    if (baseName && !baseName.startsWith('_')) {
      styleBases.push(path.join(baseDir, '_' + baseName + ext));
    }
  }

  const candidates = [
    ...swappedBases,
    base,
    base + '.ts', base + '.tsx', base + '.js', base + '.jsx',
    base + '.mjs', base + '.cjs', base + '.mts', base + '.cts',
    base + '.vue', base + '.svelte',
    base + '.py', base + '.go', base + '.rs',
    ...styleBases,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.css'),
    path.join(base, 'index.scss'),
    path.join(base, '__init__.py'),
  ];
  for (const c of candidates) {
    const hit = fileIndex.get(c);
    if (hit) return hit.rel;
  }
  return null;
}

function resolveLocalImport(fromFile, importStr, fileIndex, root, aliasCfg) {
  importStr = normalizeReferenceSource(importStr);
  if (!importStr) return null;
  // Relative or absolute paths
  if (importStr.startsWith('.') || importStr.startsWith('/')) {
    const fromDir = path.dirname(fromFile.full);
    const base = importStr.startsWith('/') ? importStr : path.resolve(fromDir, importStr);
    return tryResolveBase(base, fileIndex);
  }

  // HTML/CSS references often use `styles.css` instead of `./styles.css`.
  // Treat file-like bare specifiers as relative first; package imports still
  // fall through to alias/baseUrl/external handling.
  if (looksLikeLocalFileReference(importStr)) {
    const hit = tryResolveBase(path.resolve(path.dirname(fromFile.full), importStr), fileIndex);
    if (hit) return hit;
  }

  // Path aliases (tsconfig paths)
  if (aliasCfg && aliasCfg.aliases) {
    for (const a of aliasCfg.aliases) {
      let rest = null;
      if (a.star) {
        if (importStr === a.prefix) rest = '';
        else if (importStr.startsWith(a.prefix + '/')) rest = importStr.slice(a.prefix.length + 1);
        else continue;
      } else if (importStr === a.prefix) rest = '';
      else continue;
      for (const repl of a.replacements) {
        const base = rest ? path.resolve(repl, rest) : repl;
        const hit = tryResolveBase(base, fileIndex);
        if (hit) return hit;
      }
    }
  }

  // Bare folder import that resolves under baseUrl (Next.js convention:
  // "components/Button" works without "@/" if baseUrl=".")
  if (aliasCfg && aliasCfg.baseUrl) {
    const base = path.resolve(aliasCfg.baseUrl, importStr);
    const hit = tryResolveBase(base, fileIndex);
    if (hit) return hit;
    // Also try "src/" prefix
    const baseSrc = path.resolve(aliasCfg.baseUrl, 'src', importStr);
    const hit2 = tryResolveBase(baseSrc, fileIndex);
    if (hit2) return hit2;
  }

  // Python dotted module
  const asPath = importStr.replace(/\./g, '/');
  const pyCandidates = [
    path.join(root, asPath + '.py'),
    path.join(root, asPath, '__init__.py'),
  ];
  for (const c of pyCandidates) {
    const hit = fileIndex.get(c);
    if (hit) return hit.rel;
  }
  return null;
}

// Extract paths that are *actually* API call sites. We only count a string
// path when it sits inside a recognized HTTP call: fetch, axios.*, useSWR,
// useQuery({queryKey:[...]}), useMutation, mutate, $fetch, api.*, request,
// http.*, ky.*, got.*, superagent.*, trpc.* (path style). This drops false
// positives from `router.push('/foo')`, `<Link href="/bar">`, etc., which
// are page navigation and not API calls.
function extractApiCalls(content) {
  if (!content) return null;
  const calls = new Map(); // "METHOD path" -> { path, method }

  const ownerBlocks = [];
  const ownerRe = /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\{/g;
  let ownerMatch;
  while ((ownerMatch = ownerRe.exec(content)) !== null) {
    const openIdx = content.indexOf('{', ownerMatch.index);
    if (openIdx < 0) continue;
    const closeIdx = findMatching(content, openIdx, '{', '}');
    if (closeIdx > openIdx) ownerBlocks.push({ name: ownerMatch[1], start: openIdx, end: closeIdx });
  }
  const ownerAt = (idx) => {
    for (let i = ownerBlocks.length - 1; i >= 0; i--) {
      const b = ownerBlocks[i];
      if (idx > b.start && idx < b.end) return b.name;
    }
    return null;
  };

  const methodFromOptions = (tail, fallback = null) => {
    const m = String(tail || '').match(/\bmethod\s*:\s*['"`]([A-Za-z]+)['"`]/);
    return (m ? m[1] : fallback || 'GET').toUpperCase();
  };

  const normalizePath = (raw) => {
    let p = String(raw || '').trim();
    if (!p) return null;
    // Template literals often include `${API_URL}/path` or `${apiBase}/path`.
    p = p.replace(/^\$\{[^}]*?(?:API|api|base|Base|url|URL)[^}]*\}/, '');
    // Regex capture can stop at an inner backtick in `${qs ? `?...` : ""}`.
    // In that case keep the stable path prefix and drop the dangling template.
    p = p.replace(/\$\{[^}]*$/, '');
    p = p.replace(/\$\{[^}]*\}/g, '[_]');
    p = p.split('?')[0].split('#')[0];
    if (!p.startsWith('/')) return null;
    p = p.replace(/\/+/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    if (!p || p === '/' || p.length < 3 || p.includes('[_][_')) return null;
    return p;
  };

  const addPath = (raw, method = null, idx = -1) => {
    const p = normalizePath(raw);
    if (!p) return;
    const m = (method || 'GET').toUpperCase();
    const owner = idx >= 0 ? ownerAt(idx) : null;
    calls.set(`${m} ${p} ${owner || ''}`, { path: p, method: m, owner });
  };

  let m;

  // Project API wrappers: api.get("/jobs"), api.post(`/jobs/${id}/retry`),
  // api.serverPublicGet(...), client.patch(...). These preserve the HTTP verb.
  const helperRe = /\b(?:api|client)\.(get|post|put|patch|delete|publicGet|publicPost|serverPublicGet)\s*(?:<[^>]*>)?\s*\(\s*([`'"])([\s\S]*?)\2/g;
  const helperVerb = {
    get: 'GET',
    publicGet: 'GET',
    serverPublicGet: 'GET',
    post: 'POST',
    publicPost: 'POST',
    put: 'PUT',
    patch: 'PATCH',
    delete: 'DELETE',
  };
  while ((m = helperRe.exec(content)) !== null) addPath(m[3], helperVerb[m[1]] || 'GET', m.index);

  // Lower-level wrappers: request("/jobs", { method: "POST" })
  const requestRe = /\b(?:request|serverPublicRequest)\s*(?:<[^>]*>)?\s*\(\s*([`'"])([\s\S]*?)\1([\s\S]{0,220})\)/g;
  while ((m = requestRe.exec(content)) !== null) addPath(m[2], methodFromOptions(m[3]), m.index);

  // Direct fetches, including Estate's `${apiBase}/ai/chat` style.
  const fetchRe = /\b(?:fetch|\$fetch|axios(?:\.[a-z]+)?|ky(?:\.[a-z]+)?|got(?:\.[a-z]+)?|superagent(?:\.[a-z]+)?|http(?:\.[a-z]+)?)\s*(?:<[^>]*>)?\s*\(\s*([`'"])([\s\S]*?)\1([\s\S]{0,260})\)/g;
  while ((m = fetchRe.exec(content)) !== null) addPath(m[2], methodFromOptions(m[3]), m.index);

  // Hook/query keys are reads unless the caller wraps them in a mutation.
  const qkRe = /queryKey\s*:\s*\[\s*[`'"](\/[^`'"\s]+)[`'"]/g;
  while ((m = qkRe.exec(content)) !== null) addPath(m[1], 'GET', m.index);

  // <form action="/path"> in JSX is generally a POST.
  const actionRe = /\saction\s*=\s*\{?\s*[`'"](\/[^`'"\s]+)[`'"]/g;
  while ((m = actionRe.exec(content)) !== null) addPath(m[1], 'POST', m.index);

  return calls.size ? [...calls.values()] : null;
}

// Pull each `router.METHOD("path", ...handlers)` declaration out of a route file.
// Returns [{ verb, subPath, fullStart, fullEnd }] where the offsets bound the
// full call expression including its handler body — used downstream to extract
// table refs and middleware.
function extractEndpoints(content) {
  if (!content) return [];
  const out = [];
  const re = /\brouter\.(get|post|put|delete|patch|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const verb = m[1].toUpperCase();
    const subPathRaw = m[2];
    const subPath = subPathRaw.replace(/:([A-Za-z_]\w*)/g, '[$1]');
    const callStart = m.index;
    // Find matching close paren of router.METHOD(...)
    const openParenIdx = content.indexOf('(', m.index);
    const closeParenIdx = findMatching(content, openParenIdx, '(', ')');
    out.push({ verb, subPath, subPathRaw, callStart, callEnd: closeParenIdx + 1 });
  }

  // Next.js App Router / Remix-ish route modules:
  // export async function GET() {}, export const POST = async () => {}, etc.
  const nextFnRe = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+(${HTTP_METHODS.join('|')})\\s*\\(`, 'g');
  while ((m = nextFnRe.exec(content)) !== null) {
    const verb = m[1].toUpperCase();
    const openParenIdx = content.indexOf('(', m.index);
    const closeParenIdx = findMatching(content, openParenIdx, '(', ')');
    const openBraceIdx = closeParenIdx >= 0 ? content.indexOf('{', closeParenIdx) : -1;
    const closeBraceIdx = openBraceIdx >= 0 ? findMatching(content, openBraceIdx, '{', '}') : -1;
    out.push({
      verb,
      subPath: '/',
      subPathRaw: '/',
      callStart: m.index,
      callEnd: closeBraceIdx > openBraceIdx ? closeBraceIdx + 1 : closeParenIdx + 1,
    });
  }

  const nextConstRe = new RegExp(`\\bexport\\s+const\\s+(${HTTP_METHODS.join('|')})\\b`, 'g');
  while ((m = nextConstRe.exec(content)) !== null) {
    const verb = m[1].toUpperCase();
    const eqIdx = content.indexOf('=', m.index);
    const openBraceIdx = eqIdx >= 0 ? content.indexOf('{', eqIdx) : -1;
    const closeBraceIdx = openBraceIdx >= 0 ? findMatching(content, openBraceIdx, '{', '}') : -1;
    out.push({
      verb,
      subPath: '/',
      subPathRaw: '/',
      callStart: m.index,
      callEnd: closeBraceIdx > openBraceIdx ? closeBraceIdx + 1 : Math.min(content.length, m.index + 500),
    });
  }

  return out;
}

// Find Express-style mount declarations: app.use("/api/foo", fooRouter)
// Returns array of { mountPath, routerName } pairs.
function extractMountDecls(content) {
  if (!content) return null;
  const out = [];
  const re = /\b(?:app|server|router)\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const mountPath = m[1];
    const routerName = m[2];
    if (mountPath.startsWith('/')) out.push({ mountPath, routerName });
  }
  return out.length ? out : null;
}

function classifySqlOps(body, varName) {
  const src = String(body || '');
  const name = escapeRegExp(varName);
  const ops = new Set();
  const has = (re) => re.test(src);

  if (
    has(new RegExp(`\\b(?:db\\s*\\.\\s*)?insert\\s*\\(\\s*${name}\\b`)) ||
    has(new RegExp(`\\binsertInto\\s*\\(\\s*${name}\\b`))
  ) ops.add('insert');
  if (
    has(new RegExp(`\\b(?:db\\s*\\.\\s*)?update\\s*\\(\\s*${name}\\b`)) ||
    has(new RegExp(`\\bupdateTable\\s*\\(\\s*${name}\\b`))
  ) ops.add('update');
  if (
    has(new RegExp(`\\b(?:db\\s*\\.\\s*)?delete\\s*\\(\\s*${name}\\b`)) ||
    has(new RegExp(`\\bdeleteFrom\\s*\\(\\s*${name}\\b`))
  ) ops.add('delete');
  if (
    has(new RegExp(`\\bfrom\\s*\\(\\s*${name}\\b`)) ||
    has(new RegExp(`\\bdb\\s*\\.\\s*query\\s*\\.\\s*${name}\\b`)) ||
    has(new RegExp(`\\bselect(?:From)?\\s*\\(\\s*${name}\\b`))
  ) ops.add('read');

  // If we can see the table but not the operation shape, keep the edge
  // visible as an unknown touch instead of pretending it is a read.
  if (!ops.size && new RegExp(`\\b${name}\\b`).test(src)) ops.add('touch');

  const ordered = ['read', 'insert', 'update', 'delete', 'touch'].filter(op => ops.has(op));
  return {
    operations: ordered,
    read: ops.has('read'),
    write: ops.has('insert') || ops.has('update') || ops.has('delete'),
    insert: ops.has('insert'),
    update: ops.has('update'),
    delete: ops.has('delete'),
    touch: ops.has('touch'),
  };
}

let analyzeASTImpl = null;
let analyzeASTLoadFailed = false;

function analyzeASTSafe(ext, content) {
  if (process.versions && process.versions.electron && process.env.TREE_IDE_ENABLE_ELECTRON_TREE_SITTER !== '1') {
    return null;
  }
  if (analyzeASTLoadFailed) return null;
  if (!analyzeASTImpl) {
    try {
      ({ analyzeAST: analyzeASTImpl } = require('./parser'));
    } catch {
      analyzeASTLoadFailed = true;
      return null;
    }
  }
  return analyzeASTImpl(ext, content);
}

function mergeExports(primary = [], secondary = []) {
  const out = [];
  const seen = new Set();
  const add = (e) => {
    if (!e || !e.name) return;
    const key = e.name;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  for (const e of primary || []) add(e);
  for (const e of secondary || []) add(e);
  return out.slice(0, 40);
}

function mergeImports(primary = [], secondary = []) {
  const bySource = new Map();
  const add = (imp) => {
    if (!imp || !imp.source) return;
    const reason = imp.reason || null;
    const key = `${imp.source}\0${reason || ''}`;
    const prev = bySource.get(key);
    if (!prev) {
      bySource.set(key, {
        source: imp.source,
        names: [...new Set(imp.names || [])],
        local: !!imp.local,
        asset: !!imp.asset,
        reason,
      });
      return;
    }
    prev.local = prev.local || !!imp.local;
    prev.asset = prev.asset || !!imp.asset;
    prev.reason = prev.reason || reason;
    prev.names = [...new Set([...(prev.names || []), ...(imp.names || [])])];
  };
  for (const imp of primary || []) add(imp);
  for (const imp of secondary || []) add(imp);
  return [...bySource.values()];
}

async function buildGraph(root, opts = {}) {
  const t0 = Date.now();
  const includeFnEdges = !!opts.includeFnEdges;
  const concurrency = opts.concurrency || 64;
  const fsP = require('fs').promises;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const files = await walkRepo(root);
  const fileIndex = new Map();
  const fileByRel = new Map();
  for (const f of files) {
    if (f.indexOnly) continue;
    fileIndex.set(f.full, f);
    fileByRel.set(f.rel, f);
  }
  const aliasCfg = loadPathAliases(root);
  const gitStatusByRel = loadGitStatus(root);

  // Frameworks for the root + each likely subproject (frontend/, backend/, etc.)
  // so a single repo with mixed Next + Expo Router detects both correctly.
  const frameworks = detectFrameworks(root);
  const subFrameworks = new Map(); // dir prefix → frameworks
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const subRoot = path.join(root, e.name);
      const subPkg = path.join(subRoot, 'package.json');
      if (
        fs.existsSync(subPkg) ||
        fs.existsSync(path.join(subRoot, 'Cargo.toml')) ||
        fs.existsSync(path.join(subRoot, 'pyproject.toml')) ||
        fs.existsSync(path.join(subRoot, 'requirements.txt')) ||
        fs.existsSync(path.join(subRoot, 'pubspec.yaml'))
      ) {
        const f = detectFrameworks(path.join(root, e.name));
        subFrameworks.set(e.name + '/', f);
      }
    }
  } catch {}
  const fwForRel = (rel) => {
    for (const [prefix, fw] of subFrameworks) {
      if (rel.startsWith(prefix)) return fw;
    }
    return frameworks;
  };
  const stackSummary = [...new Set([
    ...frameworkTags(frameworks),
    ...[...subFrameworks.values()].flatMap(frameworkTags),
  ])];

  const fileNodes = [];
  const fileEntries = [];
  const fileMeta = new Map(); // rel -> { exports, importsDetailed, semantic, apiCalls, isRoute, sublabel }
  const rootCache = cacheForRoot(root);
  const seenRels = new Set(files.map(f => f.rel));
  // We keep lightweight `apiCalls` metadata per file (parsed inline) instead of
  // holding full content in memory after the initial scan.

  // Parallel content read + per-file analysis in batches
  let processed = 0;
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    await Promise.all(batch.map(async (f) => {
      const cacheKey = includeFnEdges ? null : cacheKeyForFile(f);
      const cached = cacheKey ? rootCache.get(f.rel) : null;
      if (cached && cached.key === cacheKey) {
        fileMeta.set(f.rel, cloneData(cached.meta));
        const node = {
          ...cloneData(cached.node),
          gitStatus: gitStatusByRel.get(f.rel) || null,
        };
        node.indexOnly = Boolean(node.indexOnly || f.indexOnly);
        node.mapped = !node.indexOnly;
        fileEntries.push(node);
        if (!node.indexOnly) fileNodes.push(node);
        return;
      }

      if (f.indexOnly) {
        const semantic = detectIndexOnlySemantic(f.rel);
        const metaEntry = {
          exports: [],
          importsDetailed: [],
          semantic,
          apiCalls: null,
          mountDecls: [],
          tables: null,
          endpoints: null,
          content: null,
          indexOnly: true,
        };
        fileMeta.set(f.rel, metaEntry);

        const baseName = path.basename(f.rel);
        const nodeBase = {
          id: f.rel,
          label: semantic.label,
          sublabel: semantic.sublabel || '',
          kind: semantic.kind,
          methods: null,
          ext: f.ext,
          dir: path.dirname(f.rel),
          size: f.size,
          type: 'file',
          filename: baseName,
          exports: [],
          importsRefs: [],
          indexOnly: true,
          mapped: false,
        };
        fileEntries.push({
          ...nodeBase,
          gitStatus: gitStatusByRel.get(f.rel) || null,
        });
        if (cacheKey) {
          rootCache.set(f.rel, {
            key: cacheKey,
            meta: cloneData(metaEntry),
            node: cloneData(nodeBase),
          });
        }
        return;
      }

      let content = '';
      try { content = await fsP.readFile(f.full, 'utf8'); } catch { content = ''; }
      if (content.length > 200_000) content = content.slice(0, 200_000);

      let ast = null;
      try { ast = analyzeASTSafe(f.ext, content); } catch {}
      const semantic = detectSemantic(f.rel, content, fwForRel(f.rel));
      const exports = mergeExports(extractExports(content, f.ext), ast && ast.exports);
      const importsDetailed = mergeImports(extractImportsDetailed(content, f.ext), ast && ast.imports);
      const SOURCE_EXTS = new Set(['.js','.jsx','.ts','.tsx','.mjs','.cjs','.py','.go','.rb','.php','.java','.kt','.swift','.vue','.svelte','.html']);
      const apiCalls = SOURCE_EXTS.has(f.ext) ? extractApiCalls(content) : null;
      const mountDecls = extractMountDecls(content);

      // Endpoint extraction for route files — kept always, downstream synthesizes nodes
      const endpoints = (semantic && semantic.kind === 'route') ? extractEndpoints(content) : null;
      // Persist content snippet per endpoint for table-ref extraction later
      if (endpoints) {
        for (const ep of endpoints) {
          ep.body = content.slice(ep.callStart, ep.callEnd);
        }
      }

      // Schema parsing — only for files that look schema-y (cheap pre-check)
      let tables = null;
      if (semantic && semantic.kind === 'schema') {
        if (f.ext === '.prisma') tables = extractPrismaModels(content);
        else if (f.ext === '.sql') tables = extractSqlTables(content);
        else tables = extractDrizzleTables(content);
      } else if (/(pgTable|mysqlTable|sqliteTable)\s*\(/.test(content)) {
        // Source files that *contain* drizzle tables but weren't tagged as schema
        tables = extractDrizzleTables(content);
      } else if (f.ext === '.sql' && /\bcreate\s+table\b/i.test(content)) {
        tables = extractSqlTables(content);
      }

      const metaEntry = {
        exports,
        importsDetailed,
        semantic,
        apiCalls,
        mountDecls,
        tables,
        endpoints,
        content: includeFnEdges ? content : null,
      };
      fileMeta.set(f.rel, metaEntry);

      const baseName = path.basename(f.rel);
      const nodeBase = {
        id: f.rel,
        label: semantic ? semantic.label : baseName,
        sublabel: semantic ? semantic.sublabel : '',
        kind: semantic ? semantic.kind : 'module',
        methods: semantic ? semantic.methods : null,
        ext: f.ext,
        dir: path.dirname(f.rel),
        size: f.size,
        type: 'file',
        filename: baseName,
        exports: exports.map(e => ({ name: e.name, kind: e.kind, line: e.line })),
        // Lightweight import metadata for the renderer's "consumers" feature.
        importsRefs: importsDetailed
          .filter(i => i.local && i.names.length)
          .map(i => ({ source: i.source, names: i.names })),
        indexOnly: false,
        mapped: true,
      };
      const node = {
        ...nodeBase,
        gitStatus: gitStatusByRel.get(f.rel) || null,
      };
      fileNodes.push(node);
      fileEntries.push(node);
      if (cacheKey) {
        rootCache.set(f.rel, {
          key: cacheKey,
          meta: cloneData(metaEntry),
          node: cloneData(nodeBase),
        });
      }
    }));
    processed += batch.length;
    if (onProgress) onProgress(processed, files.length);
  }
  for (const rel of rootCache.keys()) {
    if (!seenRels.has(rel)) rootCache.delete(rel);
  }

  // Edges
  const fileEdges = [];
  const fileEdgeSet = new Set();
  const fnEdges = [];
  const fnEdgeSet = new Set();
  const externalSet = new Set();
  const addFileEdge = (source, target, type = 'import', extra = {}) => {
    if (!source || !target || source === target) return false;
    const key = source + '→' + target;
    if (fileEdgeSet.has(key)) return false;
    fileEdgeSet.add(key);
    fileEdges.push({ id: key, source, target, type, ...extra });
    return true;
  };

  for (const f of files) {
    const meta = fileMeta.get(f.rel);
    if (!meta) continue;
    for (const imp of meta.importsDetailed) {
      const source = normalizeReferenceSource(imp.source);
      if (!source) continue;
      const target = resolveLocalImport(f, source, fileIndex, root, aliasCfg);
      if (target && target !== f.rel) {
        addFileEdge(f.rel, target, 'import', imp.reason ? { reason: imp.reason } : {});
        // Function-level edges (only if explicitly requested; expensive)
        if (includeFnEdges && imp.names.length && meta.exports.length && meta.content) {
          const exportSpans = computeExportSpans(meta.content, meta.exports);
          for (const name of imp.names) {
            const usages = findOccurrences(meta.content, name);
            for (const u of usages) {
              const owner = ownerExportOfOffset(exportSpans, u);
              if (!owner) continue;
              const fk = `${f.rel}::${owner.name}→${target}::${name}`;
              if (fnEdgeSet.has(fk)) continue;
              fnEdgeSet.add(fk);
              fnEdges.push({
                id: fk,
                sourceFile: f.rel,
                sourceExport: owner.name,
                targetFile: target,
                targetExport: name,
              });
            }
          }
        }
      } else if (!target && !imp.asset) {
        const extId = 'ext:' + source.split('/')[0];
        externalSet.add(extId);
        addFileEdge(f.rel, extId, 'external');
      }
    }
  }

  for (const f of files) {
    if (!STYLE_EXTS.has(f.ext)) continue;
    for (const sourceRel of findCompanionStyleSources(f, fileByRel)) {
      addFileEdge(sourceRel, f.rel, 'import', { reason: 'companion-style' });
    }
  }

  for (const id of externalSet) {
    fileNodes.push({ id, label: id.replace(/^ext:/, ''), sublabel: '', kind: 'external', type: 'external', exports: [] });
  }

  // ===== Synthesize per-table nodes + FK edges from any extracted schema =====
  // A schema file can declare many tables; promote each `pgTable("X", {...})` to
  // its own node so the renderer can show them as ER cards with column lists
  // and FK lines between them.
  const tableNodes = [];
  const tableEdges = [];
  // Map varName → { fileRel, tableName, varName }
  const tableByVar = new Map();
  for (const f of files) {
    const meta = fileMeta.get(f.rel);
    if (!meta || !meta.tables || !meta.tables.length) continue;
    // Re-tag the parent file as 'schema' if it wasn't already
    if (meta.semantic && meta.semantic.kind !== 'schema') {
      meta.semantic.kind = 'schema';
      const node = fileNodes.find(n => n.id === f.rel);
      if (node) {
        node.kind = 'schema';
        node.label = 'Schema';
        node.sublabel = path.basename(f.rel, path.extname(f.rel));
      }
    }
    for (const t of meta.tables) {
      const id = `${f.rel}#${t.varName}`;
      const node = {
        id,
        label: t.tableName,
        sublabel: '',
        kind: 'table',
        type: 'file',
        ext: f.ext,
        dir: path.dirname(f.rel),
        size: 0,
        filename: t.varName,
        parentFile: f.rel,
        gitStatus: gitStatusByRel.get(f.rel) || null,
        columns: t.columns,
        exports: [],
      };
      tableNodes.push(node);
      tableByVar.set(t.varName, id);
    }
  }
  for (const f of files) {
    const meta = fileMeta.get(f.rel);
    if (!meta || !meta.tables) continue;
    for (const t of meta.tables) {
      const sourceId = `${f.rel}#${t.varName}`;
      for (const col of t.columns) {
        if (!col.fk) continue;
        const targetId = tableByVar.get(col.fk.tableVar);
        if (!targetId || targetId === sourceId) continue;
        tableEdges.push({
          id: `${sourceId}~fk~${targetId}~${col.name}`,
          source: sourceId,
          target: targetId,
          type: 'fk',
          column: col.name,
          targetColumn: col.fk.column,
        });
      }
    }
  }
  fileNodes.push(...tableNodes);

  // ===== Express-style mount-path enrichment =====
  // For every file containing `app.use("/api/foo", fooRouter)`, find the route
  // file that fooRouter was imported from and stamp it with the real mount
  // path. Then surface the mount + sub-paths on its node label.
  const routeFileToMount = new Map(); // rel → "/api/foo"
  for (const f of files) {
    const meta = fileMeta.get(f.rel);
    if (!meta || !meta.mountDecls) continue;
    // Build a local importName → resolved-rel-file map for this file
    const localImports = new Map();
    for (const imp of meta.importsDetailed) {
      const t = resolveLocalImport(f, imp.source, fileIndex, root, aliasCfg);
      if (!t) continue;
      // Default-import: `import fooRouter from "./routes/foo.js"` — the LHS
      // doesn't appear in `imp.names` when it's a default; we re-derive it
      // from the import statement structure stored loosely. As a best-effort
      // fallback we also map any named imports we did capture.
      for (const n of imp.names) localImports.set(n, t);
    }
    // We didn't keep the default-import name explicitly in `imp.names`. Re-scan
    // file for `import xxx from "./..."` patterns to catch the default name.
    // Cheap regex re-scan, only on files with mount decls.
    if (includeFnEdges) {
      // content is already in memory
    }
    // Fallback re-scan: read from disk only if we don't already have content
    // (small set of files — those that contain app.use mount decls).
    let content = meta.content;
    if (content == null) {
      try { content = fs.readFileSync(path.join(root, f.rel), 'utf8'); } catch { content = ''; }
    }
    const defaultImpRe = /^[\t ]*import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/gm;
    let mm;
    while ((mm = defaultImpRe.exec(content)) !== null) {
      const t = resolveLocalImport(f, mm[2], fileIndex, root, aliasCfg);
      if (t) localImports.set(mm[1], t);
    }
    // Apply mounts
    for (const md of meta.mountDecls) {
      const target = localImports.get(md.routerName);
      if (target) routeFileToMount.set(target, md.mountPath);
    }
  }
  // Re-stamp route file nodes with their real mount path + endpoint summary.
  for (const node of fileNodes) {
    if (node.kind !== 'route') continue;
    const meta = fileMeta.get(node.id);
    if (!meta || !meta.semantic) continue;
    const mount = routeFileToMount.get(node.id);
    if (mount) {
      // Refresh sublabel to mount path; choose label from the first route verb
      const subPaths = meta.semantic.routerSubPaths || [];
      const verbs = [...new Set(subPaths.map(s => s.split(' ')[0]))];
      node.sublabel = mount;
      node.label = verbs.length ? verbs.slice(0, 3).join(' ') : 'ROUTER';
      // Reflect in the meta semantic for downstream uses
      meta.semantic.sublabel = mount;
    }
  }

  // ===== Build a routeMap of every known endpoint path =====
  // Includes both Next-style routes (which already had /api/... in sublabel)
  // and Express routes after mount enrichment, expanded with their sub-paths.
  const routeMap = new Map();       // canonical path → rel
  const routeMethodMap = new Map(); // "METHOD /path" → rel
  const routeEntries = [];          // [{ method, path, file }]
  const addRoutePath = (routePath, file, method = null) => {
    if (!routePath || !file) return;
    let p = routePath.startsWith('/') ? routePath : '/' + routePath;
    p = p.replace(/\/+/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    if (!routeMap.has(p)) routeMap.set(p, file);
    const m = method ? String(method).toUpperCase() : null;
    if (m) routeMethodMap.set(`${m} ${p}`, file);
    routeEntries.push({ method: m, path: p, file });
  };
  for (const f of files) {
    const meta = fileMeta.get(f.rel);
    if (!meta || !meta.semantic) continue;
    const sem = meta.semantic;
    if (sem.kind !== 'route' || !sem.sublabel) continue;
    const mount = sem.sublabel;
    // Always register the mount path itself (catches `api.use("/api/foo")` calls)
    addRoutePath(mount, f.rel);
    for (const method of (sem.methods || [])) addRoutePath(mount, f.rel, method);

    // Prefer the endpoint extractor here because it handles multiline
    // Express route declarations. `semantic.routerSubPaths` is a quick label
    // hint and can miss real routes.
    if (meta.endpoints && meta.endpoints.length) {
      for (const ep of meta.endpoints) {
        const full = (mount + (ep.subPath === '/' ? '' : ep.subPath)).replace(/\/+/g, '/');
        addRoutePath(full, f.rel, ep.verb);
      }
    } else if (sem.routerSubPaths) {
      for (const sp of sem.routerSubPaths) {
        const method = sp.split(' ')[0];
        const subPathRaw = sp.split(' ').slice(1).join(' ').trim();
        if (!subPathRaw) continue;
        const subPath = subPathRaw.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '[$1]');
        const full = (mount + (subPath === '/' ? '' : subPath)).replace(/\/+/g, '/');
        addRoutePath(full, f.rel, method);
      }
    }
  }
  const dynamicRoutes = [];
  for (const { path: routePath, file: routeFile, method } of routeEntries) {
    if (/\[[^\]]+\]/.test(routePath)) {
      const pattern = '^' + routePath
        .replace(/\[\.\.\.[^\]]+\]/g, '.*')
        .replace(/\[[^\]]+\]/g, '[^/]+')
        + '$';
      dynamicRoutes.push({ re: new RegExp(pattern), file: routeFile, method });
    }
  }

  const apiEdgeSet = new Set();
  const apiEdges = [];
  // Build a "mount roots" set so we know to also try /api-prefixing arbitrary
  // path literals. e.g. mount "/api/jobs" → suffix "/jobs" should still match.
  const mountPrefixes = new Set();
  for (const k of routeMap.keys()) {
    if (k.startsWith('/api/')) mountPrefixes.add(k.slice(4)); // strip "/api"
  }

  const cleanApiPath = (p) => {
    if (!p) return null;
    let out = p.startsWith('/') ? p : '/' + p;
    out = out.replace(/\/+/g, '/');
    if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  };
  const stripApiPrefix = (p) => p && p.startsWith('/api/') ? p.slice(4) : p;
  const callPathVariants = (call) => {
    const base = cleanApiPath(call);
    if (!base) return [];
    const out = [base];
    if (base.startsWith('/api/')) out.push(base.slice(4));
    else out.push('/api' + base);
    return [...new Set(out.map(cleanApiPath).filter(Boolean))];
  };

  function matchRoute(call, method = 'GET') {
    const verb = (method || 'GET').toUpperCase();
    const variants = callPathVariants(call);
    for (const candidate of variants) {
      const exact = routeMethodMap.get(`${verb} ${candidate}`);
      if (exact) return exact;
    }
    for (const candidate of variants) {
      for (const dr of dynamicRoutes) {
        if (dr.method && dr.method !== verb) continue;
        if (dr.re.test(candidate)) return dr.file;
      }
    }
    for (const candidate of variants) {
      const target = routeMap.get(candidate);
      if (target) return target;
    }
    for (const candidate of variants) {
      for (const dr of dynamicRoutes) if (dr.re.test(candidate)) return dr.file;
    }
    // Longest-prefix match against mounted API roots. This keeps wrapper calls
    // like `/jobs/123` connected to a backend mounted at `/api/jobs`.
    for (const candidate of variants) {
      const noApi = stripApiPrefix(candidate);
      for (const root of mountPrefixes) {
        if (noApi === root || noApi.startsWith(root + '/')) {
          const mounted = cleanApiPath('/api' + noApi);
          return routeMap.get(mounted) || routeMap.get('/api/' + root) || null;
        }
      }
    }
    return null;
  }

  function nearestRoutes(call, method = 'GET') {
    const variants = callPathVariants(call).map(stripApiPrefix);
    const wanted = variants[0] || cleanApiPath(call);
    if (!wanted) return [];
    const wantedParts = wanted.split('/').filter(Boolean);
    const wantedFirst = wantedParts[0] || '';
    const wantedLast = wantedParts[wantedParts.length - 1] || '';
    const verb = (method || 'GET').toUpperCase();
    const scored = [];
    for (const entry of routeEntries) {
      const noApi = stripApiPrefix(entry.path);
      const parts = noApi.split('/').filter(Boolean);
      const first = parts[0] || '';
      const last = parts[parts.length - 1] || '';
      let score = 50;
      if (variants.includes(noApi)) score = 0;
      else if (first && first === wantedFirst) score = 6 + Math.abs(parts.length - wantedParts.length);
      else if (last && last === wantedLast) score = 12 + Math.abs(parts.length - wantedParts.length);
      else if (noApi.includes(wanted) || wanted.includes(noApi)) score = 18;
      if (entry.method && entry.method !== verb) score += 2;
      if (score >= 50) continue;
      scored.push({ score, method: entry.method || 'ANY', path: entry.path, file: entry.file });
    }
    const seen = new Set();
    return scored
      .sort((a, b) => a.score - b.score)
      .filter(c => {
        const key = `${c.method} ${c.path} ${c.file}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5)
      .map(({ method, path, file }) => ({ method, path, file }));
  }

  function unresolvedApiCall(call) {
    return {
      method: (call.method || 'GET').toUpperCase(),
      path: call.path,
      owner: call.owner || null,
      reason: 'no matching endpoint detected',
      candidates: nearestRoutes(call.path, call.method || 'GET'),
    };
  }

  // Track api calls that we couldn't resolve to any backend endpoint — these
  // are "dead calls" the user usually wants to know about (typos, removed
  // endpoints, services pointing at a different backend).
  const deadCallsByFile = new Map();
  for (const f of files) {
    const meta = fileMeta.get(f.rel);
    if (!meta || !meta.apiCalls || !meta.apiCalls.length) continue;
    if (meta.semantic && meta.semantic.kind === 'route') continue;
    for (const call of meta.apiCalls) {
      const target = matchRoute(call.path, call.method || 'GET');
      if (target && target !== f.rel) {
        const k = `${f.rel}~api~${target}~${call.method || 'GET'}~${call.path}`;
        if (apiEdgeSet.has(k)) continue;
        apiEdgeSet.add(k);
        apiEdges.push({
          id: k,
          source: f.rel,
          target,
          type: 'api-call',
          apiPath: call.path,
          apiMethod: call.method || 'GET',
          apiOwner: call.owner || null,
        });
      } else {
        if (!deadCallsByFile.has(f.rel)) deadCallsByFile.set(f.rel, []);
        deadCallsByFile.get(f.rel).push(unresolvedApiCall(call));
      }
    }
  }
  // Attach dead-call list to each source file node so the renderer can show
  // it in the side panel.
  for (const node of fileNodes) {
    const dead = deadCallsByFile.get(node.id);
    if (dead && dead.length) node.deadApiCalls = dead;
  }

  // ===== Transitive API call edges through wrappers =====
  // Real-world pattern: pages don't call fetch() directly — they import a
  // helper (services/api.ts, useQuery hooks, stores) and call helper.foo().
  // The wrapper is the file that holds the literal. We infer that any file
  // importing the wrapper indirectly hits whichever endpoints the wrapper
  // calls. One hop only (we'd cause a hairball at deeper depths).
  const directApiByFile = new Map();   // wrapper file → direct api-call edge metadata
  for (const e of apiEdges) {
    if (e.transitive) continue;
    if (!directApiByFile.has(e.source)) directApiByFile.set(e.source, []);
    directApiByFile.get(e.source).push(e);
  }
  const importsByFile = new Map();
  const importNamesByPair = new Map();
  for (const e of fileEdges) {
    if (e.type !== 'import') continue;
    if (!importsByFile.has(e.source)) importsByFile.set(e.source, []);
    importsByFile.get(e.source).push(e.target);
  }
  for (const f of files) {
    const meta = fileMeta.get(f.rel);
    if (!meta || !meta.importsDetailed) continue;
    for (const imp of meta.importsDetailed) {
      const target = resolveLocalImport(f, imp.source, fileIndex, root, aliasCfg);
      if (!target) continue;
      const key = `${f.rel}→${target}`;
      if (!importNamesByPair.has(key)) importNamesByPair.set(key, new Set());
      for (const name of (imp.names || [])) importNamesByPair.get(key).add(name);
    }
  }
  for (const [src, importedFiles] of importsByFile) {
    for (const w of importedFiles) {
      let directEdges = directApiByFile.get(w);
      if (!directEdges) continue;
      const importedNames = importNamesByPair.get(`${src}→${w}`);
      if (importedNames && importedNames.size) {
        directEdges = directEdges.filter(de => !de.apiOwner || importedNames.has(de.apiOwner));
      }
      // Generic API client modules can contain dozens of endpoint literals.
      // Propagating all of them to every importer creates a false-positive
      // hairball and makes large repos laggy. Keep transitive inference for
      // small focused wrappers/stores/hooks only.
      if (directEdges.length > 6) continue;
      for (const de of directEdges) {
        const k = `${src}~api-via~${de.target}~${de.apiMethod || 'GET'}~${de.apiPath || ''}~${w}`;
        if (apiEdgeSet.has(k)) continue;
        apiEdgeSet.add(k);
        apiEdges.push({
          id: k,
          source: src,
          target: de.target,
          type: 'api-call',
          apiPath: de.apiPath,
          apiMethod: de.apiMethod || 'GET',
          apiOwner: de.apiOwner || null,
          via: w,
          transitive: true,
        });
      }
    }
  }

  // ===== Synthesize per-endpoint nodes + endpoint→table query edges =====
  const endpointNodes = [];
  const endpointQueryEdges = [];
  for (const f of files) {
    const meta = fileMeta.get(f.rel);
    if (!meta || !meta.endpoints || !meta.endpoints.length) continue;
    if (!meta.semantic || meta.semantic.kind !== 'route') continue;
    const mount = routeFileToMount.get(f.rel) || meta.semantic.sublabel || '';
    for (const ep of meta.endpoints) {
      const fullPath = (mount + (ep.subPath === '/' ? '' : ep.subPath)).replace(/\/+/g, '/');
      const cleanPath = fullPath.replace(/[^A-Za-z0-9]+/g, '_');
      const id = `${f.rel}#${ep.verb}_${cleanPath}`;
      // Find which tables (by varName) are referenced in this endpoint's body
      const refs = new Set();
      const sqlOpsByVar = new Map();
      for (const varName of tableByVar.keys()) {
        if (new RegExp(`\\b${varName}\\b`).test(ep.body)) {
          refs.add(varName);
          sqlOpsByVar.set(varName, classifySqlOps(ep.body, varName));
        }
      }
      const tableTargets = [...refs].map(v => tableByVar.get(v)).filter(Boolean);
      endpointNodes.push({
        id,
        label: `${ep.verb} ${fullPath}`,
        sublabel: '',
        kind: 'endpoint',
        type: 'file',
        ext: f.ext,
        dir: path.dirname(f.rel),
        size: 0,
        filename: `${ep.verb} ${ep.subPath}`,
        parentFile: f.rel,
        gitStatus: gitStatusByRel.get(f.rel) || null,
        verb: ep.verb,
        fullPath,
        tableRefs: tableTargets,
        exports: [],
      });
      for (const varName of refs) {
        const t = tableByVar.get(varName);
        if (!t) continue;
        const ops = sqlOpsByVar.get(varName) || classifySqlOps(ep.body, varName);
        endpointQueryEdges.push({
          id: `${id}~q~${t}`,
          source: id, target: t, type: 'db-query',
          operations: ops.operations,
          dbRead: ops.read,
          dbWrite: ops.write,
          dbInsert: ops.insert,
          dbUpdate: ops.update,
          dbDelete: ops.delete,
          dbTouch: ops.touch,
        });
      }
    }
  }
  fileNodes.push(...endpointNodes);

  // Retarget api-call edges to specific endpoints when an exact path matches.
  // We retarget BOTH direct edges (source has its own apiCalls) and transitive
  // ones (source inherits via wrapper). For transitive edges we look up the
  // wrapper's apiCalls.
  const endpointByPath = new Map();
  const endpointByPathAndMethod = new Map();
  const endpointById = new Map();
  for (const en of endpointNodes) {
    endpointById.set(en.id, en);
    if (!endpointByPath.has(en.fullPath)) endpointByPath.set(en.fullPath, en.id);
    endpointByPathAndMethod.set(`${en.verb} ${en.fullPath}`, en.id);
  }
  const dynamicEndpoints = [];
  for (const en of endpointNodes) {
    if (/\[[^\]]+\]/.test(en.fullPath)) {
      const pattern = '^' + en.fullPath
        .replace(/\[\.\.\.[^\]]+\]/g, '.*')
        .replace(/\[[^\]]+\]/g, '[^/]+') + '$';
      dynamicEndpoints.push({ re: new RegExp(pattern), id: en.id, verb: en.verb, parentFile: en.parentFile });
    }
  }
  // Index endpoints by their parent route file for the "closest endpoint" lookup
  const endpointsByParent = new Map();
  for (const en of endpointNodes) {
    if (!endpointsByParent.has(en.parentFile)) endpointsByParent.set(en.parentFile, []);
    endpointsByParent.get(en.parentFile).push(en);
  }

  const normalizeApiCallPath = (callPath) => {
    if (!callPath) return null;
    const p = callPath.startsWith('/api/')
      ? callPath
      : '/api' + (callPath.startsWith('/') ? callPath : '/' + callPath);
    return p.replace(/\/+/g, '/');
  };

  const endpointForCall = (callPath, method, parentFile = null) => {
    const norm = normalizeApiCallPath(callPath);
    if (!norm) return null;
    const verb = (method || 'GET').toUpperCase();
    let epId = endpointByPathAndMethod.get(`${verb} ${norm}`) || endpointByPath.get(norm);
    if (epId) {
      const en = endpointById.get(epId);
      if (!parentFile || (en && en.parentFile === parentFile)) return epId;
    }
    for (const de of dynamicEndpoints) {
      if (de.verb !== verb) continue;
      if (!de.re.test(norm)) continue;
      if (!parentFile || de.parentFile === parentFile) return de.id;
    }
    for (const de of dynamicEndpoints) {
      if (!de.re.test(norm)) continue;
      if (!parentFile || de.parentFile === parentFile) return de.id;
    }
    return null;
  };

  // Drop api-call edges that point at a route file when an exact endpoint node
  // exists. API edges are per call path/method, so one frontend file can now
  // connect to several endpoints in the same route file instead of collapsing
  // to the first endpoint.
  for (const e of apiEdges) {
    if (e.target.includes('#')) continue; // already an endpoint
    let newTarget = endpointForCall(e.apiPath, e.apiMethod, e.target);
    // Fallback: pick the first endpoint of the target route file.
    // Better than dropping the edge entirely when route-file is hidden.
    if (!newTarget) {
      const eps = endpointsByParent.get(e.target);
      if (eps && eps.length) newTarget = eps[0].id;
    }
    if (newTarget) e.target = newTarget;
  }

  // ===== Endpoint internal dependency edges =====
  // Endpoint nodes are synthetic, so without these they only show external
  // callers and DB table refs. Mirror useful imports from the parent route
  // file onto each endpoint so the map can show "this endpoint uses auth,
  // validation, queue, db, storage, billing, etc." as backend-internal wiring.
  const endpointInternalEdges = [];
  const endpointInternalSet = new Set();
  const importsFromFile = new Map();
  for (const e of fileEdges) {
    if (e.type !== 'import') continue;
    if (!importsFromFile.has(e.source)) importsFromFile.set(e.source, []);
    importsFromFile.get(e.source).push(e.target);
  }
  const usefulEndpointTarget = (parentFile, target) => {
    if (!target || target === parentFile || target.startsWith('ext:')) return false;
    if (/\/routes?\//.test(target)) return false;
    if (/\.(test|spec)\./.test(target)) return false;
    return true;
  };
  for (const en of endpointNodes) {
    const imports = importsFromFile.get(en.parentFile) || [];
    for (const target of imports) {
      if (!usefulEndpointTarget(en.parentFile, target)) continue;
      const key = `${en.id}~uses~${target}`;
      if (endpointInternalSet.has(key)) continue;
      endpointInternalSet.add(key);
      endpointInternalEdges.push({
        id: key,
        source: en.id,
        target,
        type: 'endpoint-internal',
      });
    }
  }

  const finalEdges = [...fileEdges, ...apiEdges, ...tableEdges, ...endpointQueryEdges, ...endpointInternalEdges];
  const usageById = new Map();
  const ensureUsage = (id) => {
    if (!usageById.has(id)) {
      usageById.set(id, {
        incoming: 0,
        outgoing: 0,
        importIn: 0,
        importOut: 0,
        apiIn: 0,
        apiOut: 0,
        dbIn: 0,
        dbOut: 0,
        internalIn: 0,
        internalOut: 0,
        fkIn: 0,
        fkOut: 0,
      });
    }
    return usageById.get(id);
  };
  for (const e of finalEdges) {
    const sourceUsage = ensureUsage(e.source);
    const targetUsage = ensureUsage(e.target);
    sourceUsage.outgoing++;
    targetUsage.incoming++;
    if (e.type === 'import') { sourceUsage.importOut++; targetUsage.importIn++; }
    else if (e.type === 'api-call') { sourceUsage.apiOut++; targetUsage.apiIn++; }
    else if (e.type === 'db-query') { sourceUsage.dbOut++; targetUsage.dbIn++; }
    else if (e.type === 'endpoint-internal') { sourceUsage.internalOut++; targetUsage.internalIn++; }
    else if (e.type === 'fk') { sourceUsage.fkOut++; targetUsage.fkIn++; }
  }

  const sqlStatsByTable = new Map();
  const ensureSqlStats = (id) => {
    if (!sqlStatsByTable.has(id)) {
      sqlStatsByTable.set(id, {
        endpoints: 0,
        read: 0,
        write: 0,
        insert: 0,
        update: 0,
        delete: 0,
        touch: 0,
      });
    }
    return sqlStatsByTable.get(id);
  };
  for (const e of endpointQueryEdges) {
    const st = ensureSqlStats(e.target);
    st.endpoints++;
    if (e.dbRead) st.read++;
    if (e.dbWrite) st.write++;
    if (e.dbInsert) st.insert++;
    if (e.dbUpdate) st.update++;
    if (e.dbDelete) st.delete++;
    if (e.dbTouch || !(e.operations && e.operations.length)) st.touch++;
  }

  for (const node of fileNodes) {
    const usage = ensureUsage(node.id);
    if (node.kind === 'table') {
      const sqlStats = ensureSqlStats(node.id);
      node.sqlStats = sqlStats;
    }
    node.usage = usage;
  }

  return {
    nodes: fileNodes,
    files: fileEntries,
    edges: finalEdges,
    fnEdges,
    root,
    stackSummary,
    fileCount: files.length,
    elapsedMs: Date.now() - t0,
  };
}

// Compute span [startLine, endLine] for each export, by sorting export lines and using deltas.
function computeExportSpans(content, exports) {
  const lines = content.split('\n');
  const spans = exports.slice().sort((a, b) => a.line - b.line);
  const result = [];
  for (let i = 0; i < spans.length; i++) {
    const startLine = spans[i].line;
    const endLine = (i + 1 < spans.length ? spans[i + 1].line : lines.length + 1);
    // Convert to character offsets
    const startOff = lines.slice(0, startLine - 1).join('\n').length + (startLine > 1 ? 1 : 0);
    const endOff = lines.slice(0, endLine - 1).join('\n').length;
    result.push({ name: spans[i].name, startOff, endOff });
  }
  return result;
}

function findOccurrences(content, name) {
  if (!name) return [];
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    out.push(m.index);
    if (out.length > 200) break;
  }
  return out;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ===== Drizzle / Prisma schema extraction =====
// Returns [{ varName, tableName, columns:[{name, dbName, type, pk, fk:{table,column}, unique, notNull}] }]
function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0, last = 0, inStr = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === inStr && s[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(last, i)); last = i + 1; }
  }
  out.push(s.slice(last));
  return out;
}

function findMatching(content, openIdx, openCh, closeCh) {
  let depth = 1, i = openIdx + 1;
  while (i < content.length && depth > 0) {
    const c = content[i];
    if (c === openCh) depth++;
    else if (c === closeCh) depth--;
    i++;
  }
  return i - 1;
}

function extractDrizzleTables(content) {
  const tables = [];
  if (!/pgTable|mysqlTable|sqliteTable/.test(content)) return tables;
  const re = /export\s+const\s+(\w+)\s*=\s*(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([^'"]+)['"]\s*,\s*\{/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const varName = m[1];
    const tableName = m[2];
    const openIdx = m.index + m[0].length - 1; // index of "{"
    const closeIdx = findMatching(content, openIdx, '{', '}');
    const body = content.slice(openIdx + 1, closeIdx);
    const cols = parseDrizzleCols(body);
    tables.push({ varName, tableName, columns: cols });
  }
  return tables;
}

function parseDrizzleCols(body) {
  const out = [];
  for (const part of splitTopLevel(body, ',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const head = trimmed.match(/^(\w+)\s*:\s*(\w+)\s*\(\s*['"]?([^'",)]+)?['"]?/);
    if (!head) continue;
    const [, jsName, type, dbNameRaw] = head;
    const dbName = (dbNameRaw || jsName).trim();
    const isPk      = /\.\s*primaryKey\s*\(/.test(trimmed);
    const isUnique  = /\.\s*unique\s*\(/.test(trimmed);
    const isNotNull = /\.\s*notNull\s*\(/.test(trimmed);
    const fkMatch   = trimmed.match(/\.\s*references\s*\(\s*\(\s*\)\s*=>\s*(\w+)\.(\w+)/);
    out.push({
      name: jsName, dbName, type,
      pk: isPk, unique: isUnique, notNull: isNotNull,
      fk: fkMatch ? { tableVar: fkMatch[1], column: fkMatch[2] } : null,
    });
  }
  return out;
}

// Prisma schema (.prisma): `model X { ... }` blocks
function extractPrismaModels(content) {
  const models = [];
  const re = /model\s+(\w+)\s*\{/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const open = m.index + m[0].length - 1;
    const close = findMatching(content, open, '{', '}');
    const body = content.slice(open + 1, close);
    const cols = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
      const cm = t.match(/^(\w+)\s+(\S+)/);
      if (!cm) continue;
      const isPk = /@id\b/.test(t);
      const isUnique = /@unique\b/.test(t);
      const fkM = t.match(/@relation\(\s*fields:\s*\[(\w+)\][^)]*references:\s*\[(\w+)\]/);
      cols.push({
        name: cm[1], dbName: cm[1], type: cm[2],
        pk: isPk, unique: isUnique, notNull: !cm[2].endsWith('?'),
        fk: fkM ? { tableVar: cm[2].replace(/\?|\[\]/g, ''), column: fkM[2] } : null,
      });
    }
    models.push({ varName: name, tableName: name, columns: cols });
  }
  return models;
}

function extractSqlTables(content) {
  const tables = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?([\w]+)"?\.)?"?([\w]+)"?\s*\(/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    const tableName = m[2];
    const open = content.indexOf('(', m.index);
    if (open < 0) continue;
    const close = findMatching(content, open, '(', ')');
    if (close <= open) continue;
    const body = content.slice(open + 1, close);
    const columns = [];
    for (const part of splitTopLevel(body, ',')) {
      const t = part.trim();
      if (!t || /^(constraint|primary\s+key|foreign\s+key|unique|check|exclude)\b/i.test(t)) continue;
      const cm = t.match(/^"?(?:\[)?([A-Za-z_][A-Za-z0-9_]*)"?\]?\s+([A-Za-z0-9_()[\]\s,]+)/);
      if (!cm) continue;
      const name = cm[1];
      const type = cm[2].trim().split(/\s+/).slice(0, 3).join(' ');
      columns.push({
        name,
        dbName: name,
        type,
        pk: /\bprimary\s+key\b/i.test(t),
        unique: /\bunique\b/i.test(t),
        notNull: /\bnot\s+null\b/i.test(t),
        fk: null,
      });
    }
    tables.push({ varName: tableName, tableName, columns });
  }
  return tables;
}

function ownerExportOfOffset(spans, offset) {
  for (const s of spans) {
    if (offset >= s.startOff && offset < s.endOff) return s;
  }
  return null;
}

module.exports = { buildGraph, walkRepo };
