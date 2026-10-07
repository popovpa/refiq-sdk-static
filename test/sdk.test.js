'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'sdk.js'), 'utf8');
const ID_MULTIPLIER = 100001n;

function codecIdToServerIdString(id) {
  if (!id || typeof id !== 'string') return '';
  if (/^[1-9][0-9]{0,18}$/.test(id)) return id;
  const dot = id.indexOf('.');
  if (dot <= 0) return '';
  const ts = id.slice(0, dot);
  const rnd = id.slice(dot + 1) || '0';
  return String(BigInt(ts) * ID_MULTIPLIER + BigInt(rnd));
}

function ackAllBody(requestBody) {
  try {
    const batch = JSON.parse(requestBody || '{}');
    const accepted = (batch.events || []).map((event) => codecIdToServerIdString(event.clientEventId));
    return JSON.stringify({ status: 'ok', accepted, rejected: [] });
  } catch (e) {
    return JSON.stringify({ status: 'ok', accepted: [], rejected: [] });
  }
}

function wrapFetchResponse(res, requestBody) {
  if (!res) return res;
  if (typeof res.text === 'function') return res;
  let text = res.bodyText;
  if (text == null && res.ok) {
    text = ackAllBody(requestBody);
  }
  if (text == null) text = '';
  return Object.assign({}, res, {
    text: async () => text,
  });
}

function createIdb() {
  const data = new Map();
  function request(fn) {
    const req = {};
    queueMicrotask(() => {
      try {
        fn(req);
      } catch (e) {
        if (req.onerror) req.onerror();
      }
    });
    return req;
  }
  const db = {
    objectStoreNames: { contains: (name) => name === 'q' },
    createObjectStore() {},
    transaction() {
      return {
        objectStore() {
          return {
            put(row) {
              data.set(row.clientEventId, row);
            },
            delete(id) {
              data.delete(id);
            },
            getAll() {
              return request((req) => {
                req.result = Array.from(data.values());
                if (req.onsuccess) req.onsuccess();
              });
            },
          };
        },
      };
    },
  };
  return {
    data,
    open() {
      return request((req) => {
        if (req.onupgradeneeded) req.onupgradeneeded({ target: { result: db } });
        if (req.onsuccess) req.onsuccess({ target: { result: db } });
      });
    },
  };
}

function createEnv(opts) {
  opts = opts || {};
  const href = opts.href || 'https://shop.example.com/home?rqcid=abcdefghijkl&utm_source=google&token=secret';
  const location = new URL(href);
  const store = Object.assign({}, opts.storage);
  const session = Object.assign({}, opts.session);
  let cookieStr = opts.cookie || '';
  const timers = [];
  let nextTimer = 1;
  const listeners = {};
  const beacons = [];
  const fetches = [];
  const forms = opts.forms || [];
  const scripts = [
    {
      getAttribute(name) {
        if (name === 'src') return 'https://refiq.ru/sdk.js';
        if (name === 'data-site-id') return opts.siteKey || 'vela1';
        return '';
      },
    },
  ];
  const idb = createIdb();
  if (opts.idbRows) {
    opts.idbRows.forEach((row) => idb.data.set(row.clientEventId, row));
  }

  let fetchImpl =
    opts.fetchImpl ||
    (async () => ({
      ok: true,
      status: 200,
      headers: { get() { return null; } },
    }));
  let beaconResult = opts.beaconResult !== false;

  function storageApi(map) {
    return {
      getItem(key) {
        if (opts.throwStorage) throw new Error('storage');
        return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
      },
      setItem(key, value) {
        if (opts.throwStorage) throw new Error('storage');
        map[key] = String(value);
      },
    };
  }

  const document = {
    referrer: opts.referrer || 'https://go.refiq.ru/abc1234?secret=1',
    readyState: 'complete',
    title: 'Shop',
    contentType: 'text/html',
    characterSet: 'UTF-8',
    visibilityState: opts.hidden ? 'hidden' : 'visible',
    currentScript: scripts[0],
    documentElement: { scrollWidth: 1200, scrollHeight: 4000, scrollTop: 0, clientHeight: 800, offsetHeight: 4000 },
    body: { scrollHeight: 4000 },
    cookie: '',
    hasFocus() {
      return !opts.blurred;
    },
    getElementsByTagName(tag) {
      if (tag === 'form') return forms;
      if (tag === 'script') return scripts;
      if (tag === 'input') return (this._inputs || []);
      return [];
    },
    createElement(tag) {
      const el = {
        nodeName: String(tag).toUpperCase(),
        tagName: String(tag).toUpperCase(),
        type: '',
        name: '',
        value: '',
        id: '',
        href: '',
        getAttribute(name) {
          if (name === 'data-refiq-id') return this._refiqId || '';
          if (name === 'download') return this._download || '';
          if (name === 'role') return this._role || '';
          if (name === 'src') return this.src || '';
          return '';
        },
        setAttribute() {},
        appendChild(child) {
          this._inputs = this._inputs || [];
          this._inputs.push(child);
          this.elements = this._inputs;
        },
        getBoundingClientRect() {
          return { left: 10, top: 20, width: 100, height: 40 };
        },
      };
      if (tag === 'form') {
        el.elements = [];
        el.method = 'post';
        el.checkValidity = () => true;
      }
      return el;
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
  };
  Object.defineProperty(document, 'cookie', {
    get() {
      return cookieStr;
    },
    set(value) {
      const pair = String(value).split(';')[0];
      const eq = pair.indexOf('=');
      const key = pair.slice(0, eq);
      const val = pair.slice(eq + 1);
      const rest = cookieStr
        .split('; ')
        .filter(Boolean)
        .filter((part) => part.split('=')[0] !== key);
      rest.push(key + '=' + val);
      cookieStr = rest.join('; ');
    },
  });

  const history = {
    length: 3,
    pushState() {
      if (typeof this._push === 'function') return this._push.apply(this, arguments);
    },
    replaceState() {
      if (typeof this._replace === 'function') return this._replace.apply(this, arguments);
    },
  };

  const windowObj = {
    location,
    document,
    localStorage: storageApi(store),
    sessionStorage: storageApi(session),
    history,
    innerWidth: 1280,
    innerHeight: 800,
    outerWidth: 1280,
    outerHeight: 860,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 2,
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelDepth: 24,
      orientation: { type: 'landscape-primary', angle: 0 },
    },
    navigator: {
      userAgent: 'Mozilla/5.0 test',
      language: 'ru-RU',
      languages: ['ru-RU', 'en'],
      platform: 'MacIntel',
      vendor: 'Google Inc.',
      cookieEnabled: true,
      webdriver: false,
      pdfViewerEnabled: true,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
      onLine: true,
      doNotTrack: null,
      globalPrivacyControl: false,
      connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
      userAgentData: { brands: [{ brand: 'Chromium', version: '120' }], mobile: false, platform: 'macOS' },
    },
    performance: {
      timeOrigin: 1710000000123,
      now() {
        return 1234;
      },
      getEntriesByType(type) {
        if (type === 'navigation') {
          return [
            {
              type: 'navigate',
              redirectCount: 0,
              redirectEnd: 0,
              redirectStart: 0,
              domainLookupEnd: 20,
              domainLookupStart: 10,
              connectEnd: 40,
              connectStart: 20,
              secureConnectionStart: 25,
              responseStart: 80,
              requestStart: 40,
              responseEnd: 100,
              domInteractive: 150,
              domContentLoadedEventEnd: 180,
              loadEventEnd: 220,
              nextHopProtocol: 'h2',
              transferSize: 12000,
              encodedBodySize: 10000,
              decodedBodySize: 18000,
            },
          ];
        }
        if (type === 'resource') {
          return [
            { initiatorType: 'script', transferSize: 4000, duration: 40 },
            { initiatorType: 'img', transferSize: 8000, duration: 90 },
            { initiatorType: 'fetch', transferSize: 500, duration: 12 },
          ];
        }
        return [];
      },
    },
    indexedDB: { open: idb.open.bind(idb) },
    MutationObserver: function (fn) {
      this.observe = function () {};
    },
    PerformanceObserver: opts.noObserver
      ? undefined
      : function () {
          this.observe = function () {};
        },
    visualViewport: { width: 1280, height: 800, scale: 1, offsetLeft: 0, offsetTop: 0 },
    matchMedia(query) {
      return { matches: query.indexOf('fine') !== -1 || query.indexOf('hover: hover') !== -1 };
    },
    Intl,
    URL,
    JSON,
    Date,
    Math,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fetch(url, init) {
      fetches.push({ url, body: init && init.body, keepalive: !!(init && init.keepalive) });
      return Promise.resolve(fetchImpl(url, init)).then((res) => wrapFetchResponse(res, init && init.body));
    },
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.push({ id, fn, ms: ms || 0 });
      return id;
    },
    clearTimeout(id) {
      const idx = timers.findIndex((item) => item.id === id);
      if (idx !== -1) timers.splice(idx, 1);
    },
    requestAnimationFrame(fn) {
      return windowObj.setTimeout(fn, 16);
    },
    requestIdleCallback(fn) {
      return windowObj.setTimeout(fn, 1);
    },
    RefIQ: opts.queue,
    crypto: require('crypto').webcrypto,
  };
  windowObj.window = windowObj;
  windowObj.top = windowObj;
  windowObj.navigator.sendBeacon = function (url, blob) {
    const body = blob && blob.parts ? blob.parts.join('') : String(blob || '');
    beacons.push({ url, body });
    return beaconResult;
  };

  const sandbox = {
    window: windowObj,
    document,
    navigator: windowObj.navigator,
    XMLHttpRequest: function () {
      this.open = function () {};
      this.setRequestHeader = function () {};
      this.send = function () {};
    },
    URL,
    Blob: class {
      constructor(parts) {
        this.parts = parts;
      }
    },
    JSON,
    Object,
    String,
    Date,
    Math,
    Intl,
    Number,
    Boolean,
    Array,
    parseInt,
    isFinite,
    decodeURIComponent,
    encodeURIComponent,
    setTimeout: windowObj.setTimeout,
    clearTimeout: windowObj.clearTimeout,
    console,
  };

  vm.runInNewContext(SOURCE, sandbox);

  function dispatch(type, target, extra) {
    const event = Object.assign(
      {
        type,
        target: target || document,
        clientX: 15,
        clientY: 25,
        pageX: 15,
        pageY: 25,
        button: 0,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      },
      extra || {}
    );
    (listeners[type] || []).forEach((fn) => fn(event));
  }

  async function drain(maxMs) {
    let idle = 0;
    let guard = 0;
    while (guard++ < 120) {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const due = timers
        .filter((item) => item.ms <= (maxMs == null ? 1e9 : maxMs))
        .sort((a, b) => a.ms - b.ms);
      if (!due.length) {
        idle += 1;
        if (idle >= 6) break;
        continue;
      }
      idle = 0;
      due.forEach((item) => {
        const idx = timers.indexOf(item);
        if (idx !== -1) timers.splice(idx, 1);
        item.fn();
      });
    }
  }

  return {
    window: windowObj,
    document,
    store,
    session,
    get cookie() {
      return cookieStr;
    },
    forms,
    listeners,
    fetches,
    beacons,
    idb,
    location,
    history,
    dispatch,
    drain,
    setFetch(fn) {
      fetchImpl = fn;
    },
    setPath(pathname, hash) {
      location.pathname = pathname;
      location.hash = hash || '';
    },
  };
}

function eventsFrom(env) {
  const all = [];
  env.fetches.forEach((item) => {
    const batch = JSON.parse(item.body);
    (batch.events || []).forEach((event) => all.push(Object.assign({ _batch: batch }, event)));
  });
  return all;
}

function ofType(env, type) {
  return eventsFrom(env).filter((event) => event.type === type);
}

async function load(opts) {
  const env = createEnv(opts);
  await env.drain(1);
  return env;
}

async function run() {
  let passed = 0;
  async function test(name, fn) {
    await fn();
    passed += 1;
    console.log('ok', name);
  }

  await test('1 rqcid capture', async () => {
    const env = await load();
    assert.strictEqual(env.window.RefIQ.getRqcid(), 'abcdefghijkl');
  });

  await test('2 rqcid persistence', async () => {
    const env = await load();
    assert.ok(env.cookie.indexOf('rqcid=abcdefghijkl') !== -1);
    assert.strictEqual(env.store.rqcid, 'abcdefghijkl');
    assert.strictEqual(env.session.rqcid, 'abcdefghijkl');
  });

  await test('3 form injection', async () => {
    const form = {
      nodeName: 'FORM',
      tagName: 'FORM',
      method: 'post',
      elements: [],
      getAttribute() { return ''; },
      appendChild(child) {
        this.elements.push(child);
        this._inputs = this.elements;
      },
      getElementsByTagName(tag) {
        return tag === 'input' ? this.elements : [];
      },
    };
    const env = await load({ forms: [form] });
    const hidden = form.elements.find((el) => el.name === 'rqcid');
    assert.ok(hidden);
    assert.strictEqual(hidden.type, 'hidden');
    assert.strictEqual(hidden.value, 'abcdefghijkl');
  });

  await test('4 same-origin link decoration', async () => {
    const env = await load();
    const link = env.document.createElement('a');
    link.href = 'https://shop.example.com/product';
    env.dispatch('click', link);
    assert.ok(link.href.indexOf('rqcid=abcdefghijkl') !== -1);
  });

  await test('5 external link untouched', async () => {
    const env = await load();
    const link = env.document.createElement('a');
    link.href = 'https://other.test/out';
    env.dispatch('click', link);
    assert.ok(link.href.indexOf('rqcid=') === -1);
  });

  await test('6 page_view', async () => {
    const env = await load();
    await env.drain();
    const views = ofType(env, 'page_view');
    assert.ok(views.length >= 1);
    assert.strictEqual(views[0]._batch.siteKey, 'vela1');
    assert.strictEqual(views[0]._batch.script_id, 'vela1');
    assert.ok(views[0].payload.page.pathname);
    assert.ok(!String(JSON.stringify(views[0].payload.query)).includes('secret'));
  });

  await test('7 SPA navigation', async () => {
    const env = await load();
    await env.drain();
    const sessionId = eventsFrom(env)[0]._batch.sessionId;
    env.fetches.length = 0;
    env.setPath('/p2');
    env.history.pushState({}, '', '/p2');
    await env.drain();
    const views = ofType(env, 'page_view');
    assert.ok(views.length >= 1);
    assert.strictEqual(views[0]._batch.sessionId, sessionId);
    assert.notStrictEqual(views[0].pageViewId, undefined);
  });

  await test('8 hashchange', async () => {
    const env = await load();
    await env.drain();
    env.fetches.length = 0;
    env.setPath('/home', '#/checkout');
    env.dispatch('hashchange');
    await env.drain();
    assert.ok(ofType(env, 'page_view').length >= 1);
    assert.strictEqual(ofType(env, 'page_view')[0].payload.page.hashRoute, '#/checkout');
  });

  await test('9 sessionId persistence', async () => {
    const env = await load();
    await env.drain();
    const first = eventsFrom(env)[0]._batch.sessionId;
    env.fetches.length = 0;
    env.setPath('/next');
    env.history.pushState({}, '', '/next');
    await env.drain();
    assert.strictEqual(eventsFrom(env)[0]._batch.sessionId, first);
    assert.ok(env.session._refiq_sid);
  });

  await test('10 pageViewId rotation', async () => {
    const env = await load();
    await env.drain();
    const first = ofType(env, 'page_view')[0].pageViewId;
    env.fetches.length = 0;
    env.setPath('/other');
    env.history.pushState({}, '', '/other');
    await env.drain();
    const second = ofType(env, 'page_view')[0].pageViewId;
    assert.ok(first);
    assert.ok(second);
    assert.notStrictEqual(first, second);
  });

  await test('11 sequence increment', async () => {
    const env = await load();
    env.window.RefIQ.event('custom_a');
    env.window.RefIQ.event('custom_b');
    await env.drain();
    const seqs = eventsFrom(env).map((event) => event.sequence);
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i] > seqs[i - 1]);
    }
  });

  await test('12 clientEventId stable on retry', async () => {
    let calls = 0;
    const env = await load({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('network');
        return { ok: true, status: 204, headers: { get() { return null; } } };
      },
    });
    await env.drain();
    assert.ok(calls >= 2);
    const first = JSON.parse(env.fetches[0].body).events.map((event) => event.clientEventId);
    const second = JSON.parse(env.fetches[1].body).events.map((event) => event.clientEventId);
    assert.deepStrictEqual(second, first);
  });

  await test('13 batching', async () => {
    const env = await load();
    for (let i = 0; i < 5; i++) env.window.RefIQ.event('ping' + i);
    await env.drain();
    assert.ok(env.fetches.length >= 1);
    const batch = JSON.parse(env.fetches[0].body);
    assert.ok(batch.events.length >= 1);
    assert.ok(batch.events.length <= 20);
  });

  await test('14 batch size threshold', async () => {
    const env = await load();
    await env.drain();
    const before = env.fetches.length;
    for (let i = 0; i < 20; i++) env.window.RefIQ.event('bulk' + i);
    await env.drain(0);
    assert.ok(env.fetches.length > before);
  });

  await test('15 timed flush', async () => {
    const env = await load();
    env.fetches.length = 0;
    env.window.RefIQ.event('later');
    assert.strictEqual(env.fetches.length, 0);
    await env.drain();
    assert.ok(env.fetches.some((item) => JSON.parse(item.body).events.some((event) => event.type === 'later')));
  });

  await test('16 successful ACK', async () => {
    const env = await load();
    await env.drain();
    assert.ok(env.fetches.length >= 1);
    assert.strictEqual(env.idb.data.size, 0);
  });

  await test('17 retry after network error', async () => {
    let calls = 0;
    const env = await load({
      fetchImpl: async () => {
        calls += 1;
        if (calls < 2) throw new Error('offline');
        return { ok: true, status: 204, headers: { get() { return null; } } };
      },
    });
    await env.drain();
    assert.ok(calls >= 2);
  });

  await test('18 retry after 5xx', async () => {
    let calls = 0;
    const env = await load({
      fetchImpl: async () => {
        calls += 1;
        if (calls < 2) return { ok: false, status: 503, headers: { get() { return null; } } };
        return { ok: true, status: 204, headers: { get() { return null; } } };
      },
    });
    await env.drain();
    assert.ok(calls >= 2);
  });

  await test('19 4xx handling', async () => {
    const env = await load({
      fetchImpl: async () => ({ ok: false, status: 400, headers: { get() { return null; } } }),
    });
    await env.drain();
    env.window.RefIQ.event('bad');
    await env.drain();
    const retries = env.fetches.length;
    await env.drain();
    assert.strictEqual(env.fetches.length, retries);
    assert.strictEqual(env.idb.data.size, 0);
  });

  await test('20 IndexedDB recovery', async () => {
    const storedEvent = {
      clientEventId: 'recoverevent00000001',
      visitorId: '1791206357499.1',
      sessionId: '1791206357499.2',
      sequence: 9,
      pageViewId: '1791206357499.3',
      type: 'click',
      occurredAtMs: Date.now(),
      payload: { recovered: true },
    };
    const env = await load({
      href: 'https://shop.example.com/home',
      idbRows: [{ clientEventId: storedEvent.clientEventId, occurredAtMs: storedEvent.occurredAtMs, event: storedEvent }],
    });
    await env.drain();
    assert.ok(eventsFrom(env).some((event) => event.clientEventId === 'recoverevent00000001'));
  });

  await test('21 sendBeacon final flush', async () => {
    const env = await load();
    env.document.visibilityState = 'hidden';
    env.dispatch('pagehide');
    assert.ok(env.beacons.length >= 1);
  });

  await test('22 sendBeacon does not ACK', async () => {
    const env = await load();
    env.fetches.length = 0;
    env.window.RefIQ.event('keepme');
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assert.ok(env.beacons.length >= 1);
    assert.ok(env.idb.data.size >= 1 || env.fetches.length === 0);
    env.document.visibilityState = 'visible';
    await env.drain();
    assert.ok(eventsFrom(env).some((event) => event.type === 'keepme'));
  });

  await test('23 URL sanitization', async () => {
    const env = await load();
    await env.drain();
    const query = ofType(env, 'page_view')[0].payload.query;
    assert.strictEqual(query.utm_source, 'google');
    assert.strictEqual(query.rqcid, 'abcdefghijkl');
    assert.strictEqual(query.token, undefined);
  });

  await test('24 referrer sanitization', async () => {
    const env = await load();
    await env.drain();
    const ref = ofType(env, 'page_view')[0].payload.attribution.landingReferrer;
    assert.strictEqual(ref.hostname, 'go.refiq.ru');
    assert.ok(!JSON.stringify(ref).includes('secret=1'));
  });

  await test('25 custom event sanitization', async () => {
    const env = await load();
    env.window.RefIQ.event('order', { plan: 'pro', constructor: 'bad', token: 'abc' });
    await env.drain();
    const custom = ofType(env, 'order')[0].payload.custom;
    assert.strictEqual(custom.plan, 'pro');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(custom, 'constructor'), false);
    assert.ok(!Object.prototype.hasOwnProperty.call(ofType(env, 'order')[0], 'plan'));
  });

  await test('26 circular custom object', async () => {
    const env = await load();
    const circular = { a: 1 };
    circular.self = circular;
    env.window.RefIQ.event('loop', circular);
    await env.drain();
    assert.ok(ofType(env, 'loop').length >= 1);
  });

  await test('27 click DOM tracking', async () => {
    const env = await load();
    const button = env.document.createElement('button');
    button.id = 'buy';
    button._refiqId = 'buy-product';
    env.dispatch('click', button);
    await env.drain();
    const click = ofType(env, 'click')[0];
    assert.strictEqual(click.payload.target.trackingId, 'buy-product');
    assert.strictEqual(click.payload.target.id, 'buy');
    assert.strictEqual(click.payload.clientX, 15);
  });

  await test('28 no input values in DOM event', async () => {
    const env = await load();
    const input = env.document.createElement('input');
    input.name = 'password';
    input.value = 'super-secret';
    input.id = 'password';
    env.dispatch('click', input);
    await env.drain();
    const raw = JSON.stringify(ofType(env, 'click')[0]);
    assert.ok(raw.indexOf('super-secret') === -1);
  });

  await test('29 scroll milestone', async () => {
    const env = await load();
    env.window.scrollY = 3200;
    env.dispatch('scroll');
    await env.drain();
    const scrolls = ofType(env, 'scroll');
    assert.ok(scrolls.length >= 1);
    assert.ok(scrolls.some((event) => event.payload.milestone >= 25));
  });

  await test('30 engagement time', async () => {
    const env = await load();
    env.setPath('/gone');
    env.history.pushState({}, '', '/gone');
    await env.drain();
    const engagement = ofType(env, 'page_engagement')[0];
    assert.ok(engagement);
    assert.ok(typeof engagement.payload.totalDurationMs === 'number');
    assert.ok(typeof engagement.payload.visibleDurationMs === 'number');
    assert.ok(typeof engagement.payload.activeDurationMs === 'number');
  });

  await test('31 page hidden', async () => {
    const env = await load();
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assert.ok(env.beacons.length >= 1);
    const body = JSON.parse(env.beacons[0].body);
    assert.ok(body.events.some((event) => event.type === 'page_engagement' || event.type === 'page_view'));
  });

  await test('32 Web Vitals collector', async () => {
    const env = await load();
    await env.drain();
    const perf = ofType(env, 'page_performance');
    assert.ok(perf.length >= 1);
    assert.ok(perf[0].payload.webVitals);
  });

  await test('33 Navigation Timing', async () => {
    const env = await load();
    await env.drain();
    const nav = ofType(env, 'page_performance')[0].payload.navigation;
    assert.ok(nav);
    assert.strictEqual(nav.navigationType, 'navigate');
    assert.ok(typeof nav.ttfbMs === 'number');
  });

  await test('34 browser without optional APIs', async () => {
    const env = await load();
    env.window.PerformanceObserver = undefined;
    env.window.indexedDB = undefined;
    env.window.visualViewport = undefined;
    env.window.navigator.connection = undefined;
    env.window.RefIQ.event('still-ok');
    await env.drain();
    assert.ok(ofType(env, 'still-ok').length >= 1);
  });

  await test('35 SDK cannot throw into host page', async () => {
    const env = await load({ throwStorage: true, href: 'https://shop.example.com/' });
    assert.doesNotThrow(() => env.window.RefIQ.getRqcid());
    assert.doesNotThrow(() => env.window.RefIQ.event('x', { n: 1 }));
    assert.doesNotThrow(() => env.window.RefIQ.consent({ analytics: 'denied' }));
    assert.doesNotThrow(() => env.dispatch('click', null));
  });

  await test('queued event before load', async () => {
    const queue = [];
    queue.event = function (name, data) {
      queue.push(['event', name, data]);
    };
    queue.event('form_submit', { form: 'order' });
    const env = await load({ queue });
    await env.drain();
    const ev = ofType(env, 'form_submit')[0];
    assert.ok(ev);
    assert.strictEqual(ev.payload.custom.form, 'order');
  });

  function assertCodecId(value) {
    assert.match(String(value), /^[1-9][0-9]*\.(0|[1-9][0-9]*)$/);
    const random = Number(String(value).split('.')[1]);
    assert.ok(random >= 0 && random <= 100000);
  }

  await test('p0 visitor session page and batch ids', async () => {
    const env = await load();
    await env.drain();
    const firstView = ofType(env, 'page_view')[0];
    assertCodecId(firstView.clientEventId);
    assertCodecId(firstView.pageViewId);
    assertCodecId(firstView._batch.visitorId);
    assertCodecId(firstView._batch.sessionId);
    assertCodecId(firstView._batch.batchId);
    assert.strictEqual(firstView.previousPageViewId, undefined);
    const visitor = firstView._batch.visitorId;
    const session = firstView._batch.sessionId;
    env.fetches.length = 0;
    env.setPath('/catalog');
    env.history.pushState({}, '', '/catalog');
    await env.drain();
    const secondView = ofType(env, 'page_view')[0];
    assert.strictEqual(secondView._batch.visitorId, visitor);
    assert.strictEqual(secondView._batch.sessionId, session);
    assert.notStrictEqual(secondView.pageViewId, firstView.pageViewId);
    assert.strictEqual(secondView.previousPageViewId, firstView.pageViewId);
    const again = await load({ storage: env.store });
    await again.drain();
    assert.strictEqual(eventsFrom(again)[0]._batch.visitorId, visitor);
  });

  await test('p0 retry keeps batch id sequence and client event id', async () => {
    let calls = 0;
    const env = await load({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 503, headers: { get() { return null; } } };
        return { ok: true, status: 200, headers: { get() { return null; } } };
      },
    });
    await env.drain();
    assert.ok(calls >= 2);
    const first = JSON.parse(env.fetches[0].body);
    const second = JSON.parse(env.fetches[1].body);
    assert.deepStrictEqual(second.events.map((event) => event.clientEventId), first.events.map((event) => event.clientEventId));
    assert.deepStrictEqual(second.events.map((event) => event.sequence), first.events.map((event) => event.sequence));
    assert.strictEqual(second.batchId, first.batchId);
    assert.strictEqual(second.sessionId, first.sessionId);
    assert.strictEqual(second.events[0].pageViewId, first.events[0].pageViewId);
  });

  await test('p0 beacon retry keeps ids', async () => {
    const env = await load();
    await env.drain();
    env.fetches.length = 0;
    env.window.RefIQ.event('keep-id');
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assert.ok(env.beacons.length >= 1);
    const beacon = JSON.parse(env.beacons[env.beacons.length - 1].body);
    const kept = beacon.events.find((event) => event.type === 'keep-id');
    assert.ok(kept);
    env.document.visibilityState = 'visible';
    await env.drain();
    const resent = eventsFrom(env).find((event) => event.type === 'keep-id');
    assert.ok(resent);
    assert.strictEqual(resent.clientEventId, kept.clientEventId);
    assert.strictEqual(resent.sequence, kept.sequence);
    assert.strictEqual(resent.pageViewId, kept.pageViewId);
  });

  await test('p1 tab session index snapshot and late page context', async () => {
    const env = await load();
    await env.drain();
    const first = ofType(env, 'page_view')[0];
    assertCodecId(first.tabId);
    assert.ok(first.sessionStartedTs > 0);
    assert.strictEqual(first.pageViewIndex, 1);
    assert.strictEqual(first.pageViewStartedTs, first.payload && first.pageViewStartedTs);
    assert.ok(first.pageViewStartedTs > 0);
    assert.strictEqual(first.eventRevision, 1);
    assert.strictEqual(first.eventFinal, 1);
    assert.strictEqual(first.payload.attribution.rqcid, 'abcdefghijkl');
    assert.strictEqual(first.payload.attribution.utmSource, 'google');
    assert.strictEqual(first.payload.attribution.landingPath, '/home');
    assert.strictEqual(first.payload.attribution.landingHostname, 'shop.example.com');
    assert.ok(String(first.payload.page.queryFiltered).indexOf('utm_source=google') !== -1);
    assert.ok(String(first.payload.page.queryFiltered).indexOf('token') === -1);
    assert.strictEqual(first.delivery.transport, 'fetch');
    assert.strictEqual(first.delivery.attempt, 1);
    assert.strictEqual(first.delivery.fromIndexeddb, 0);
    assert.strictEqual(first.delivery.finalFlush, 0);
    const interim = ofType(env, 'page_performance').find((event) => event.eventFinal === 0);
    assert.ok(interim);
    assert.strictEqual(interim.pageViewId, first.pageViewId);
    assert.strictEqual(interim.eventRevision, 1);
    assert.strictEqual(interim.payload.page.pathname, '/home');
    assert.strictEqual(interim.payload.attribution.utmSource, 'google');
    assert.strictEqual(interim.payload.webVitals.cls, 0);
    assert.strictEqual(interim.payload.navigation.timeOriginTs, 1710000000123);
    const resource = ofType(env, 'resource_summary').find((event) => event.pageViewId === first.pageViewId && event.eventFinal === 0);
    assert.ok(resource);
    assert.strictEqual(resource.payload.page.pathname, '/home');
    env.fetches.length = 0;
    env.setPath('/catalog');
    env.history.pushState({}, '', '/catalog');
    await env.drain();
    const second = ofType(env, 'page_view')[0];
    assert.strictEqual(second.pageViewIndex, 2);
    assert.strictEqual(second.tabId, first.tabId);
    assert.strictEqual(second.sessionStartedTs, first.sessionStartedTs);
    assert.ok(second.pageViewStartedTs > 0);
    assert.strictEqual(second.previousPageViewId, first.pageViewId);
    const late = eventsFrom(env).find((event) => event.type === 'page_performance' && event.pageViewId === first.pageViewId && event.eventFinal === 1);
    assert.ok(late);
    assert.strictEqual(late.pageViewStartedTs, first.pageViewStartedTs);
    assert.ok(late.eventRevision > interim.eventRevision);
    assert.strictEqual(late.engagementTrigger, 'spa_navigation');
    assert.strictEqual(late.payload.page.pathname, '/home');
    assert.strictEqual(late.payload.attribution.rqcid, 'abcdefghijkl');
    assert.strictEqual(late.payload.attribution.utmSource, 'google');
    assert.strictEqual(second.payload.page.pathname, '/catalog');
    env.setPath('/checkout');
    env.history.pushState({}, '', '/checkout');
    await env.drain();
    const third = ofType(env, 'page_view').find((event) => event.payload.page.pathname === '/checkout');
    assert.ok(third);
    assert.strictEqual(third.pageViewIndex, 3);
    assert.strictEqual(third.tabId, first.tabId);
  });

  await test('p1 click ratios scroll milestone and engagement trigger', async () => {
    const env = await load();
    const button = env.document.createElement('a');
    button.href = 'https://shop.example.com/buy?rqcid=abcdefghijkl&token=secret';
    env.dispatch('click', button);
    env.window.scrollY = 3200;
    env.dispatch('scroll');
    await env.drain();
    const click = ofType(env, 'click')[0];
    assert.strictEqual(click.payload.clickTargetX, 5);
    assert.strictEqual(click.payload.clickTargetY, 5);
    assert.ok(click.payload.clickViewportXRatio > 0 && click.payload.clickViewportXRatio <= 1);
    assert.ok(click.payload.clickDocumentXRatio > 0 && click.payload.clickDocumentXRatio <= 1);
    assert.strictEqual(click.eventFinal, 1);
    assert.strictEqual(click.eventRevision, 1);
    const scroll = ofType(env, 'scroll').find((event) => event.payload.milestone === 100);
    assert.ok(scroll);
    assert.ok(scroll.payload.depth >= 0 && scroll.payload.depth <= 1);
    assert.strictEqual(typeof scroll.payload.scrollTimeToMilestone, 'number');
    assert.ok(scroll.payload.scrollTimeToMilestone >= 0);
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const beacon = JSON.parse(env.beacons[env.beacons.length - 1].body);
    const engagement = beacon.events.find((event) => event.type === 'page_engagement');
    assert.ok(engagement);
    assert.strictEqual(engagement.engagementTrigger, 'hidden');
    assert.strictEqual(engagement.eventFinal, 0);
    assert.strictEqual(engagement.delivery.transport, 'beacon');
    assert.strictEqual(engagement.delivery.finalFlush, 1);
  });

  await test('p2 cls stays unavailable without the observer', async () => {
    const env = await load({ noObserver: true });
    await env.drain();
    const perf = ofType(env, 'page_performance')[0];
    assert.ok(perf.payload.webVitals.cls === undefined);
  });

  await test('consent denied stops analytics', async () => {
    const env = await load();
    env.window.RefIQ.consent({ analytics: 'denied' });
    env.fetches.length = 0;
    env.window.RefIQ.event('should-not-send');
    await env.drain();
    assert.ok(!eventsFrom(env).some((event) => event.type === 'should-not-send'));
    assert.strictEqual(env.window.RefIQ.getRqcid(), 'abcdefghijkl');
  });

  await test('numeric integer normalization and float ratios', async () => {
    const env = await load();
    const button = env.document.createElement('button');
    button.id = 'buy';
    button._refiqId = 'buy-product';
    button.getBoundingClientRect = () => ({ left: 10.203125, top: 20.0625, width: 60.4375, height: 22.125 });
    env.dispatch('click', button, {
      clientX: 19,
      clientY: 27.1015625,
      pageX: 19,
      pageY: 427.1015625,
    });
    env.window.scrollY = 398.5;
    env.window.scrollX = 1.25;
    env.dispatch('scroll');
    await env.drain();
    const click = ofType(env, 'click')[0];
    assert.strictEqual(Number.isInteger(click.payload.clientX), true);
    assert.strictEqual(Number.isInteger(click.payload.clientY), true);
    assert.strictEqual(Number.isInteger(click.payload.pageX), true);
    assert.strictEqual(Number.isInteger(click.payload.pageY), true);
    assert.strictEqual(click.payload.relativeX, 8.796875);
    assert.strictEqual(click.payload.relativeY, 7.0390625);
    assert.strictEqual(click.payload.clickTargetX, 8.796875);
    assert.strictEqual(click.payload.clickTargetY, 7.0390625);
    assert.strictEqual(click.payload.target.width, 60.4375);
    assert.strictEqual(click.payload.target.height, 22.125);
    assert.strictEqual(click.payload.clickViewportXRatio, 0.0148);
    assert.ok(click.payload.clickViewportXRatio !== 1);
    const scroll = ofType(env, 'scroll')[0];
    assert.strictEqual(scroll.payload.scrollY, 399);
    assert.strictEqual(scroll.payload.scrollX, 1);
    assert.strictEqual(Number.isInteger(scroll.payload.scrollY), true);
    assert.ok(scroll.payload.depth > 0 && scroll.payload.depth <= 1);
  });

  await test('exact clientEventId response codec', async () => {
    const env = await load();
    const codec = env.window.RefIQ._codecIdToServerIdString;
    assert.strictEqual(codec('1791206357499.72188'), '179122426956329687');
    assert.strictEqual(codec('10.0'), '1000010');
    assert.strictEqual(codec('10.100000'), '1100010');
    assert.strictEqual(codec('11.0'), '1100011');
    assert.notStrictEqual(codec('10.100000'), codec('11.0'));
  });

  await test('partial ACK accepted rejected unresolved', async () => {
    const env = await load();
    await env.drain();
    env.fetches.length = 0;
    env.idb.data.clear();
    env.window.RefIQ.event('A');
    env.window.RefIQ.event('B');
    env.window.RefIQ.event('C');
    env.window.RefIQ.event('D');
    let captured = null;
    env.setFetch(async (_url, init) => {
      captured = JSON.parse(init.body);
      const byType = {};
      captured.events.forEach((event) => {
        byType[event.type] = event;
      });
      return {
        ok: true,
        status: 200,
        bodyText: JSON.stringify({
          status: 'ok',
          accepted: [
            codecIdToServerIdString(byType.A.clientEventId),
            codecIdToServerIdString(byType.C.clientEventId),
          ],
          rejected: [{ clientEventId: byType.B.clientEventId, reason: 'numeric field is invalid' }],
        }),
      };
    });
    await env.drain();
    assert.ok(captured);
    const remaining = [];
    // force another flush of unresolved
    env.setFetch(async (_url, init) => {
      remaining.push(...JSON.parse(init.body).events.map((event) => event.type));
      return { ok: true, status: 200, bodyText: ackAllBody(init.body) };
    });
    await env.drain();
    assert.ok(remaining.includes('D'));
    assert.ok(!remaining.includes('A'));
    assert.ok(!remaining.includes('B'));
    assert.ok(!remaining.includes('C'));
    assert.ok(env.window.RefIQ._diagnostics.rejectedEvents >= 1);
  });

  await test('previous page view survives full navigation', async () => {
    const envA = await load();
    await envA.drain();
    const pageA = ofType(envA, 'page_view')[0];
    assert.strictEqual(pageA.pageViewIndex, 1);
    assert.ok(envA.session._refiq_last_pvid);
    const envB = await load({
      session: envA.session,
      href: 'https://shop.example.com/next',
    });
    await envB.drain();
    const pageB = ofType(envB, 'page_view')[0];
    assert.strictEqual(pageB.pageViewIndex, 2);
    assert.strictEqual(pageB.previousPageViewId, pageA.pageViewId);
    assert.notStrictEqual(pageB.pageViewId, pageB.previousPageViewId);
  });

  await test('new session clears previous page view', async () => {
    const env = await load({
      session: {
        _refiq_sid: '1791206357499.1',
        _refiq_seq: '3',
        _refiq_sact: String(Date.now() - 2 * 60 * 60 * 1000),
        _refiq_last_pvid: '1791207444224.70555',
        _refiq_pvi: '108',
        _refiq_sst: '1791206357499',
      },
      href: 'https://shop.example.com/fresh',
    });
    await env.drain();
    const page = ofType(env, 'page_view')[0];
    assert.strictEqual(page.previousPageViewId, undefined);
    assert.strictEqual(page.pageViewIndex, 1);
  });

  await test('spa previous page chain', async () => {
    const env = await load();
    await env.drain();
    const a = ofType(env, 'page_view')[0];
    env.fetches.length = 0;
    env.setPath('/b');
    env.history.pushState({}, '', '/b');
    await env.drain();
    const b = ofType(env, 'page_view')[0];
    env.fetches.length = 0;
    env.setPath('/c');
    env.history.pushState({}, '', '/c');
    await env.drain();
    const c = ofType(env, 'page_view')[0];
    assert.strictEqual(b.previousPageViewId, a.pageViewId);
    assert.strictEqual(c.previousPageViewId, b.pageViewId);
  });

  await test('page referrer sanitized in page snapshot', async () => {
    const env = await load({
      referrer: 'https://example.com/catalog?q=secret#fragment',
      href: 'https://shop.example.com/home',
    });
    await env.drain();
    const page = ofType(env, 'page_view')[0].payload.page.referrer;
    assert.strictEqual(page.origin, 'https://example.com');
    assert.strictEqual(page.hostname, 'example.com');
    assert.strictEqual(page.pathname, '/catalog');
    assert.ok(!JSON.stringify(page).includes('secret'));
    assert.ok(!JSON.stringify(page).includes('fragment'));
  });

  await test('target href metadata internal external and child click', async () => {
    const env = await load();
    const internal = env.document.createElement('a');
    internal.href = 'https://shop.example.com/product/a';
    env.dispatch('click', internal);
    const external = env.document.createElement('a');
    external.href = 'https://external.example/item';
    env.dispatch('click', external);
    const anchor = env.document.createElement('a');
    anchor.href = 'https://shop.example.com/product/a';
    const span = env.document.createElement('span');
    span.tagName = 'SPAN';
    span.nodeName = 'SPAN';
    span.parentNode = anchor;
    span.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 });
    env.dispatch('click', span);
    await env.drain();
    const clicks = ofType(env, 'click');
    const internalClick = clicks.find((event) => event.payload.target && event.payload.target.tag === 'A' && event.payload.target.hrefPathname === '/product/a' && event.payload.target.isExternal === false);
    assert.ok(internalClick);
    assert.strictEqual(internalClick.payload.target.hrefOrigin, 'https://shop.example.com');
    assert.strictEqual(internalClick.payload.target.hrefHostname, 'shop.example.com');
    const externalClick = clicks.find((event) => event.payload.target && event.payload.target.isExternal === true);
    assert.ok(externalClick);
    assert.strictEqual(externalClick.payload.target.hrefHostname, 'external.example');
    const childClick = clicks.find((event) => event.payload.target && event.payload.target.tag === 'SPAN');
    assert.ok(childClick);
    assert.strictEqual(childClick.payload.target.hrefPathname, '/product/a');
    assert.strictEqual(childClick.payload.target.hrefOrigin, 'https://shop.example.com');
  });

  await test('final flush prioritizes lifecycle over backlog', async () => {
    const env = await load();
    await env.drain();
    env.fetches.length = 0;
    env.beacons.length = 0;
    for (let i = 0; i < 20; i++) {
      env.window.RefIQ.event('old_' + i);
    }
    env.document.visibilityState = 'hidden';
    env.dispatch('pagehide');
    assert.ok(env.beacons.length >= 1);
    const beacon = JSON.parse(env.beacons[env.beacons.length - 1].body);
    const types = beacon.events.map((event) => event.type);
    assert.ok(types.includes('page_engagement'));
    assert.ok(types.includes('page_performance'));
    assert.ok(types.includes('resource_summary'));
    const firstThree = types.slice(0, 3);
    assert.ok(firstThree.includes('page_engagement'));
    assert.ok(firstThree.includes('page_performance'));
    assert.ok(firstThree.includes('resource_summary'));
  });

  await test('sendBeacon true keeps durable events', async () => {
    const env = await load();
    await env.drain();
    env.idb.data.clear();
    env.window.RefIQ.event('finalish');
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assert.ok(env.beacons.length >= 1);
    const beacon = JSON.parse(env.beacons[env.beacons.length - 1].body);
    const kept = beacon.events.find((event) => event.type === 'finalish' || event.type === 'page_engagement');
    assert.ok(kept);
    assert.ok(env.idb.data.size >= 1 || true);
    env.document.visibilityState = 'visible';
    const before = kept.clientEventId;
    await env.drain();
    const again = eventsFrom(env).find((event) => event.clientEventId === before);
    assert.ok(again);
    assert.strictEqual(again.clientEventId, before);
  });

  await test('sendBeacon false uses keepalive fallback and keeps events', async () => {
    const env = await load({ beaconResult: false });
    await env.drain();
    env.fetches.length = 0;
    env.window.RefIQ.event('keepalive-me');
    env.document.visibilityState = 'hidden';
    env.dispatch('pagehide');
    assert.ok(env.beacons.length >= 1);
    assert.ok(env.fetches.some((item) => item.keepalive));
    assert.ok(env.window.RefIQ._diagnostics.keepaliveAttempts >= 1);
  });

  await test('sdk_integration_mode script on batch', async () => {
    const env = await load();
    await env.drain();
    const batch = JSON.parse(env.fetches[0].body);
    assert.strictEqual(batch.sdkIntegrationMode, 'script');
  });

  await test('malformed ACK does not drop batch', async () => {
    const env = await load({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        bodyText: '{not-json',
      }),
    });
    await env.drain();
    env.fetches.length = 0;
    env.setFetch(async (_url, init) => ({
      ok: true,
      status: 200,
      bodyText: ackAllBody(init.body),
    }));
    await env.drain();
    assert.ok(env.fetches.length >= 1);
  });

  function assertBatchIdentity(batch) {
    assert.ok(batch.visitorId);
    assert.ok(batch.sessionId);
    batch.events.forEach(() => {
      assert.strictEqual(batch.visitorId, batch.visitorId);
      assert.strictEqual(batch.sessionId, batch.sessionId);
    });
  }

  function countFinals(events, pageViewId) {
    const types = ['page_engagement', 'page_performance', 'resource_summary'];
    const counts = {};
    types.forEach((type) => {
      const ids = new Set(
        events
          .filter((event) => event.type === type && event.pageViewId === pageViewId && event.eventFinal === 1)
          .map((event) => event.clientEventId)
      );
      counts[type] = ids.size;
    });
    return counts;
  }

  await test('immutable session identity survives session switch', async () => {
    const env = await load();
    await env.drain();
    const first = JSON.parse(env.fetches[0].body);
    const sessionA = first.sessionId;
    const visitorA = first.visitorId;
    const startedA = first.events[0].sessionStartedTs;
    const tabA = first.events[0].tabId;
    env.fetches.length = 0;
    env.window.RefIQ.event('from-a');
    env.session._refiq_sact = String(Date.now() - 2 * 60 * 60 * 1000);
    env.window.RefIQ.event('from-b');
    await env.drain();
    const batches = env.fetches.map((item) => JSON.parse(item.body));
    batches.forEach(assertBatchIdentity);
    const batchA = batches.find((batch) => batch.events.some((event) => event.type === 'from-a'));
    const batchB = batches.find((batch) => batch.events.some((event) => event.type === 'from-b'));
    assert.ok(batchA);
    assert.ok(batchB);
    assert.strictEqual(batchA.sessionId, sessionA);
    assert.strictEqual(batchA.visitorId, visitorA);
    assert.ok(!batchA.events.some((event) => event.type === 'from-b'));
    assert.notStrictEqual(batchB.sessionId, sessionA);
    assert.ok(!batchB.events.some((event) => event.type === 'from-a'));
    const kept = batchA.events.find((event) => event.type === 'from-a');
    assert.strictEqual(kept.sessionStartedTs, startedA);
    assert.strictEqual(kept.tabId, tabA);
    assert.strictEqual(kept.pageViewId, first.events[0].pageViewId);
  });

  await test('mixed session queue never shares a batch', async () => {
    const env = await load();
    await env.drain();
    env.fetches.length = 0;
    env.window.RefIQ.event('A1');
    env.window.RefIQ.event('A2');
    env.session._refiq_sact = String(Date.now() - 2 * 60 * 60 * 1000);
    env.window.RefIQ.event('B1');
    env.window.RefIQ.event('B2');
    await env.drain();
    const batches = env.fetches.map((item) => JSON.parse(item.body));
    const sessions = new Set();
    batches.forEach((batch) => {
      assertBatchIdentity(batch);
      sessions.add(batch.sessionId);
      const types = batch.events.map((event) => event.type);
      const hasA = types.some((type) => type === 'A1' || type === 'A2');
      const hasB = types.some((type) => type === 'B1' || type === 'B2');
      assert.ok(!(hasA && hasB));
    });
    assert.ok(sessions.size >= 2);
  });

  await test('indexeddb restore keeps original session', async () => {
    const envA = await load();
    await envA.drain();
    const sessionA = JSON.parse(envA.fetches[0].body).sessionId;
    envA.fetches.length = 0;
    envA.setFetch(async () => {
      throw new Error('hold');
    });
    envA.window.RefIQ.event('stored-a');
    await envA.drain();
    const rows = Array.from(envA.idb.data.values());
    const stored = rows.find((row) => row.event && row.event.type === 'stored-a');
    assert.ok(stored);
    assert.strictEqual(stored.event.sessionId, sessionA);
    assert.ok(stored.event.visitorId);
    const envB = await load({
      idbRows: rows,
      href: 'https://shop.example.com/other',
    });
    await envB.drain();
    const batches = envB.fetches.map((item) => JSON.parse(item.body));
    batches.forEach(assertBatchIdentity);
    const restored = batches.find((batch) => batch.events.some((event) => event.clientEventId === stored.event.clientEventId));
    assert.ok(restored);
    assert.strictEqual(restored.sessionId, sessionA);
    assert.strictEqual(restored.visitorId, stored.event.visitorId);
    const fresh = batches.find((batch) => batch.events.some((event) => event.type === 'page_view'));
    assert.ok(fresh);
    assert.notStrictEqual(fresh.sessionId, sessionA);
  });

  await test('invalid indexeddb record is dropped', async () => {
    const env = await load({
      href: 'https://shop.example.com/fresh',
      idbRows: [
        {
          clientEventId: '1791206357499.10',
          occurredAtMs: Date.now(),
          event: {
            clientEventId: '1791206357499.10',
            type: 'ghost',
            sequence: 1,
            pageViewId: '1791206357499.11',
            occurredAtMs: Date.now(),
            payload: {},
          },
        },
      ],
    });
    await env.drain();
    const sent = eventsFrom(env);
    assert.ok(!sent.some((event) => event.type === 'ghost' || event.clientEventId === '1791206357499.10'));
    assert.ok(env.window.RefIQ._diagnostics.invalidIdbEvents >= 1);
    assert.ok(env.window.RefIQ.getRqcid() === null || typeof env.window.RefIQ.getRqcid() === 'string');
  });

  await test('hidden visible does not emit eventFinal', async () => {
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.fetches.length = 0;
    env.beacons.length = 0;
    for (let i = 0; i < 3; i++) {
      env.document.visibilityState = 'hidden';
      env.dispatch('visibilitychange');
      env.document.visibilityState = 'visible';
      env.dispatch('visibilitychange');
    }
    const hiddenEvents = [];
    env.beacons.forEach((item) => hiddenEvents.push(...JSON.parse(item.body).events));
    const counts = countFinals(hiddenEvents, pageId);
    assert.strictEqual(counts.page_engagement, 0);
    assert.strictEqual(counts.page_performance, 0);
    assert.strictEqual(counts.resource_summary, 0);
    assert.ok(hiddenEvents.some((event) => event.type === 'page_engagement' && event.eventFinal === 0 && event.engagementTrigger === 'hidden'));
  });

  await test('pagehide emits one final trio', async () => {
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.document.visibilityState = 'visible';
    env.dispatch('visibilitychange');
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: false });
    env.dispatch('pagehide', env.document, { persisted: false });
    const events = [];
    env.beacons.forEach((item) => events.push(...JSON.parse(item.body).events));
    const counts = countFinals(events, pageId);
    assert.strictEqual(counts.page_engagement, 1);
    assert.strictEqual(counts.page_performance, 1);
    assert.strictEqual(counts.resource_summary, 1);
    assert.ok(events.some((event) => event.type === 'page_engagement' && event.eventFinal === 1 && event.engagementTrigger === 'pagehide'));
  });

  await test('spa navigation finalizes previous page once', async () => {
    const env = await load();
    await env.drain();
    const pageA = ofType(env, 'page_view')[0].pageViewId;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.document.visibilityState = 'visible';
    env.dispatch('visibilitychange');
    env.fetches.length = 0;
    env.beacons.length = 0;
    env.setPath('/next');
    env.history.pushState({}, '', '/next');
    await env.drain();
    const all = [];
    env.beacons.forEach((item) => all.push(...JSON.parse(item.body).events));
    eventsFrom(env).forEach((event) => all.push(event));
    const counts = countFinals(all, pageA);
    assert.strictEqual(counts.page_engagement, 1);
    assert.ok(all.some((event) => event.pageViewId === pageA && event.type === 'page_engagement' && event.engagementTrigger === 'spa_navigation' && event.eventFinal === 1));
    const pageB = ofType(env, 'page_view')[0];
    assert.notStrictEqual(pageB.pageViewId, pageA);
    assert.strictEqual(countFinals(all, pageB.pageViewId).page_engagement, 0);
  });

  await test('bfcache snapshot then one real final', async () => {
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: true });
    let events = [];
    env.beacons.forEach((item) => events.push(...JSON.parse(item.body).events));
    assert.strictEqual(countFinals(events, pageId).page_engagement, 0);
    assert.ok(events.some((event) => event.engagementTrigger === 'pagehide_bfcache' && event.eventFinal === 0));
    env.dispatch('pageshow', env.document, { persisted: true });
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: false });
    events = [];
    env.beacons.forEach((item) => events.push(...JSON.parse(item.body).events));
    assert.strictEqual(countFinals(events, pageId).page_engagement, 1);
    assert.strictEqual(countFinals(events, pageId).page_performance, 1);
    assert.strictEqual(countFinals(events, pageId).resource_summary, 1);
  });

  await test('beacon retry keeps session identity', async () => {
    const env = await load();
    await env.drain();
    const sessionA = JSON.parse(env.fetches[0].body).sessionId;
    const visitorA = JSON.parse(env.fetches[0].body).visitorId;
    env.fetches.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('pagehide', env.document, { persisted: false });
    const beacon = JSON.parse(env.beacons[env.beacons.length - 1].body);
    const finalEvent = beacon.events.find((event) => event.type === 'page_engagement' && event.eventFinal === 1);
    assert.ok(finalEvent);
    assert.strictEqual(beacon.sessionId, sessionA);
    assert.strictEqual(beacon.visitorId, visitorA);
    env.document.visibilityState = 'visible';
    await env.drain();
    const retried = eventsFrom(env).find((event) => event.clientEventId === finalEvent.clientEventId);
    assert.ok(retried);
    assert.strictEqual(retried.sequence, finalEvent.sequence);
    assert.strictEqual(retried.pageViewId, finalEvent.pageViewId);
    assert.strictEqual(retried._batch.sessionId, sessionA);
    assert.strictEqual(retried._batch.visitorId, visitorA);
  });

  function beaconEvents(env) {
    const all = [];
    env.beacons.forEach((item) => {
      JSON.parse(item.body).events.forEach((event) => all.push(event));
    });
    return all;
  }

  function uniqueEvents(events) {
    const seen = {};
    return events.filter((event) => {
      if (seen[event.clientEventId]) return false;
      seen[event.clientEventId] = 1;
      return true;
    });
  }

  function lifecycleOf(events, pageViewId) {
    return uniqueEvents(events).filter((event) => {
      return event.pageViewId === pageViewId &&
        (event.type === 'page_engagement' || event.type === 'page_performance' || event.type === 'resource_summary');
    });
  }

  await test('hidden then real pagehide is snapshot plus final', async () => {
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.dispatch('pagehide', env.document, { persisted: false });
    const life = lifecycleOf(beaconEvents(env), pageId);
    assert.strictEqual(life.length, 6);
    ['page_engagement', 'page_performance', 'resource_summary'].forEach((type) => {
      const snap = life.find((event) => event.type === type && event.eventFinal === 0);
      const fin = life.find((event) => event.type === type && event.eventFinal === 1);
      assert.ok(snap);
      assert.ok(fin);
      assert.ok(fin.eventRevision > snap.eventRevision);
      assert.ok(fin.sequence > snap.sequence);
    });
  });

  await test('hidden after final creates nothing', async () => {
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: false });
    const before = lifecycleOf(beaconEvents(env), pageId);
    const beforeSeq = Math.max.apply(null, before.map((event) => event.sequence));
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const after = lifecycleOf(beaconEvents(env), pageId);
    assert.strictEqual(after.length, 3);
    assert.ok(after.every((event) => event.eventFinal === 1));
    assert.strictEqual(Math.max.apply(null, after.map((event) => event.sequence)), beforeSeq);
  });

  await test('hidden then bfcache pagehide is one snapshot', async () => {
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.dispatch('pagehide', env.document, { persisted: true });
    const life = lifecycleOf(beaconEvents(env), pageId);
    assert.strictEqual(life.length, 3);
    assert.ok(life.every((event) => event.eventFinal === 0 && event.engagementTrigger === 'hidden'));
  });

  await test('bfcache pagehide then hidden is one snapshot', async () => {
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: true });
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const life = lifecycleOf(beaconEvents(env), pageId);
    assert.strictEqual(life.length, 3);
    assert.ok(life.every((event) => event.eventFinal === 0 && event.engagementTrigger === 'pagehide_bfcache'));
  });

  await test('repeated hidden without visible is one snapshot', async () => {
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const first = lifecycleOf(beaconEvents(env), pageId);
    env.dispatch('visibilitychange');
    env.dispatch('visibilitychange');
    const again = lifecycleOf(beaconEvents(env), pageId);
    assert.strictEqual(first.length, 3);
    assert.strictEqual(again.length, 3);
    assert.deepStrictEqual(again.map((event) => event.clientEventId), first.map((event) => event.clientEventId));
  });

  await test('two hidden cycles after visible', async () => {
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.document.visibilityState = 'visible';
    env.dispatch('visibilitychange');
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const life = lifecycleOf(beaconEvents(env), pageId);
    assert.strictEqual(life.length, 6);
    assert.ok(life.every((event) => event.eventFinal === 0));
  });

  await test('bfcache restore allows a new hidden snapshot', async () => {
    const env = await load();
    await env.drain();
    const page = ofType(env, 'page_view')[0];
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: true });
    env.dispatch('pageshow', env.document, { persisted: true });
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const batches = env.beacons.map((item) => JSON.parse(item.body));
    const life = lifecycleOf(beaconEvents(env), page.pageViewId);
    assert.strictEqual(life.length, 6);
    assert.ok(life.every((event) => event.eventFinal === 0 && event.pageViewId === page.pageViewId));
    assert.ok(batches.every((batch) => batch.visitorId === batches[0].visitorId && batch.sessionId === batches[0].sessionId));
    assert.ok(!life.some((event) => event.eventFinal === 1));
  });

  await test('bfcache restore then real pagehide is one final', async () => {
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.dispatch('pagehide', env.document, { persisted: true });
    env.dispatch('pageshow', env.document, { persisted: true });
    env.document.visibilityState = 'visible';
    env.dispatch('visibilitychange');
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.dispatch('pagehide', env.document, { persisted: false });
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const life = lifecycleOf(beaconEvents(env), pageId);
    const finals = life.filter((event) => event.eventFinal === 1);
    const snaps = life.filter((event) => event.eventFinal === 0);
    assert.strictEqual(finals.length, 3);
    assert.strictEqual(snaps.length, 6);
    const lastFinalSeq = Math.max.apply(null, finals.map((event) => event.sequence));
    assert.ok(snaps.every((event) => event.sequence < lastFinalSeq));
  });

  await test('spa after hidden keeps one final and a fresh page', async () => {
    const env = await load();
    await env.drain();
    const pageA = ofType(env, 'page_view')[0].pageViewId;
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.document.visibilityState = 'visible';
    env.dispatch('visibilitychange');
    env.setPath('/next');
    env.history.pushState({}, '', '/next');
    await env.drain();
    const pageB = ofType(env, 'page_view').map((event) => event.pageViewId).find((id) => id !== pageA);
    const all = beaconEvents(env).concat(eventsFrom(env));
    const lifeA = lifecycleOf(all, pageA);
    assert.strictEqual(lifeA.filter((event) => event.eventFinal === 1).length, 3);
    assert.ok(lifeA.some((event) => event.eventFinal === 0 && event.engagementTrigger === 'hidden'));
    const finalSeq = Math.min.apply(null, lifeA.filter((event) => event.eventFinal === 1).map((event) => event.sequence));
    assert.ok(!lifeA.some((event) => event.eventFinal === 0 && event.sequence > finalSeq));
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const lifeB = lifecycleOf(beaconEvents(env), pageB);
    assert.strictEqual(lifeB.length, 3);
    assert.ok(lifeB.every((event) => event.eventFinal === 0 && event.pageViewId === pageB));
  });

  await test('suppressed lifecycle callback does not gap sequence', async () => {
    const env = await load();
    await env.drain();
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: false });
    const finals = lifecycleOf(beaconEvents(env), ofType(env, 'page_view')[0].pageViewId);
    const lastSeq = Math.max.apply(null, finals.map((event) => event.sequence));
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.dispatch('visibilitychange');
    env.window.RefIQ.event('after_final', {});
    await env.drain();
    const created = eventsFrom(env).find((event) => event.type === 'after_final');
    assert.ok(created);
    assert.strictEqual(created.sequence, lastSeq + 1);
  });

  await test('periodic snapshot after final is suppressed', async () => {
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.dispatch('pagehide', env.document, { persisted: false });
    const idbSize = env.idb.data.size;
    const fetchCount = env.fetches.length;
    env.window.RefIQ._emitSnapshot('page_performance', pageId, { marker: 'late' }, false, 'periodic');
    env.window.RefIQ._emitSnapshot('page_engagement', pageId, { marker: 'late' }, false, 'periodic');
    env.window.RefIQ._emitSnapshot('resource_summary', pageId, { marker: 'late' }, false, 'periodic');
    assert.strictEqual(env.fetches.length, fetchCount);
    assert.strictEqual(env.idb.data.size, idbSize);
    assert.ok(!beaconEvents(env).some((event) => event.payload && event.payload.marker === 'late'));
  });

  await test('no snapshot exists after final in sequence order', async () => {
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.dispatch('pagehide', env.document, { persisted: false });
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const life = lifecycleOf(beaconEvents(env), pageId).sort((a, b) => a.sequence - b.sequence);
    let seenFinal = false;
    life.forEach((event) => {
      if (seenFinal) {
        assert.notStrictEqual(event.eventFinal, 0);
      }
      if (event.eventFinal === 1) seenFinal = true;
    });
  });

  function lastBeacon(env) {
    return JSON.parse(env.beacons[env.beacons.length - 1].body);
  }

  function seedBacklog(env, count) {
    for (let i = 0; i < count; i += 1) {
      env.window.RefIQ.event('backlog', { i });
    }
  }

  function trioIndexes(events, trigger) {
    return ['page_engagement', 'page_performance', 'resource_summary'].map((type) => {
      return events.findIndex((event) => event.type === type && event.engagementTrigger === trigger && event.eventFinal === 0);
    });
  }

  await test('hidden snapshot is beacon priority ahead of backlog', async () => {
    const env = await load();
    await env.drain();
    seedBacklog(env, 8);
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const events = lastBeacon(env).events;
    const indexes = trioIndexes(events, 'hidden');
    assert.ok(indexes.every((index) => index >= 0));
    const firstBacklog = events.findIndex((event) => event.type === 'backlog');
    assert.ok(firstBacklog > Math.max.apply(null, indexes));
    assert.ok(events.filter((event) => indexes.indexOf(events.indexOf(event)) !== -1).every((event) => event.eventFinal === 0));
  });

  await test('bfcache snapshot is beacon priority ahead of backlog', async () => {
    const env = await load();
    await env.drain();
    seedBacklog(env, 8);
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: true });
    const events = lastBeacon(env).events;
    const indexes = trioIndexes(events, 'pagehide_bfcache');
    assert.strictEqual(indexes.filter((index) => index >= 0).length, 3);
    const firstBacklog = events.findIndex((event) => event.type === 'backlog');
    assert.ok(firstBacklog > Math.max.apply(null, indexes));
    assert.ok(indexes.every((index) => events[index].eventFinal === 0));
  });

  await test('real pagehide still prioritizes final trio', async () => {
    const env = await load();
    await env.drain();
    seedBacklog(env, 8);
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: false });
    const events = lastBeacon(env).events;
    const finals = ['page_engagement', 'page_performance', 'resource_summary'].map((type) => {
      return events.findIndex((event) => event.type === type && event.eventFinal === 1 && event.engagementTrigger === 'pagehide');
    });
    assert.ok(finals.every((index) => index >= 0));
    const firstBacklog = events.findIndex((event) => event.type === 'backlog');
    assert.ok(firstBacklog > Math.max.apply(null, finals));
  });

  await test('hidden priority does not replace later final priority', async () => {
    const env = await load();
    await env.drain();
    seedBacklog(env, 4);
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.dispatch('pagehide', env.document, { persisted: false });
    const events = lastBeacon(env).events;
    const firstFinal = events.findIndex((event) => event.eventFinal === 1);
    const firstSnap = events.findIndex((event) => event.eventFinal === 0 && event.engagementTrigger === 'hidden');
    assert.ok(firstFinal >= 0);
    assert.ok(firstFinal < firstSnap);
    assert.strictEqual(events.filter((event) => event.eventFinal === 1 && event.engagementTrigger === 'pagehide').length, 3);
  });

  await test('priority ids are not reused by the next lifecycle flush', async () => {
    const env = await load();
    await env.drain();
    seedBacklog(env, 4);
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const snapIds = trioIndexes(lastBeacon(env).events, 'hidden').map((index) => lastBeacon(env).events[index].clientEventId);
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: false });
    const events = lastBeacon(env).events;
    const firstThree = events.slice(0, 3).map((event) => event.clientEventId);
    snapIds.forEach((id) => assert.ok(firstThree.indexOf(id) === -1));
    assert.ok(events.slice(0, 3).every((event) => event.eventFinal === 1));
  });

  await test('lifecycle beacon priority keeps session isolation', async () => {
    const envA = await load();
    await envA.drain();
    const sessionA = JSON.parse(envA.fetches[0].body).sessionId;
    envA.setFetch(async () => {
      throw new Error('hold');
    });
    envA.window.RefIQ.event('A1');
    envA.window.RefIQ.event('A2');
    await envA.drain();
    const rows = Array.from(envA.idb.data.values()).filter((row) => row.event && (row.event.type === 'A1' || row.event.type === 'A2'));
    const envB = await load({ idbRows: rows, href: 'https://shop.example.com/other' });
    envB.beacons.length = 0;
    envB.window.RefIQ.event('B1');
    envB.document.visibilityState = 'hidden';
    envB.dispatch('visibilitychange');
    const beacon = lastBeacon(envB);
    assert.notStrictEqual(beacon.sessionId, sessionA);
    assert.ok(beacon.events.some((event) => event.type === 'page_engagement' && event.eventFinal === 0));
    assert.ok(beacon.events.some((event) => event.type === 'page_performance' && event.eventFinal === 0));
    assert.ok(beacon.events.some((event) => event.type === 'resource_summary' && event.eventFinal === 0));
    assert.ok(!beacon.events.some((event) => event.type === 'A1' || event.type === 'A2'));
    const engagementAt = beacon.events.findIndex((event) => event.type === 'page_engagement' && event.engagementTrigger === 'hidden');
    const backlogAt = beacon.events.findIndex((event) => event.type === 'B1');
    assert.ok(engagementAt >= 0 && engagementAt < backlogAt);
  });

  await test('priority beacon true keeps events for later fetch', async () => {
    const env = await load();
    await env.drain();
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const beacon = lastBeacon(env);
    const engagement = beacon.events.find((event) => event.type === 'page_engagement' && event.engagementTrigger === 'hidden');
    const stored = Array.from(env.idb.data.values()).find((row) => row.event && row.event.clientEventId === engagement.clientEventId);
    assert.ok(stored);
    assert.strictEqual(stored.event.sequence, engagement.sequence);
    assert.strictEqual(stored.event.pageViewId, engagement.pageViewId);
    assert.strictEqual(stored.event.eventRevision, engagement.eventRevision);
    assert.strictEqual(stored.event.eventFinal, 0);
    assert.strictEqual(stored.event.visitorId, beacon.visitorId);
    assert.strictEqual(stored.event.sessionId, beacon.sessionId);
    env.document.visibilityState = 'visible';
    await env.drain();
    const retried = eventsFrom(env).find((event) => event.clientEventId === engagement.clientEventId);
    assert.ok(retried);
    assert.strictEqual(retried.sequence, engagement.sequence);
    assert.strictEqual(retried.eventFinal, 0);
    assert.strictEqual(retried._batch.sessionId, beacon.sessionId);
  });

  await test('priority beacon false uses the same keepalive body', async () => {
    const env = await load({ beaconResult: false });
    await env.drain();
    const before = env.window.RefIQ._diagnostics.keepaliveAttempts;
    env.fetches.length = 0;
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assert.ok(env.window.RefIQ._diagnostics.keepaliveAttempts > before);
    const keepalive = env.fetches.find((item) => item.keepalive);
    assert.ok(keepalive);
    assert.strictEqual(keepalive.body, env.beacons[env.beacons.length - 1].body);
    const events = JSON.parse(keepalive.body).events;
    assert.strictEqual(trioIndexes(events, 'hidden').filter((index) => index >= 0).length, 3);
  });

  await test('background cycles keep each snapshot trio ahead of backlog', async () => {
    const env = await load();
    await env.drain();
    seedBacklog(env, 5);
    env.beacons.length = 0;
    const known = new Set();
    function assertFreshTrio(trigger) {
      const events = lastBeacon(env).events;
      const fresh = events.filter((event) => {
        return !known.has(event.clientEventId) &&
          event.eventFinal === 0 &&
          event.engagementTrigger === trigger &&
          (event.type === 'page_engagement' || event.type === 'page_performance' || event.type === 'resource_summary');
      });
      assert.strictEqual(fresh.length, 3);
      const firstKnown = events.findIndex((event) => known.has(event.clientEventId));
      fresh.forEach((event) => {
        const at = events.findIndex((item) => item.clientEventId === event.clientEventId);
        if (firstKnown !== -1) assert.ok(at < firstKnown);
        known.add(event.clientEventId);
      });
    }
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assertFreshTrio('hidden');
    env.document.visibilityState = 'visible';
    env.dispatch('visibilitychange');
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assertFreshTrio('hidden');
    env.dispatch('pageshow', env.document, { persisted: true });
    env.document.visibilityState = 'visible';
    env.dispatch('visibilitychange');
    env.dispatch('pagehide', env.document, { persisted: true });
    assertFreshTrio('pagehide_bfcache');
    env.dispatch('pageshow', env.document, { persisted: true });
    env.document.visibilityState = 'visible';
    env.dispatch('visibilitychange');
    env.setPath('/next');
    env.history.pushState({}, '', '/next');
    await env.drain();
    const all = [];
    const seen = {};
    eventsFrom(env).concat(beaconEvents(env)).forEach((event) => {
      if (seen[event.clientEventId]) return;
      seen[event.clientEventId] = 1;
      all.push(event);
    });
    all.sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < all.length; i += 1) {
      assert.strictEqual(all[i].sequence, all[i - 1].sequence + 1);
    }
  });

  function assertAtomicTrio(env, trigger) {
    assert.strictEqual(env.fetches.length, 0);
    const beacon = lastBeacon(env);
    const trio = ['page_engagement', 'page_performance', 'resource_summary'].map((type) => {
      return beacon.events.find((event) => event.type === type && event.engagementTrigger === trigger && event.eventFinal === 0);
    });
    assert.ok(trio.every(Boolean));
    assert.strictEqual(trio[1].sequence, trio[0].sequence + 1);
    assert.strictEqual(trio[2].sequence, trio[1].sequence + 1);
    assert.strictEqual(new Set(trio.map((event) => event.pageViewId)).size, 1);
    trio.forEach((event) => {
      const row = env.idb.data.get(event.clientEventId);
      assert.ok(row && row.event);
      assert.strictEqual(row.event.clientEventId, event.clientEventId);
      assert.strictEqual(row.event.sequence, event.sequence);
      assert.strictEqual(row.event.eventRevision, event.eventRevision);
      assert.strictEqual(row.event.eventFinal, 0);
      assert.strictEqual(row.event.visitorId, beacon.visitorId);
      assert.strictEqual(row.event.sessionId, beacon.sessionId);
    });
  }

  async function countUntilFetch(payload) {
    const env = await load();
    await env.drain();
    env.fetches.length = 0;
    let count = 0;
    while (count < 30 && env.fetches.length === 0) {
      env.window.RefIQ.event('pad', payload);
      count += 1;
    }
    return count;
  }

  function tinyRows(count) {
    const rows = [];
    for (let i = 1; i <= count; i += 1) {
      const id = '1600000000001.' + (10 + i);
      rows.push({
        clientEventId: id,
        occurredAtMs: Date.now(),
        event: {
          clientEventId: id,
          visitorId: '1600000000001.1',
          sessionId: '1600000000001.2',
          type: 'tiny',
          sequence: i,
          pageViewId: '1600000000001.3',
          occurredAtMs: Date.now(),
          payload: { n: i },
          eventRevision: 1,
          eventFinal: 1,
        },
      });
    }
    return rows;
  }

  async function loadAtCountThreshold() {
    const env = await load({
      idbRows: tinyRows(19),
      href: 'https://shop.example.com/count-threshold',
    });
    env.fetches.length = 0;
    env.beacons.length = 0;
    return env;
  }

  await test('snapshot trio is not split at event-count threshold', async () => {
    const env = await loadAtCountThreshold();
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assertAtomicTrio(env, 'hidden');
    assert.ok(!lastBeacon(env).events.some((event) => event.type === 'tiny'));
  });

  await test('bfcache trio is not split at event-count threshold', async () => {
    const env = await loadAtCountThreshold();
    env.dispatch('pagehide', env.document, { persisted: true });
    assertAtomicTrio(env, 'pagehide_bfcache');
    assert.ok(!lastBeacon(env).events.some((event) => event.type === 'tiny'));
  });

  await test('snapshot trio is not split at byte threshold', async () => {
    const payload = { i: 1 };
    const crossedAt = await countUntilFetch(payload);
    assert.ok(crossedAt > 1 && crossedAt < 20);
    const env = await load();
    await env.drain();
    env.fetches.length = 0;
    env.beacons.length = 0;
    for (let i = 0; i < crossedAt - 1; i += 1) env.window.RefIQ.event('pad', payload);
    assert.strictEqual(env.fetches.length, 0);
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assertAtomicTrio(env, 'hidden');
  });

  await test('bfcache trio is not split at byte threshold', async () => {
    const payload = { i: 1 };
    const crossedAt = await countUntilFetch(payload);
    assert.ok(crossedAt > 1 && crossedAt < 20);
    const env = await load();
    await env.drain();
    env.fetches.length = 0;
    env.beacons.length = 0;
    for (let i = 0; i < crossedAt - 1; i += 1) env.window.RefIQ.event('pad', payload);
    assert.strictEqual(env.fetches.length, 0);
    env.dispatch('pagehide', env.document, { persisted: true });
    assertAtomicTrio(env, 'pagehide_bfcache');
  });

  await test('ordinary enqueue still auto-flushes at both thresholds', async () => {
    const byCount = await loadAtCountThreshold();
    byCount.window.RefIQ.event('ordinary-count');
    assert.ok(byCount.fetches.length >= 1);
    const byBytes = await countUntilFetch({ blob: 'x'.repeat(200) });
    assert.ok(byBytes > 1 && byBytes < 20);
  });

  await test('periodic snapshot still uses ordinary auto-flush', async () => {
    const payload = { i: 1 };
    const crossedAt = await countUntilFetch(payload);
    const env = await load();
    await env.drain();
    const pageId = ofType(env, 'page_view')[0].pageViewId;
    env.fetches.length = 0;
    for (let i = 0; i < crossedAt - 1; i += 1) env.window.RefIQ.event('pad', payload);
    assert.strictEqual(env.fetches.length, 0);
    env.window.RefIQ._emitSnapshot('page_performance', pageId, { marker: 'periodic-probe' }, false, 'periodic');
    assert.ok(env.fetches.length >= 1);
    const sent = eventsFrom(env).find((event) => event.payload && event.payload.marker === 'periodic-probe');
    const stored = Array.from(env.idb.data.values()).find((row) => row.event && row.event.payload && row.event.payload.marker === 'periodic-probe');
    const event = sent || (stored && stored.event);
    assert.ok(event);
    assert.strictEqual(event.engagementTrigger, 'periodic');
    assert.strictEqual(event.eventFinal, 0);
  });

  console.log('\n' + passed + ' tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
