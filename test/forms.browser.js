'use strict';
// HTML form attribution regression suite for real browsers.
//
// Every check is made against the HTTP request the local server actually received.
//   node test/forms.browser.js
//   BROWSERS=chromium,firefox,webkit NODE_PATH=/path/to/node_modules node test/forms.browser.js
// Engines: chromium/firefox/webkit need the `playwright` package (resolved via NODE_PATH, not a
// project dependency); chrome-cdp drives a local Google Chrome over the DevTools protocol.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SDK_FILE = path.resolve(ROOT, process.env.SDK_FILE || 'sdk.js');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT_A = Number(process.env.PORT_A || 8765);
const PORT_B = Number(process.env.PORT_B || 8766);
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const A = 'http://127.0.0.1:' + PORT_A;
const B = 'http://127.0.0.1:' + PORT_B;
const C = 'http://localhost:' + PORT_A;
const R1 = 'abcdefghijkl';
const R2 = 'bbbbbbbbbbbb';
const DEV = 'devowned1234';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function page(extraHead) {
  return `<!doctype html><html><head><meta charset="utf-8">${extraHead || ''}</head><body>
<iframe name="sink" style="width:1px;height:1px"></iframe>
<form id="f" action="${A}/submit/post" method="post" target="sink">
  <input id="inp" name="productId" value="123">
  <button id="btn" type="submit">Send</button>
  <button id="ext" type="submit" formaction="${B}/submit/ext">Ext</button>
  <button id="loc" type="submit" formaction="${A}/submit/loc">Loc</button>
  <button id="host" type="submit" formaction="${C}/submit/host">Host</button>
</form>
<form id="other" action="${A}/submit/other" method="post" target="sink"><input name="x" value="1"></form>
<script>window.__FD0 = window.FormData; window.__submit0 = HTMLFormElement.prototype.submit;</script>
<script src="/sdk.js"></script>
<script>
RefIQ.init({ siteKey: 'site_test' });
window.__submit1 = HTMLFormElement.prototype.submit;
window.__pageshow = [];
addEventListener('pageshow', function (e) { window.__pageshow.push(e.persisted); });
window.__sdkFields = function () {
  return Array.prototype.filter.call(document.querySelectorAll('input[name="rqcid"]'), function (el) {
    return !el.classList.contains('dev');
  }).length;
};
window.__send = function (url, data) {
  return fetch(url, { method: 'POST', body: data }).then(function () {}, function () {});
};
</script></body></html>`;
}

const PAGES = {
  main: page(),
  base: page(`<base href="${B}/app/">`),
};

function startServer() {
  const log = [];
  const collected = [];
  function handler(req, res) {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const host = req.headers.host || '';
      const url = new URL(req.url, 'http://' + host);
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (url.pathname === '/sdk.js') {
        const src = fs.readFileSync(SDK_FILE, 'utf8').replace('__REFIQ_CS_BACKEND_URL__', A + '/collect');
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
        res.end(src);
        return;
      }
      if (url.pathname === '/collect') {
        const accepted = [];
        try {
          (JSON.parse(body).events || []).forEach((event) => {
            collected.push(event);
            accepted.push(event.clientEventId);
          });
        } catch (e) {}
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
        res.end(JSON.stringify({ accepted, rejected: [] }));
        return;
      }
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname.startsWith('/page/') && req.method === 'GET' && !url.searchParams.has('productId')) {
        const name = url.pathname.slice(6);
        // No `no-store`: it would exclude the page from the back/forward cache.
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(PAGES[name] || '<!doctype html>away');
        return;
      }
      log.push({ t: Date.now(), host, method: req.method, path: url.pathname, query: url.search, body, contentType: req.headers['content-type'] || '', referer: req.headers.referer || '' });
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html' }, cors));
      res.end('<!doctype html>ok');
    });
  }
  const servers = [http.createServer(handler).listen(PORT_A), http.createServer(handler).listen(PORT_B)];
  return { log, collected, close: () => servers.forEach((s) => s.close()) };
}

function rqcidValues(req) {
  const text = req.method === 'GET' ? req.query.replace(/^\?/, '') : req.body;
  if (/multipart\/form-data/.test(req.contentType)) {
    const out = [];
    const re = /name="rqcid"\r\n\r\n([^\r]*)\r\n/g;
    let match;
    while ((match = re.exec(text))) out.push(match[1]);
    return out;
  }
  return new URLSearchParams(text).getAll('rqcid');
}

async function playwrightDriver(engine) {
  const pw = require('playwright');
  const browser = await pw[engine].launch();
  const context = await browser.newContext();
  const pg = await context.newPage();
  const errors = [];
  pg.on('pageerror', (err) => errors.push(String(err && err.message)));
  return {
    name: engine + ' ' + browser.version(),
    errors,
    goto: (url) => pg.goto(url, { waitUntil: 'load' }),
    evaluate: (expr) => pg.evaluate(expr),
    click: (sel) => pg.click(sel, { noWaitAfter: true }),
    enter: (sel) => pg.press(sel, 'Enter', { noWaitAfter: true }),
    back: async () => {
      await pg.goBack({ waitUntil: 'load' });
    },
    reload: () => pg.reload({ waitUntil: 'load' }),
    close: () => browser.close(),
  };
}

async function cdpDriver() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refiq-forms-'));
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(100);
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
      target = list.find((t) => t.type === 'page') || null;
    } catch (e) {}
  }
  if (!target) throw new Error('chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  const waiters = [];
  const errors = [];
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) p.reject(new Error(JSON.stringify(data.error)));
      else p.resolve(data.result);
      return;
    }
    if (data.method === 'Runtime.exceptionThrown') {
      const d = data.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].method === data.method) waiters.splice(i, 1)[0].resolve(data.params);
    }
  };
  const send = (method, params) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const waitEvent = (method, timeout) => new Promise((resolve, reject) => {
    waiters.push({ method, resolve });
    setTimeout(() => reject(new Error('timeout ' + method)), timeout || 8000);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  const version = await send('Browser.getVersion');
  async function evaluate(expression) {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error('eval: ' + JSON.stringify(out.exceptionDetails.exception && out.exceptionDetails.exception.description));
    return out.result.value;
  }
  async function point(sel) {
    return evaluate('(function(){var r=document.querySelector(' + JSON.stringify(sel) + ').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
  }
  async function click(sel) {
    const p = await point(sel);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
  return {
    name: 'chrome-cdp ' + version.product,
    errors,
    goto: async (url) => {
      const loaded = waitEvent('Page.loadEventFired');
      await send('Page.navigate', { url });
      await loaded;
    },
    evaluate,
    click,
    enter: async (sel) => {
      await evaluate('document.querySelector(' + JSON.stringify(sel) + ').focus()');
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    },
    back: async () => {
      await evaluate('history.back()');
      await sleep(1000);
    },
    reload: async () => {
      const loaded = waitEvent('Page.loadEventFired');
      await send('Page.reload');
      await loaded;
    },
    close: async () => {
      try {
        ws.close();
      } catch (e) {}
      proc.kill('SIGKILL');
      await sleep(200);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const hostOf = { A: '127.0.0.1:' + PORT_A, B: '127.0.0.1:' + PORT_B, C: 'localhost:' + PORT_A };

// expect: [{ to: 'A'|'B'|'C', path, rqcid: [...] }]; none: paths that must not be requested.
// risk: the scenario documents a known residual risk and is reported, not scored.
const SCENARIOS = [
  { id: 'F01', name: 'same-origin POST, real click', act: (d) => d.click('#btn'), expect: [{ to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'F01b', name: 'same-origin POST, real Enter', act: (d) => d.enter('#inp'), expect: [{ to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'F02', name: 'same-origin GET', setup: "f.method='get'", act: (d) => d.click('#btn'), expect: [{ to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'F03', name: 'cross-origin POST (other port)', setup: `f.action='${B}/submit/x'`, act: (d) => d.click('#btn'), expect: [{ to: 'B', path: '/submit/x', rqcid: [] }] },
  { id: 'F04', name: 'cross-origin GET', setup: `f.method='get'; f.action='${B}/submit/x'`, act: (d) => d.click('#btn'), expect: [{ to: 'B', path: '/submit/x', rqcid: [] }] },
  { id: 'F05', name: 'local form, external formaction', act: (d) => d.click('#ext'), expect: [{ to: 'B', path: '/submit/ext', rqcid: [] }] },
  { id: 'F06', name: 'external form, local formaction', setup: `f.action='${B}/submit/x'`, act: (d) => d.click('#loc'), expect: [{ to: 'A', path: '/submit/loc', rqcid: [R1] }] },
  { id: 'F07', name: 'action changed local -> external in submit handler', setup: `f.addEventListener('submit', function(){ f.action='${B}/submit/f07'; })`, act: (d) => d.click('#btn'), expect: [{ to: 'B', path: '/submit/f07', rqcid: [] }] },
  { id: 'F08', name: 'action changed external -> local in submit handler', setup: `f.action='${B}/submit/x'; f.addEventListener('submit', function(){ f.action='${A}/submit/f08'; })`, act: (d) => d.click('#btn'), expect: [{ to: 'A', path: '/submit/f08', rqcid: [R1] }] },
  { id: 'F09', name: 'requestSubmit()', act: (d) => d.evaluate('f.requestSubmit()'), expect: [{ to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'F09b', name: 'requestSubmit(external button)', act: (d) => d.evaluate("f.requestSubmit(document.getElementById('ext'))"), expect: [{ to: 'B', path: '/submit/ext', rqcid: [] }] },
  { id: 'F09c', name: 'requestSubmit(local button) on external form', setup: `f.action='${B}/submit/x'`, act: (d) => d.evaluate("f.requestSubmit(document.getElementById('loc'))"), expect: [{ to: 'A', path: '/submit/loc', rqcid: [R1] }] },
  { id: 'F10', name: 'HTMLFormElement.prototype.submit.call(form) same-origin', act: (d) => d.evaluate('HTMLFormElement.prototype.submit.call(f)'), expect: [{ to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'F10b', name: 'form.submit() cross-origin', setup: `f.action='${B}/submit/x'`, act: (d) => d.evaluate('f.submit()'), expect: [{ to: 'B', path: '/submit/x', rqcid: [] }] },
  { id: 'F10c', name: 'HTMLFormElement.prototype.submit.apply(form, [])', act: (d) => d.evaluate('HTMLFormElement.prototype.submit.apply(f, [])'), expect: [{ to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'F10d', name: 'preventDefault + form.submit() inside handler', setup: 'f.addEventListener("submit", function(e){ e.preventDefault(); f.submit(); })', act: (d) => d.click('#btn'), expect: [{ to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'F11', name: 'Cross-origin AJAX: new FormData(form)', act: (d) => d.evaluate(`__send('${B}/ajax/f11', new FormData(f))`), expect: [{ to: 'B', path: '/ajax/f11', rqcid: [] }] },
  { id: 'F11s', name: 'Same-origin AJAX: new FormData(form) (contract: no SDK field)', act: (d) => d.evaluate(`__send('${A}/ajax/same', new FormData(f))`), expect: [{ to: 'A', path: '/ajax/same', rqcid: [] }] },
  { id: 'OFD-X', name: 'Original FormData (saved before SDK) - Cross-origin', act: (d) => d.evaluate(`__send('${B}/ajax/ofd', new __FD0(f))`), expect: [{ to: 'B', path: '/ajax/ofd', rqcid: [] }] },
  { id: 'OFD-S', name: 'Original FormData (saved before SDK) - Same-origin', act: (d) => d.evaluate(`__send('${A}/ajax/ofd', new __FD0(f))`), expect: [{ to: 'A', path: '/ajax/ofd', rqcid: [] }] },
  { id: 'OFD-SUB', name: 'new FormData(form, submitter) cross-origin', act: (d) => d.evaluate(`__send('${B}/ajax/sub', new FormData(f, document.getElementById('loc')))`), expect: [{ to: 'B', path: '/ajax/sub', rqcid: [] }] },
  { id: 'S1', name: 'programmatic FormData before submit', act: async (d) => { await d.evaluate(`window.__early = new FormData(f)`); await d.click('#btn'); await d.evaluate(`__send('${B}/ajax/early', __early)`); }, expect: [{ to: 'A', path: '/submit/post', rqcid: [R1] }, { to: 'B', path: '/ajax/early', rqcid: [] }] },
  { id: 'S2', name: 'programmatic FormData in form submit listener', setup: `f.addEventListener('submit', function(){ __send('${B}/ajax/s2', new FormData(f)); })`, act: (d) => d.click('#btn'), expect: [{ to: 'B', path: '/ajax/s2', rqcid: [] }, { to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'S3', name: 'programmatic FormData in document submit listener', setup: `document.addEventListener('submit', function(){ __send('${B}/ajax/s3', new FormData(f)); })`, act: (d) => d.click('#btn'), expect: [{ to: 'B', path: '/ajax/s3', rqcid: [] }, { to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'S4', name: 'preventDefault() then cross-origin fetch', setup: `f.addEventListener('submit', function(e){ e.preventDefault(); __send('${B}/ajax/s4', new FormData(f)); })`, act: (d) => d.click('#btn'), expect: [{ to: 'B', path: '/ajax/s4', rqcid: [] }], none: ['/submit/post'] },
  { id: 'S5', name: 'programmatic FormData after native submission', act: async (d) => { await d.click('#btn'); await sleep(300); await d.evaluate(`__send('${B}/ajax/s5', new FormData(f))`); }, expect: [{ to: 'A', path: '/submit/post', rqcid: [R1] }, { to: 'B', path: '/ajax/s5', rqcid: [] }] },
  { id: 'S6', name: 'Original FormData in form submit listener', setup: `f.addEventListener('submit', function(){ __send('${B}/ajax/s6', new __FD0(f)); })`, act: (d) => d.click('#btn'), expect: [{ to: 'B', path: '/ajax/s6', rqcid: [] }, { to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'S7', name: 'nested: new FormData(other form) inside formdata handler', setup: `var o=document.getElementById('other'); document.addEventListener('formdata', function(e){ if (e.target === f && !window.__n) { window.__n = 1; __send('${B}/ajax/s7', new FormData(o)); } })`, act: (d) => d.click('#btn'), expect: [{ to: 'B', path: '/ajax/s7', rqcid: [] }, { to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'S8', name: 'microtask queued by form submit listener', setup: `f.addEventListener('submit', function(){ Promise.resolve().then(function(){ __send('${B}/ajax/s8', new FormData(f)); }); })`, act: (d) => d.click('#btn'), expect: [{ to: 'B', path: '/ajax/s8', rqcid: [] }, { to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'S9', name: 'setTimeout(0) queued by submit listener', setup: `f.addEventListener('submit', function(){ setTimeout(function(){ __send('${B}/ajax/s9', new FormData(f)); }, 0); })`, act: (d) => d.click('#btn'), expect: [{ to: 'B', path: '/ajax/s9', rqcid: [] }, { to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'RISK-1', risk: true, name: 'window submit listener registered AFTER SDK builds FormData', setup: `window.addEventListener('submit', function(){ __send('${B}/ajax/risk', new FormData(f)); })`, act: (d) => d.click('#btn'), expect: [{ to: 'B', path: '/ajax/risk', rqcid: [] }, { to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'F12', name: 'dynamic form created after init', setup: `var n=document.createElement('form'); n.method='post'; n.action='/submit/dyn'; n.target='sink'; n.innerHTML='<input name="k" value="v"><button id="dyn" type="submit">D</button>'; document.body.appendChild(n);`, act: (d) => d.click('#dyn'), expect: [{ to: 'A', path: '/submit/dyn', rqcid: [R1] }] },
  { id: 'F13', name: 'developer-owned rqcid, native', setup: `var i=document.createElement('input'); i.className='dev'; i.name='rqcid'; i.value='${DEV}'; f.appendChild(i);`, act: (d) => d.click('#btn'), expect: [{ to: 'A', path: '/submit/post', rqcid: [DEV] }] },
  { id: 'F13b', name: 'developer-owned rqcid, AJAX cross-origin', setup: `var i=document.createElement('input'); i.className='dev'; i.name='rqcid'; i.value='${DEV}'; f.appendChild(i);`, act: (d) => d.evaluate(`__send('${B}/ajax/dev', new FormData(f))`), expect: [{ to: 'B', path: '/ajax/dev', rqcid: [DEV] }] },
  { id: 'F13c', name: 'developer-owned rqcid, form.submit()', setup: `var i=document.createElement('input'); i.className='dev'; i.name='rqcid'; i.value='${DEV}'; f.appendChild(i);`, act: (d) => d.evaluate('f.submit()'), expect: [{ to: 'A', path: '/submit/post', rqcid: [DEV] }] },
  { id: 'F14', name: 'repeated submission x3', act: async (d) => { for (let i = 0; i < 3; i++) { await d.click('#btn'); await sleep(400); } }, expect: [{ to: 'A', path: '/submit/post', rqcid: [R1], count: 3 }] },
  { id: 'F15', name: 'preventDefault(): no request, no SDK field', setup: 'f.addEventListener("submit", function(e){ e.preventDefault(); })', act: (d) => d.click('#btn'), expect: [], none: ['/submit/post'] },
  { id: 'F16', name: 'native validation blocks, then valid submit', setup: `var q=document.createElement('input'); q.id='req'; q.name='req'; q.required=true; f.appendChild(q);`, act: async (d) => { await d.click('#btn'); await sleep(500); await d.evaluate("window.__blocked = document.querySelectorAll('input[name=rqcid]').length; document.getElementById('req').value='ok'"); await d.click('#btn'); }, expect: [{ to: 'A', path: '/submit/post', rqcid: [R1], count: 1 }] },
  { id: 'F16b', name: 'novalidate form with invalid field', setup: `f.noValidate = true; var q=document.createElement('input'); q.name='req'; q.required=true; f.appendChild(q);`, act: (d) => d.click('#btn'), expect: [{ to: 'A', path: '/submit/post', rqcid: [R1] }] },
  { id: 'F17', name: 'multiple submitters: other hostname formaction', act: (d) => d.click('#host'), expect: [{ to: 'C', path: '/submit/host', rqcid: [] }] },
  { id: 'F18', name: 'rqcid A -> B', url: A + '/page/main?rqcid=' + R2, act: (d) => d.click('#btn'), expect: [{ to: 'A', path: '/submit/post', rqcid: [R2] }] },
  { id: 'ADV-base', name: '<base href> other origin: relative action goes to base origin', page: 'base', setup: "f.setAttribute('action', 'order')", act: (d) => d.click('#btn'), expect: [{ to: 'B', path: '/app/order', rqcid: [] }] },
  { id: 'ADV-base-empty', name: '<base href> other origin: empty action stays on document URL', page: 'base', setup: "f.setAttribute('action', '')", act: (d) => d.click('#btn'), expect: [{ to: 'A', path: '/page/base', rqcid: [R1] }] },
  { id: 'ADV-empty', name: 'empty action', setup: "f.setAttribute('action', '')", act: (d) => d.click('#btn'), expect: [{ to: 'A', path: '/page/main', rqcid: [R1] }] },
  { id: 'ADV-missing', name: 'missing action', setup: "f.removeAttribute('action')", act: (d) => d.click('#btn'), expect: [{ to: 'A', path: '/page/main', rqcid: [R1] }] },
  { id: 'ADV-port', name: 'other port action', setup: `f.action='${B}/submit/port'`, act: (d) => d.evaluate('f.requestSubmit()'), expect: [{ to: 'B', path: '/submit/port', rqcid: [] }] },
  { id: 'ADV-host', name: 'other hostname action', setup: `f.action='${C}/submit/hn'`, act: (d) => d.click('#btn'), expect: [{ to: 'C', path: '/submit/hn', rqcid: [] }] },
  { id: 'ADV-stop', name: 'stopPropagation in form handler (fail closed, documented)', setup: 'f.addEventListener("submit", function(e){ e.stopPropagation(); })', act: (d) => d.click('#btn'), expect: [{ to: 'A', path: '/submit/post', rqcid: [] }] },
  { id: 'REINIT', name: 'init() again + SDK script loaded twice', act: async (d) => {
    await d.evaluate(`new Promise(function (resolve) { RefIQ.init({ siteKey: 'site_test' }); var s=document.createElement('script'); s.src='/sdk.js?again=1'; s.onload=resolve; document.head.appendChild(s); })`);
    await d.click('#btn');
    await sleep(300);
    await d.evaluate('f.submit()');
  }, expect: [{ to: 'A', path: '/submit/post', rqcid: [R1], count: 2 }], extra: "HTMLFormElement.prototype.submit === window.__submit1" },
];

async function runScenario(driver, server, sc) {
  const url = sc.url || A + '/page/' + (sc.page || 'main') + '?rqcid=' + R1;
  await driver.goto(url);
  const errorsBefore = driver.errors.length;
  server.log.length = 0;
  if (sc.setup) await driver.evaluate('(function(){var f=document.getElementById("f");' + sc.setup + '})()');
  await driver.evaluate('window.f = document.getElementById("f")');
  await sc.act(driver);
  const deadline = Date.now() + 5000;
  const matches = (exp) => server.log.filter((r) => r.path === exp.path);
  while (Date.now() < deadline && !sc.expect.every((exp) => matches(exp).length >= (exp.count || 1))) await sleep(50);
  await sleep(sc.none || !sc.expect.length ? 800 : 250);
  const problems = [];
  const observed = [];
  for (const exp of sc.expect) {
    const got = matches(exp);
    got.forEach((r) => observed.push({ host: r.host, method: r.method, path: r.path, rqcid: rqcidValues(r) }));
    if (got.length !== (exp.count || 1)) problems.push(exp.path + ': expected ' + (exp.count || 1) + ' request(s), server got ' + got.length);
    got.forEach((r) => {
      if (r.host !== hostOf[exp.to]) problems.push(exp.path + ': wrong host ' + r.host);
      if (JSON.stringify(rqcidValues(r)) !== JSON.stringify(exp.rqcid)) problems.push(exp.path + ': rqcid ' + JSON.stringify(rqcidValues(r)) + ' != ' + JSON.stringify(exp.rqcid));
    });
  }
  (sc.none || []).forEach((p) => {
    const got = server.log.filter((r) => r.path === p);
    if (got.length) problems.push(p + ': must not be requested, server got ' + got.length);
  });
  const state = await driver.evaluate('({ fields: __sdkFields(), fd: window.FormData === window.__FD0, wrapped: HTMLFormElement.prototype.submit === window.__submit1, blocked: window.__blocked })');
  if (state.fields !== 0) problems.push('SDK-owned rqcid inputs left in DOM: ' + state.fields);
  if (!state.fd) problems.push('window.FormData was replaced');
  if (!state.wrapped) problems.push('HTMLFormElement.prototype.submit re-wrapped');
  if (state.blocked != null && state.blocked !== 0) problems.push('rqcid input present while validation blocked submit');
  if (sc.extra && !(await driver.evaluate(sc.extra))) problems.push('check failed: ' + sc.extra);
  const errors = driver.errors.slice(errorsBefore);
  if (errors.length) problems.push('JS errors: ' + errors.join(' | '));
  return { problems, observed };
}

async function waitPaths(server, paths) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !paths.every((p) => server.log.some((r) => r.path === p))) await sleep(50);
}

async function runBfcache(driver, server) {
  await driver.goto(A + '/page/main?rqcid=' + R1);
  await driver.goto(A + '/page/away');
  server.log.length = 0;
  await driver.back();
  // History traversal may replay an earlier iframe form POST (seen in WebKit); keep it out of the click check.
  await sleep(1000);
  const replayed = server.log.filter((r) => r.path.startsWith('/submit/')).map((r) => r.path + ' ' + JSON.stringify(rqcidValues(r)));
  const shows = await driver.evaluate('window.__pageshow || null');
  server.log.length = 0;
  await driver.evaluate('window.f = document.getElementById("f")');
  const clickedAt = Date.now();
  await driver.click('#btn');
  await driver.evaluate(`__send('${B}/ajax/bf', new FormData(f))`);
  await waitPaths(server, ['/submit/post', '/ajax/bf']);
  await sleep(250);
  const nat = server.log.filter((r) => r.path === '/submit/post');
  const ajax = server.log.filter((r) => r.path === '/ajax/bf');
  const fields = await driver.evaluate('__sdkFields()');
  const problems = [];
  if (nat.length !== 1 || JSON.stringify(rqcidValues(nat[0])) !== JSON.stringify([R1])) {
    problems.push('native after back: ' + JSON.stringify(nat.map((r) => ({ t: r.t - clickedAt, rqcid: rqcidValues(r), referer: r.referer }))));
  }
  if (ajax.length !== 1 || rqcidValues(ajax[0]).length) problems.push('ajax after back: ' + JSON.stringify(ajax.map(rqcidValues)));
  if (fields) problems.push('SDK fields left: ' + fields);
  const persisted = Array.isArray(shows) && shows.indexOf(true) !== -1;
  return { problems, note: 'restored from BFCache: ' + persisted + (replayed.length ? '; history replayed before click: ' + replayed.join(', ') : '') };
}

async function runReload(driver, server) {
  await driver.goto(A + '/page/main?rqcid=' + R1);
  await driver.reload();
  server.log.length = 0;
  await driver.evaluate('window.f = document.getElementById("f")');
  await driver.click('#btn');
  await driver.evaluate(`__send('${B}/ajax/rl', new FormData(f))`);
  await waitPaths(server, ['/submit/post', '/ajax/rl']);
  await sleep(250);
  const nat = server.log.filter((r) => r.path === '/submit/post');
  const ajax = server.log.filter((r) => r.path === '/ajax/rl');
  const problems = [];
  if (nat.length !== 1 || JSON.stringify(rqcidValues(nat[0])) !== JSON.stringify([R1])) problems.push('native after reload');
  if (ajax.length !== 1 || rqcidValues(ajax[0]).length) problems.push('ajax after reload');
  return { problems };
}

function availableEngines() {
  const requested = (process.env.BROWSERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let hasPlaywright = false;
  try {
    require.resolve('playwright');
    hasPlaywright = true;
  } catch (e) {}
  const hasChrome = fs.existsSync(CHROME);
  if (requested.length) return requested;
  const out = [];
  if (hasPlaywright) out.push('chromium', 'firefox', 'webkit');
  if (hasChrome) out.push('chrome-cdp');
  return out;
}

async function main() {
  const engines = availableEngines();
  if (!engines.length) {
    console.log('BLOCKED: neither playwright nor Google Chrome is available');
    process.exit(2);
  }
  const server = startServer();
  const summary = [];
  let failed = 0;
  try {
    for (const engine of engines) {
      const driver = engine === 'chrome-cdp' ? await cdpDriver() : await playwrightDriver(engine);
      server.collected.length = 0;
      console.log('\n=== ' + driver.name + ' ===');
      const counts = { pass: 0, fail: 0, risk: 0 };
      const report = (id, name, res, risk) => {
        const status = risk ? (res.problems.length ? 'RISK-CONFIRMED' : 'RISK-NOT-REPRODUCED') : res.problems.length ? 'FAIL' : 'PASS';
        if (risk) counts.risk++;
        else if (res.problems.length) counts.fail++;
        else counts.pass++;
        console.log(status + ' ' + id + ' ' + name + (res.note ? ' (' + res.note + ')' : '') + (res.problems.length ? '\n    ' + res.problems.join('\n    ') : '') + (process.env.VERBOSE && res.observed ? '\n    ' + JSON.stringify(res.observed) : ''));
      };
      const only = (process.env.ONLY || '').split(',').filter(Boolean);
      const wanted = (id) => !only.length || only.indexOf(id) !== -1;
      const repeat = Number(process.env.REPEAT || 1);
      try {
        for (let round = 0; round < repeat; round++) {
          for (const sc of SCENARIOS.filter((s) => wanted(s.id))) {
            let res;
            try {
              res = await runScenario(driver, server, sc);
            } catch (e) {
              res = { problems: ['harness error: ' + e.message] };
            }
            report(sc.id, sc.name, res, sc.risk);
          }
          if (wanted('F20')) report('F20', 'BFCache back navigation', await runBfcache(driver, server));
          if (wanted('F20b')) report('F20b', 'reload', await runReload(driver, server));
        }
        await driver.goto(A + '/page/away');
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline && !server.collected.some((e) => e.type === 'form_submit')) await sleep(100);
        const unique = new Map();
        server.collected.filter((e) => e.type === 'form_submit').forEach((e) => unique.set(e.clientEventId, e));
        const submits = Array.from(unique.values());
        const attributed = submits.filter((e) => e.payload && e.payload.attribution && /^[a-z0-9]{12}$/.test(e.payload.attribution.rqcid || ''));
        report('CS-1', 'clickstream form_submit received by collector', {
          problems: submits.length && attributed.length === submits.length ? [] : ['form_submit events: ' + submits.length + ', with rqcid: ' + attributed.length],
          note: submits.length + ' unique form_submit events, all with attribution.rqcid',
        });
      } finally {
        await driver.close();
      }
      failed += counts.fail;
      summary.push(driver.name + ': ' + counts.pass + ' passed, ' + counts.fail + ' failed, ' + counts.risk + ' risk scenario(s)');
    }
  } finally {
    server.close();
  }
  console.log('\n' + summary.join('\n'));
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
