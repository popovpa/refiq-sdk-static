'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'sdk.js'), 'utf8');

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
      status: 204,
      headers: { get() { return null; } },
    }));

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
    PerformanceObserver: function () {
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
      fetches.push({ url, body: init && init.body });
      return Promise.resolve(fetchImpl(url, init));
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
    return true;
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
    let guard = 0;
    while (guard++ < 50) {
      const due = timers.filter((item) => item.ms <= (maxMs == null ? 1e9 : maxMs)).sort((a, b) => a.ms - b.ms);
      if (!due.length) break;
      due.forEach((item) => {
        const idx = timers.indexOf(item);
        if (idx !== -1) timers.splice(idx, 1);
        item.fn();
      });
      await Promise.resolve();
      await Promise.resolve();
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
      sequence: 9,
      pageViewId: 'pageaaaaaaaaaaaa',
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

  await test('consent denied stops analytics', async () => {
    const env = await load();
    env.window.RefIQ.consent({ analytics: 'denied' });
    env.fetches.length = 0;
    env.window.RefIQ.event('should-not-send');
    await env.drain();
    assert.ok(!eventsFrom(env).some((event) => event.type === 'should-not-send'));
    assert.strictEqual(env.window.RefIQ.getRqcid(), 'abcdefghijkl');
  });

  console.log('\n' + passed + ' tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
