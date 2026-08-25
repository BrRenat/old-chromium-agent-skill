#!/usr/bin/env node
// Validate a build against an old Chromium running in a CrossOver bottle, over
// the DevTools Protocol. Writes a JSON report to stdout and to --report, plus a
// screenshot artifact for the human.
// Zero dependencies — requires Node >= 22 (global WebSocket).
//
// Flags:
//   --url               page to load                    (default: http://localhost:5173)
//   --port              DevTools Protocol port          (default: CDP_PORT or 9222)
//   --sentinel          JS expression polled until true (default: window.__APP_BOOTED === true)
//   --sentinel-timeout  ms to wait for it               (default: 20000)
//   --settle            ms to keep listening after boot (default: 3000)
//   --screenshot        png output path                 (default: ./cx-artifacts/screenshot.png)
//   --report            json output path                (default: ./cx-artifacts/report.json)
//   --ignore            comma-separated substrings to suppress in findings
//
// Environment variables read:
//   CDP_PORT  DevTools Protocol port (--port takes precedence)
//
// Exit codes:
//   0  pass
//   1  harness failure (could not reach CDP / connect / navigate)
//   2  page errors detected (JS exceptions, console errors, failed requests)
//   3  boot sentinel never became true within timeout

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`[harness] Node ${process.versions.node} — need >= 22 for global WebSocket.`);
  process.exit(1);
}

// ---------------------------------------------------------------- args

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}

const URL_ = args.url || 'http://localhost:5173';
const PORT = Number(args.port || process.env.CDP_PORT || 9222);
const SENTINEL = args.sentinel || 'window.__APP_BOOTED === true';
const SENTINEL_TIMEOUT = Number(args['sentinel-timeout'] || 20000);
const SETTLE = Number(args.settle || 3000);
const SHOT = args.screenshot || './cx-artifacts/screenshot.png';
const REPORT = args.report || './cx-artifacts/report.json';
const IGNORE = (args.ignore || '').split(',').filter(Boolean);

const log = (...m) => console.error('[harness]', ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- target

async function httpJson(path) {
  const res = await fetch(`http://localhost:${PORT}${path}`);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

let version;
try {
  version = await httpJson('/json/version');
} catch (e) {
  log(`no CDP endpoint on :${PORT} (${e.message}). Is the bottle running? Run launch.sh first.`);
  process.exit(1);
}
log('connected to', version.Browser);

// Chromium of the 53 era still accepts GET /json/new. Newer builds require PUT —
// fall back to reusing an existing tab so this keeps working if the browser is
// upgraded.
let target;
try {
  target = await httpJson(`/json/new?url=about:blank`);
} catch {
  const list = await httpJson('/json/list');
  target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) {
    log('could not create or find a page target');
    process.exit(1);
  }
}

// ---------------------------------------------------------------- cdp

const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let msgId = 0;

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 30000);
  });
}

// Domains a given build may not implement. Never let an unsupported domain
// abort the run — builds around Chromium 53 sit on the boundary where
// Console/Runtime/Log were being reshuffled, and which ones exist is not worth
// guessing.
const softSend = (m, p) => send(m, p).catch((e) => log(`optional ${m}: ${e.message}`));

const findings = [];
const seen = new Set();

function record(kind, text, extra = {}) {
  if (!text) return;
  // Match --ignore against the url too. A 404 surfaces twice: as a Network
  // event carrying the url in the text, and as a Console message whose text is
  // the generic "Failed to load resource" with the url in a separate field.
  // Matching text alone suppresses the first and leaves the second behind.
  const haystack = `${text} ${extra.url || ''}`;
  if (IGNORE.some((p) => haystack.includes(p))) return;
  const key = `${kind}::${text}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({ kind, text, ...extra });
  log(`${kind}: ${text.slice(0, 200)}`);
}

ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }

  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    return m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }

  switch (m.method) {
    // Uncaught exceptions (newer shape).
    case 'Runtime.exceptionThrown': {
      const d = m.params.exceptionDetails || {};
      const text = d.exception?.description || d.text || 'uncaught exception';
      record('exception', text, { url: d.url, line: d.lineNumber });
      break;
    }
    // Console errors — on builds of this era this is where SyntaxErrors from
    // <script> tags usually surface, which is exactly the failure mode a bad
    // transpile target produces, so it matters more than the others.
    case 'Console.messageAdded': {
      const msg = m.params.message || {};
      if (msg.level === 'error') record('console', msg.text, { url: msg.url, line: msg.line });
      break;
    }
    case 'Log.entryAdded': {
      const e = m.params.entry || {};
      if (e.level === 'error') record('log', e.text, { url: e.url, line: e.lineNumber });
      break;
    }
    // A 404 on the bundle looks identical to a syntax error from a screenshot,
    // so catch it here instead.
    case 'Network.loadingFailed':
      if (!m.params.canceled) record('network', `load failed: ${m.params.errorText}`, { type: m.params.type });
      break;
    case 'Network.responseReceived': {
      const r = m.params.response || {};
      if (r.status >= 400) record('network', `HTTP ${r.status} ${r.url}`);
      break;
    }
  }
});

await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('websocket failed')), { once: true });
  setTimeout(() => rej(new Error('websocket connect timeout')), 15000);
}).catch((e) => { log(e.message); process.exit(1); });

await softSend('Runtime.enable');
await softSend('Console.enable');
await softSend('Log.enable');
await softSend('Network.enable');
await softSend('Page.enable');

// ---------------------------------------------------------------- run

log('navigating to', URL_);
const loaded = new Promise((res) => {
  const h = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.loadEventFired') { ws.removeEventListener('message', h); res(true); }
  };
  ws.addEventListener('message', h);
  setTimeout(() => { ws.removeEventListener('message', h); res(false); }, 30000);
});

try {
  await send('Page.navigate', { url: URL_ });
} catch (e) {
  log(`navigate failed: ${e.message}`);
  process.exit(1);
}

if (!(await loaded)) log('load event never fired — continuing anyway');

// Poll the sentinel rather than sleeping a fixed amount: it distinguishes
// "parsed but died during init" from "never parsed at all", which a screenshot
// cannot do.
let booted = false;
const deadline = Date.now() + SENTINEL_TIMEOUT;
while (Date.now() < deadline) {
  try {
    const r = await send('Runtime.evaluate', {
      expression: `!!(${SENTINEL})`,
      returnByValue: true,
    });
    if (r?.result?.value === true) { booted = true; break; }
  } catch { /* page mid-navigation */ }
  await sleep(500);
}
log(booted ? 'sentinel satisfied' : `sentinel not satisfied after ${SENTINEL_TIMEOUT}ms`);

// Late-firing errors (async init, XHR failures) land in this window.
await sleep(SETTLE);

// ---------------------------------------------------------------- artifacts

let shotOk = false;
try {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(resolve(SHOT)), { recursive: true });
  writeFileSync(resolve(SHOT), Buffer.from(data, 'base64'));
  shotOk = true;
  log('screenshot ->', resolve(SHOT));
} catch (e) {
  // Chromium predates headless before 59: capture needs a real visible window.
  log(`screenshot failed (window minimized or offscreen?): ${e.message}`);
}

let title = null;
let bodyLen = null;
try {
  const r = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({t: document.title, n: (document.body && document.body.innerHTML.length) || 0})',
    returnByValue: true,
  });
  const parsed = JSON.parse(r.result.value);
  title = parsed.t;
  bodyLen = parsed.n;
} catch { /* non-fatal */ }

const syntaxErrors = findings.filter((f) => /SyntaxError|Unexpected token|Unexpected identifier/i.test(f.text));

const report = {
  ok: booted && findings.length === 0,
  browser: version.Browser,
  url: URL_,
  booted,
  sentinel: SENTINEL,
  title,
  bodyLength: bodyLen,
  screenshot: shotOk ? resolve(SHOT) : null,
  counts: {
    total: findings.length,
    syntax: syntaxErrors.length,
    exception: findings.filter((f) => f.kind === 'exception').length,
    console: findings.filter((f) => f.kind === 'console').length,
    network: findings.filter((f) => f.kind === 'network').length,
  },
  findings,
};

mkdirSync(dirname(resolve(REPORT)), { recursive: true });
writeFileSync(resolve(REPORT), JSON.stringify(report, null, 2));

// stdout is the machine-readable surface; everything above went to stderr.
console.log(JSON.stringify(report, null, 2));

try { ws.close(); } catch {}
try { await fetch(`http://localhost:${PORT}/json/close/${target.id}`); } catch {}

if (syntaxErrors.length) {
  log('SYNTAX ERROR — transpile target regression. Check babel/browserslist targets.');
  process.exit(2);
}
if (findings.length) process.exit(2);
if (!booted) process.exit(3);
log('PASS');
process.exit(0);
