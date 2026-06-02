const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const { Backend } = require('../src/backend');
const { startServer } = require('../src/server');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

function tempRepo(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function waitForPage(win, expression, timeoutMs = 8000) {
  const source = `
    new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        let value = null;
        try { value = (${expression}); } catch (err) {}
        if (value) return resolve({ ok: true, value });
        if (Date.now() - started > ${timeoutMs}) return resolve({ ok: false, value });
        setTimeout(check, 80);
      };
      check();
    })
  `;
  return win.webContents.executeJavaScript(source);
}

async function main() {
  const root = tempRepo('tree-ide-renderer-');
  const backend = new Backend();
  let server = null;
  let win = null;
  const consoleErrors = [];

  try {
    write(root, 'a.ts', 'export const a = 1;\n');
    write(root, 'api/route.ts', 'export async function GET() { return Response.json({ ok: true }); }\n');

    server = await startServer({ backend, host: '127.0.0.1', port: 0 });
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2 && !/Autofill\.enable/.test(message)) consoleErrors.push(message);
    });

    await win.loadURL(server.url);
    await win.webContents.executeJavaScript(`
      (async () => {
        if (typeof openRepo !== 'function') throw new Error('openRepo is unavailable');
        if (!window.tree || typeof window.tree.onGraphPatch !== 'function') throw new Error('tree transport is missing graph patch subscription');
        await openRepo(${JSON.stringify(root)});
        return {
          root: state.root,
          nodes: state.graphData.nodes.length,
          files: graph.files.size,
          hasWorker: !!graph.layoutWorker,
          hud: document.querySelector('#hud-status')?.textContent || '',
        };
      })()
    `);

    const loaded = await waitForPage(win, `state.graphData && graph.files.has('a.ts') && graph.files.size >= 2`);
    assert(loaded.ok, 'renderer should load repo graph');

    write(root, 'b.ts', 'import { a } from "./a";\nexport const b = a;\n');
    const patched = await waitForPage(
      win,
      `state.graphData && state.graphData.nodes.some(n => n.id === 'b.ts') && state.graphData.edges.some(e => e.source === 'b.ts' && e.target === 'a.ts')`,
      10000,
    );
    assert(patched.ok, 'renderer should receive and apply graph:patch updates');

    const workerResult = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const nodes = Array.from({ length: 430 }, (_, i) => ({
          id: 'bulk/file-' + i + '.js',
          label: 'file-' + i,
          filename: 'file-' + i + '.js',
          kind: 'module',
          type: 'file',
          dir: 'bulk',
          exports: [],
          importsRefs: [],
        }));
        graph.load({ nodes, edges: [], fileCount: nodes.length, elapsedMs: 0 });
        const started = Date.now();
        const check = () => {
          if (graph.layers.length && graph.visibleNodeCount === nodes.length) {
            resolve({ ok: true, layers: graph.layers.length, visible: graph.visibleNodeCount });
            return;
          }
          if (Date.now() - started > 8000) {
            resolve({ ok: false, layers: graph.layers.length, visible: graph.visibleNodeCount });
            return;
          }
          setTimeout(check, 80);
        };
        check();
      })
    `);
    assert(workerResult.ok, `worker layout should complete for large graphs: ${JSON.stringify(workerResult)}`);

    const pageErrors = await win.webContents.executeJavaScript(`
      ({ title: document.title, tree: !!window.tree, graphFiles: graph.files.size, hud: document.querySelector('#hud-status')?.textContent || '' })
    `);
    assert.strictEqual(pageErrors.tree, true, 'window.tree should be present');
    assert(pageErrors.graphFiles >= 430, 'renderer graph should contain synthetic worker-layout nodes');
    assert.strictEqual(consoleErrors.length, 0, `renderer console errors: ${consoleErrors.join('\\n')}`);

    console.log('renderer smoke tests passed');
  } finally {
    try { win?.destroy(); } catch {}
    try { await server?.close(); } catch {}
    try { await backend.fsWatcher?.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    app.quit();
  }
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  });
});
