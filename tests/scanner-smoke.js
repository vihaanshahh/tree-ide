const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { Backend } = require('../src/backend');
const { analyzeAST } = require('../src/parser');
const { buildGraph } = require('../src/scanner');
const { startServer } = require('../src/server');

function tempRepo(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function wsRequest(ws, method, params) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== id) return;
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function waitForWsEvent(ws, eventName, action, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event !== eventName) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg.data);
    };
    ws.on('message', onMessage);
    Promise.resolve().then(action).catch((err) => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      reject(err);
    });
  });
}

function runLayoutWorker(nodes, edges, opts = {}) {
  const previousSelf = global.self;
  let message = null;
  global.self = { postMessage: (msg) => { message = msg; } };
  const workerPath = require.resolve('../renderer/layout.worker.js');
  delete require.cache[workerPath];
  require(workerPath);
  global.self.onmessage({ data: { action: 'layout', seq: 7, data: { nodes, edges, opts } } });
  global.self = previousSelf;
  if (!message) throw new Error('layout worker did not respond');
  if (message.error) throw new Error(message.error);
  return message.result;
}

function testAstLanguageCoverage() {
  const js = analyzeAST('.js', 'import { b as c } from "./b"; export const a = c;\n');
  assert(js.imports.some(i => i.source === './b' && i.names.includes('c')), 'JS AST should preserve aliased import local name');
  assert(js.exports.some(e => e.name === 'a'), 'JS AST should detect const export');

  const ts = analyzeAST('.ts', 'import type { T } from "./types"; export interface I {} export const a: T = 1;\n');
  assert(ts.imports.some(i => i.source === './types' && i.names.includes('T')), 'TS AST should detect type import');
  assert(ts.exports.some(e => e.name === 'I'), 'TS AST should detect interface export');

  const tsx = analyzeAST('.tsx', 'import React from "react"; export function Card(){ return <div/>; }\n');
  assert(tsx.imports.some(i => i.source === 'react' && i.names.includes('React')), 'TSX AST should detect default import');
  assert(tsx.exports.some(e => e.name === 'Card'), 'TSX AST should detect component export');

  const py = analyzeAST('.py', 'from app.models import User\nimport os\ndef load(): pass\nclass Store: pass\n');
  assert(py.exports.some(e => e.name === 'load' && e.kind === 'function'), 'Python AST should classify functions');
  assert(py.exports.some(e => e.name === 'Store' && e.kind === 'class'), 'Python AST should classify classes');

  const go = analyzeAST('.go', 'package main\nimport "fmt"\nfunc Load() {}\ntype Store struct{}\n');
  assert(go.imports.some(i => i.source === 'fmt'), 'Go AST should detect imports');
  assert(go.exports.some(e => e.name === 'Load'), 'Go AST should detect functions');

  const rs = analyzeAST('.rs', 'use crate::store::load;\npub fn load() {}\npub struct Store;\n');
  assert(rs.imports.some(i => i.source === 'crate::store::load' && i.local), 'Rust AST should detect local use declarations');
  assert(rs.exports.some(e => e.name === 'Store'), 'Rust AST should detect structs');
}

async function testTypescriptImportGraph() {
  const root = tempRepo('tree-ide-ts-');
  try {
    write(root, 'a.ts', 'import { b } from "./b";\nexport const a = b;\n');
    write(root, 'b.ts', 'export const b = 1;\n');

    const graph = await buildGraph(root);
    const a = graph.nodes.find(n => n.id === 'a.ts');
    const b = graph.nodes.find(n => n.id === 'b.ts');

    assert(a, 'a.ts node should exist');
    assert(b, 'b.ts node should exist');
    assert(a.exports.some(e => e.name === 'a'), 'a.ts export should be detected');
    assert(b.exports.some(e => e.name === 'b'), 'b.ts export should be detected');
    assert(a.importsRefs.some(ref => ref.source === './b' && ref.names.includes('b')), 'named TS import should be preserved');
    assert(graph.edges.some(e => e.source === 'a.ts' && e.target === 'b.ts'), 'TS import edge should be created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testStyleReferenceGraph() {
  const root = tempRepo('tree-ide-style-ref-');
  try {
    write(root, 'index.html', '<!doctype html><link rel="stylesheet" href="styles.css"><script src="./app.js"></script>\n');
    write(root, 'styles.css', '@import "./theme.css";\nbody { color: black; }\n');
    write(root, 'theme.css', ':root { --fg: black; }\n');
    write(root, 'app.js', 'export const loaded = true;\n');

    const graph = await buildGraph(root);
    assert(
      graph.edges.some(e => e.source === 'index.html' && e.target === 'styles.css' && e.reason === 'stylesheet'),
      'HTML stylesheet link should create a stylesheet edge'
    );
    assert(
      graph.edges.some(e => e.source === 'index.html' && e.target === 'app.js' && e.reason === 'script'),
      'HTML script src should create a script edge'
    );
    assert(
      graph.edges.some(e => e.source === 'styles.css' && e.target === 'theme.css' && e.reason === 'stylesheet'),
      'CSS @import should create a stylesheet edge'
    );
    assert(
      !graph.nodes.some(n => n.id === 'ext:styles.css'),
      'local asset references should not create external package nodes'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testCompanionStyleGraph() {
  const root = tempRepo('tree-ide-style-companion-');
  try {
    write(root, 'components/Button.tsx', 'export function Button(){ return <button />; }\n');
    write(root, 'components/Button.module.css', '.button { display: inline-flex; }\n');
    write(root, 'styles/main.scss', '@use "./tokens";\n');
    write(root, 'styles/_tokens.scss', '$gap: 8px;\n');

    const graph = await buildGraph(root);
    assert(
      graph.edges.some(e => e.source === 'components/Button.tsx' && e.target === 'components/Button.module.css' && e.reason === 'companion-style'),
      'same-name CSS module should create a companion style edge'
    );
    assert(
      graph.edges.some(e => e.source === 'styles/main.scss' && e.target === 'styles/_tokens.scss' && e.reason === 'stylesheet'),
      'Sass @use should resolve partial stylesheet files'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testBackendGraphPatch() {
  const root = tempRepo('tree-ide-patch-');
  const backend = new Backend();
  try {
    write(root, 'a.js', 'export const a = 1;\n');
    await backend.scanRepo(root);

    const patches = [];
    backend.events.on('graph:patch', patch => patches.push(patch));
    write(root, 'b.js', 'import { a } from "./a";\nexport const b = a;\n');
    await backend.rebuildGraphPatch();

    assert.strictEqual(patches.length, 1, 'one graph patch should be emitted');
    assert(patches[0].nodes.add.some(n => n.id === 'b.js'), 'patch should add b.js');
    assert(patches[0].edges.add.some(e => e.source === 'b.js' && e.target === 'a.js'), 'patch should add import edge');

    fs.unlinkSync(path.join(root, 'b.js'));
    await backend.rebuildGraphPatch();
    assert(patches[1].nodes.remove.includes('b.js'), 'patch should remove deleted node');
    assert(patches[1].edges.remove.some(id => id.includes('b.js')), 'patch should remove deleted node edges');
  } finally {
    try { await backend.fsWatcher?.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testLayoutWorker() {
  const nodes = [
    { id: 'src/a.js', label: 'a', kind: 'module', dir: 'src' },
    { id: 'src/b.js', label: 'b', kind: 'module', dir: 'src' },
    { id: 'api/route.js::GET /api/items', label: 'GET /api/items', kind: 'endpoint', dir: 'api', fullPath: '/api/items', verb: 'GET' },
  ];
  const edges = [{ id: 'src/a.js->src/b.js', source: 'src/a.js', target: 'src/b.js', type: 'import' }];
  const result = runLayoutWorker(nodes, edges, {
    visibleKinds: ['module', 'endpoint'],
    matchSet: [],
    importance: [['src/a.js', 1]],
    topPad: 100,
  });
  assert.strictEqual(result.nodes.length, 3, 'worker should return all nodes');
  assert(result.layers.length >= 1, 'worker should produce layout layers');
  assert(result.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)), 'worker should position nodes');
}

async function testServerRouteAndWsPatch() {
  const root = tempRepo('tree-ide-server-');
  const backend = new Backend();
  let server = null;
  let ws = null;
  try {
    write(root, 'a.js', 'export const a = 1;\n');
    server = await startServer({ backend, host: '127.0.0.1', port: 0 });

    const workerRes = await httpGet(`http://${server.host}:${server.port}/layout.worker.js`);
    assert.strictEqual(workerRes.status, 200, 'server should serve layout.worker.js');
    assert(workerRes.body.includes('Off-main-thread layout'), 'worker route should return worker source');

    ws = await openWs(`ws://${server.host}:${server.port}/ws?token=${encodeURIComponent(server.token)}`);
    const graph = await wsRequest(ws, 'scanRepo', [root]);
    assert(graph.nodes.some(n => n.id === 'a.js'), 'WS scanRepo should return graph data');

    const patch = await waitForWsEvent(ws, 'graph:patch', async () => {
      write(root, 'b.js', 'import { a } from "./a";\nexport const b = a;\n');
      await backend.rebuildGraphPatch();
    });
    assert(patch.nodes.add.some(n => n.id === 'b.js'), 'WS should broadcast graph patch node additions');
    assert(patch.edges.add.some(e => e.source === 'b.js' && e.target === 'a.js'), 'WS should broadcast graph patch edge additions');
  } finally {
    try { ws?.close(); } catch {}
    try { await server?.close(); } catch {}
    try { await backend.fsWatcher?.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  testAstLanguageCoverage();
  await testTypescriptImportGraph();
  await testStyleReferenceGraph();
  await testCompanionStyleGraph();
  await testBackendGraphPatch();
  testLayoutWorker();
  await testServerRouteAndWsPatch();
  console.log('graph engine smoke tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
