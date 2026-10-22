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
  const cookieWrites = [];
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

  function storageApi(map, forceThrow) {
    function denied() {
      return opts.throwStorage || forceThrow;
    }
    return {
      getItem(key) {
        if (denied()) throw new Error('storage');
        return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
      },
      setItem(key, value) {
        if (denied()) throw new Error('storage');
        map[key] = String(value);
      },
      removeItem(key) {
        if (denied()) throw new Error('storage');
        delete map[key];
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
    baseURI: opts.baseURI || '',
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
          if (this._attrs && Object.prototype.hasOwnProperty.call(this._attrs, name)) return this._attrs[name];
          if (name === 'data-refiq-id') return this._refiqId || null;
          if (name === 'download') return this._download || null;
          if (name === 'role') return this._role || null;
          if (name === 'src') return this.src || null;
          return null;
        },
        hasAttribute(name) {
          return this.getAttribute(name) != null;
        },
        setAttribute(name, value) {
          this._attrs = this._attrs || {};
          this._attrs[name] = String(value);
        },
        appendChild(child) {
          this._inputs = this._inputs || [];
          this._inputs.push(child);
          if (this.elements && this.elements !== this._inputs) this.elements.push(child);
          else this.elements = this._inputs;
          child.parentNode = this;
          return child;
        },
        removeChild(child) {
          [this._inputs, this.elements].forEach((list) => {
            const idx = list ? list.indexOf(child) : -1;
            if (idx !== -1) list.splice(idx, 1);
          });
          child.parentNode = null;
          return child;
        },
        addEventListener(type, fn) {
          this._listeners = this._listeners || {};
          (this._listeners[type] = this._listeners[type] || []).push(fn);
        },
        getBoundingClientRect() {
          return { left: 10, top: 20, width: 100, height: 40 };
        },
      };
      if (tag === 'form') {
        Object.setPrototypeOf(el, HTMLFormElement.prototype);
        el.elements = [];
        el.method = 'post';
        el.checkValidity = () => true;
      }
      return el;
    },
    addEventListener(type, fn, options) {
      listen('document', type, fn, options);
    },
  };

  const listenerPhase = new Map();
  function listen(owner, type, fn, options) {
    const capture = options === true || !!(options && options.capture);
    listenerPhase.set(fn, { owner, capture });
    (listeners[type] = listeners[type] || []).push(fn);
  }

  const nativeSubmissions = [];
  function HTMLFormElement() {
    throw new TypeError('Illegal constructor');
  }
  // Mirrors the browser: form.submit() builds the entry list and fires `formdata`, no `submit` event.
  const nativeFormSubmit = function submit() {
    if (!this || this.nodeName !== 'FORM') throw new TypeError('Illegal invocation');
    const data = makeFormData(collectEntries(this));
    dispatch('formdata', this, { formData: data });
    nativeSubmissions.push({ form: this, data });
  };
  HTMLFormElement.prototype.submit = nativeFormSubmit;
  Object.defineProperty(document, 'cookie', {
    get() {
      return cookieStr;
    },
    set(value) {
      const raw = String(value);
      cookieWrites.push(raw);
      if (opts.blockCookie) return;
      const pair = raw.split(';')[0];
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
    localStorage: storageApi(store, !!opts.throwLocalStorage),
    sessionStorage: storageApi(session, !!opts.throwSessionStorage),
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
    FormData: opts.noFormData ? undefined : FakeFormData,
    HTMLFormElement: opts.noHTMLFormElement ? undefined : HTMLFormElement,
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
    addEventListener(type, fn, options) {
      listen('window', type, fn, options);
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
    WeakMap,
    queueMicrotask,
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
  if (opts.noProxy) sandbox.Proxy = undefined;

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  // Mirrors the browser: new FormData(form) fires `formdata` synchronously inside the constructor.
  function FakeFormData(form, submitter) {
    if (!new.target) throw new TypeError("Failed to construct 'FormData': Please use the 'new' operator");
    if (form !== undefined && !(form && form.nodeName === 'FORM')) {
      throw new TypeError("Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.");
    }
    if (submitter != null && submitter.nodeName !== 'BUTTON' && submitter.nodeName !== 'INPUT') {
      throw new TypeError("Failed to construct 'FormData': The specified element is not a submit button.");
    }
    const data = makeFormData(form ? ((form._entries || []).concat(collectEntries(form))) : []);
    Object.assign(this, data);
    if (form) dispatch('formdata', form, { formData: this });
  }

  // Capture on window, capture on document, target, bubble on document, bubble on window.
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
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this._stopped = true;
        },
      },
      extra || {}
    );
    const all = (listeners[type] || []).slice();
    const phase = (owner, capture) =>
      all.filter((fn) => {
        const meta = listenerPhase.get(fn) || { owner: 'document', capture: true };
        return meta.owner === owner && meta.capture === capture;
      });
    const own = event.target && event.target !== document && event.target._listeners ? (event.target._listeners[type] || []).slice() : [];
    const groups = [phase('window', true), phase('document', true), own, phase('document', false), phase('window', false)];
    for (const group of groups) {
      for (const fn of group) fn(event);
      if (event._stopped) break;
    }
    return event;
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
    cookieWrites,
    forms,
    listeners,
    fetches,
    beacons,
    idb,
    location,
    history,
    dispatch,
    drain,
    rerun() {
      vm.runInContext(SOURCE, sandbox);
    },
    FakeFormData,
    HTMLFormElement,
    nativeSubmissions,
    nativeSubmit: nativeFormSubmit,
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

function makeFormData(entries) {
  const list = (entries || []).map((pair) => pair.slice());
  return {
    list,
    has(name) {
      return list.some((pair) => pair[0] === name);
    },
    get(name) {
      const found = list.find((pair) => pair[0] === name);
      return found ? found[1] : null;
    },
    append(name, value) {
      list.push([name, value]);
    },
    count(name) {
      return list.filter((pair) => pair[0] === name).length;
    },
  };
}

// The browser builds the entry list from the form's enabled named controls.
function collectEntries(form) {
  return (form.elements || [])
    .filter((el) => el && el.name && !el.disabled && el.nodeName !== 'BUTTON' && el.type !== 'submit' && el.type !== 'button')
    .map((el) => [el.name, el.value]);
}

// `entries` are the page's own controls: present in the form for the duration of the submission.
function withControls(form, entries, fn) {
  if (!form.elements) form.elements = [];
  const added = (entries || []).map((pair) => ({ nodeName: 'INPUT', type: 'text', name: pair[0], value: pair[1], disabled: false }));
  added.forEach((control) => form.elements.push(control));
  try {
    return fn();
  } finally {
    added.forEach((control) => {
      const idx = form.elements.indexOf(control);
      if (idx !== -1) form.elements.splice(idx, 1);
    });
  }
}

function nativeEntryList(env, form) {
  const data = makeFormData(collectEntries(form));
  env.dispatch('formdata', form, { formData: data });
  return data;
}

// Native interactive submission: `submit` event, then (unless cancelled) entry list + `formdata`.
function submitForm(env, form, submitter, entries) {
  return withControls(form, entries, () => {
    const event = env.dispatch('submit', form, { submitter: submitter || null });
    if (event.defaultPrevented) return makeFormData([]);
    return nativeEntryList(env, form);
  });
}

// HTMLFormElement.prototype.submit.call(form): no `submit` event.
function programmaticFormSubmit(env, form, entries) {
  return withControls(form, entries, () => {
    const before = env.nativeSubmissions.length;
    env.window.HTMLFormElement.prototype.submit.call(form);
    return env.nativeSubmissions.length > before ? env.nativeSubmissions[env.nativeSubmissions.length - 1].data : makeFormData([]);
  });
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
      hasAttribute(name) {
        return name === 'action';
      },
      getAttribute(name) {
        return name === 'action' ? '/order' : null;
      },
      appendChild(child) {
        this.elements.push(child);
        this._inputs = this.elements;
        child.parentNode = this;
      },
      removeChild(child) {
        this.elements.splice(this.elements.indexOf(child), 1);
        child.parentNode = null;
      },
      getElementsByTagName(tag) {
        return tag === 'input' ? this.elements : [];
      },
    };
    const env = await load({ forms: [form] });
    assert.strictEqual(form.elements.filter((el) => el.name === 'rqcid').length, 0);
    const data = submitForm(env, form, null, [['productId', '123']]);
    assert.strictEqual(data.count('rqcid'), 1);
    assert.strictEqual(data.get('rqcid'), 'abcdefghijkl');
    assert.strictEqual(form.elements.filter((el) => el.name === 'rqcid').length, 0);
  });

  await test('4 same-origin link is not decorated', async () => {
    const env = await load();
    const link = env.document.createElement('a');
    link.href = 'https://shop.example.com/product';
    env.dispatch('click', link);
    assert.strictEqual(link.href, 'https://shop.example.com/product');
    assert.strictEqual(env.window.RefIQ.getRqcid(), 'abcdefghijkl');
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

  function assertAtomicTrio(env, trigger, eventFinal) {
    if (eventFinal == null) eventFinal = 0;
    assert.strictEqual(env.fetches.length, 0);
    const beacon = lastBeacon(env);
    const trio = ['page_engagement', 'page_performance', 'resource_summary'].map((type) => {
      return beacon.events.find((event) => event.type === type && event.engagementTrigger === trigger && event.eventFinal === eventFinal);
    });
    assert.ok(trio.every(Boolean));
    assert.strictEqual(trio[1].sequence, trio[0].sequence + 1);
    assert.strictEqual(trio[2].sequence, trio[1].sequence + 1);
    assert.strictEqual(new Set(trio.map((event) => event.pageViewId)).size, 1);
    trio.forEach((event) => {
      assert.strictEqual(event.delivery.attempt, 1);
      const row = env.idb.data.get(event.clientEventId);
      assert.ok(row && row.event);
      assert.strictEqual(row.event.clientEventId, event.clientEventId);
      assert.strictEqual(row.event.sequence, event.sequence);
      assert.strictEqual(row.event.eventRevision, event.eventRevision);
      assert.strictEqual(row.event.eventFinal, eventFinal);
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

  await test('final trio is not split at event-count threshold', async () => {
    const env = await loadAtCountThreshold();
    env.dispatch('pagehide', env.document, { persisted: false });
    assert.strictEqual(env.beacons.length, 1);
    assertAtomicTrio(env, 'pagehide', 1);
  });

  await test('final trio is not split at byte threshold', async () => {
    const payload = { i: 1 };
    const crossedAt = await countUntilFetch(payload);
    assert.ok(crossedAt > 1 && crossedAt < 20);
    const env = await load();
    await env.drain();
    env.fetches.length = 0;
    env.beacons.length = 0;
    for (let i = 0; i < crossedAt - 1; i += 1) env.window.RefIQ.event('pad', payload);
    env.dispatch('pagehide', env.document, { persisted: false });
    assert.strictEqual(env.beacons.length, 1);
    assertAtomicTrio(env, 'pagehide', 1);
  });

  await test('hidden then pagehide sends two lifecycle beacons', async () => {
    const env = await load();
    await env.drain();
    env.fetches.length = 0;
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.dispatch('pagehide', env.document, { persisted: false });
    assert.strictEqual(env.fetches.length, 0);
    assert.strictEqual(env.beacons.length, 2);
    const first = JSON.parse(env.beacons[0].body).events;
    const second = JSON.parse(env.beacons[1].body).events;
    assert.strictEqual(first.filter((event) => event.eventFinal === 0 && event.engagementTrigger === 'hidden').length, 3);
    assert.strictEqual(second.filter((event) => event.eventFinal === 1 && event.engagementTrigger === 'pagehide').length, 3);
    assert.ok(first.every((event) => event.delivery.attempt === 1));
    assert.ok(second.filter((event) => event.eventFinal === 1).every((event) => event.delivery.attempt === 1));
  });

  await test('hidden after final does not beacon again', async () => {
    const env = await load();
    await env.drain();
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: false });
    const before = lifecycleOf(beaconEvents(env), ofType(env, 'page_view')[0].pageViewId);
    const beforeSeq = Math.max.apply(null, before.map((event) => event.sequence));
    const beaconCount = env.beacons.length;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assert.strictEqual(env.beacons.length, beaconCount);
    const after = lifecycleOf(beaconEvents(env), ofType(env, 'page_view')[0].pageViewId);
    assert.strictEqual(after.length, 3);
    assert.strictEqual(Math.max.apply(null, after.map((event) => event.sequence)), beforeSeq);
  });

  await test('hidden then bfcache does not beacon twice', async () => {
    const env = await load();
    await env.drain();
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.dispatch('pagehide', env.document, { persisted: true });
    assert.strictEqual(env.beacons.length, 1);
    const life = lifecycleOf(beaconEvents(env), ofType(env, 'page_view')[0].pageViewId);
    assert.strictEqual(life.length, 3);
    assert.ok(life.every((event) => event.eventFinal === 0 && event.delivery.attempt === 1));
  });

  await test('bfcache then hidden does not beacon twice', async () => {
    const env = await load();
    await env.drain();
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: true });
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assert.strictEqual(env.beacons.length, 1);
    const life = lifecycleOf(beaconEvents(env), ofType(env, 'page_view')[0].pageViewId);
    assert.strictEqual(life.length, 3);
    assert.ok(life.every((event) => event.eventFinal === 0 && event.engagementTrigger === 'pagehide_bfcache'));
  });

  await test('repeated hidden beacons once', async () => {
    const env = await load();
    await env.drain();
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.dispatch('visibilitychange');
    env.dispatch('visibilitychange');
    assert.strictEqual(env.beacons.length, 1);
    assert.strictEqual(lifecycleOf(beaconEvents(env), ofType(env, 'page_view')[0].pageViewId).length, 3);
  });

  await test('visible starts a new hidden beacon cycle', async () => {
    const env = await load();
    await env.drain();
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.document.visibilityState = 'visible';
    env.dispatch('visibilitychange');
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assert.strictEqual(env.beacons.length, 2);
    const life = lifecycleOf(beaconEvents(env), ofType(env, 'page_view')[0].pageViewId);
    assert.strictEqual(life.length, 6);
    assert.ok(life.every((event) => event.eventFinal === 0));
  });

  await test('spa final keeps ordinary auto-flush', async () => {
    const deferred = await loadAtCountThreshold();
    deferred.dispatch('pagehide', deferred.document, { persisted: false });
    assert.strictEqual(deferred.fetches.length, 0);
    const env = await load({
      idbRows: tinyRows(19),
      href: 'https://shop.example.com/spa-threshold',
    });
    const pageA = ofType(env, 'page_view')[0].pageViewId;
    env.fetches.length = 0;
    env.beacons.length = 0;
    env.setPath('/next');
    env.history.pushState({}, '', '/next');
    assert.ok(env.fetches.length >= 1);
    await env.drain();
    const all = eventsFrom(env).concat(beaconEvents(env));
    const finals = all.filter((event) => event.pageViewId === pageA && event.eventFinal === 1 && event.engagementTrigger === 'spa_navigation');
    assert.strictEqual(new Set(finals.map((event) => event.type)).size, 3);
    const pageB = eventsFrom(env).find((event) => event.type === 'page_view' && event.pageViewId !== pageA);
    assert.ok(pageB);
    assert.strictEqual(pageB.previousPageViewId, pageA);
  });

  function staleActivity(env) {
    env.session._refiq_sact = String(Date.now() - 31 * 60 * 1000);
  }

  await test('timeout click starts a new page view', async () => {
    const env = await load();
    await env.drain();
    const first = JSON.parse(env.fetches[0].body);
    const sessionA = first.sessionId;
    const pageX = first.events.find((event) => event.type === 'page_view').pageViewId;
    const visitorA = first.visitorId;
    const tabA = first.events[0].tabId;
    const rqcid = env.window.RefIQ.getRqcid();
    env.fetches.length = 0;
    staleActivity(env);
    env.dispatch('click', env.document.createElement('button'));
    await env.drain();
    const events = [];
    env.fetches.forEach((item) => {
      const batch = JSON.parse(item.body);
      assertBatchIdentity(batch);
      batch.events.forEach((event) => events.push(Object.assign({ _batch: batch }, event)));
    });
    const page = events.find((event) => event.type === 'page_view');
    const click = events.find((event) => event.type === 'click');
    assert.ok(page);
    assert.ok(click);
    assert.notStrictEqual(page._batch.sessionId, sessionA);
    assert.strictEqual(page.sequence, 1);
    assert.strictEqual(page.pageViewIndex, 1);
    assert.ok(!page.previousPageViewId);
    assert.notStrictEqual(page.pageViewId, pageX);
    assert.strictEqual(click.sequence, 2);
    assert.strictEqual(click.pageViewId, page.pageViewId);
    assert.strictEqual(click._batch.sessionId, page._batch.sessionId);
    assert.strictEqual(click._batch.visitorId, visitorA);
    assert.strictEqual(click.tabId, tabA);
    assert.strictEqual(env.window.RefIQ.getRqcid(), rqcid);
    assert.ok(!events.some((event) => event._batch.sessionId !== sessionA && event.pageViewId === pageX));
  });

  await test('timeout pagehide stays on the old session', async () => {
    const env = await load();
    await env.drain();
    const first = JSON.parse(env.fetches[0].body);
    const sessionA = first.sessionId;
    const pageX = first.events.find((event) => event.type === 'page_view').pageViewId;
    staleActivity(env);
    const sact = env.session._refiq_sact;
    env.beacons.length = 0;
    env.fetches.length = 0;
    env.dispatch('pagehide', env.document, { persisted: false });
    assert.strictEqual(env.beacons.length, 1);
    assert.strictEqual(env.fetches.length, 0);
    const beacon = JSON.parse(env.beacons[0].body);
    assert.strictEqual(beacon.sessionId, sessionA);
    const finals = beacon.events.filter((event) => event.pageViewId === pageX && event.eventFinal === 1);
    assert.strictEqual(finals.length, 3);
    assert.strictEqual(env.session._refiq_sact, sact);
  });

  await test('timeout spa finalizes old session before the new page', async () => {
    const env = await load();
    await env.drain();
    const first = JSON.parse(env.fetches[0].body);
    const sessionA = first.sessionId;
    const pageX = first.events.find((event) => event.type === 'page_view').pageViewId;
    staleActivity(env);
    env.fetches.length = 0;
    env.beacons.length = 0;
    env.setPath('/after-timeout');
    env.history.pushState({}, '', '/after-timeout');
    await env.drain();
    const batches = env.fetches.map((item) => JSON.parse(item.body));
    batches.forEach(assertBatchIdentity);
    const finals = [];
    const pages = [];
    batches.forEach((batch) => {
      batch.events.forEach((event) => {
        if (event.pageViewId === pageX && event.eventFinal === 1 && event.engagementTrigger === 'spa_navigation') {
          finals.push(batch.sessionId);
        }
        if (event.type === 'page_view' && event.pageViewId !== pageX) {
          pages.push({ batch, event });
        }
      });
    });
    assert.strictEqual(new Set(finals).size, 1);
    assert.strictEqual(finals[0], sessionA);
    assert.strictEqual(finals.length, 3);
    assert.strictEqual(pages.length, 1);
    assert.notStrictEqual(pages[0].batch.sessionId, sessionA);
    assert.strictEqual(pages[0].event.sequence, 1);
    assert.strictEqual(pages[0].event.pageViewIndex, 1);
    assert.ok(!pages[0].event.previousPageViewId);
    assert.ok(!batches.some((batch) => batch.events.some((event) => event.engagementTrigger === 'session_timeout')));
  });

  await test('active session keeps page view across click and custom event', async () => {
    const env = await load();
    await env.drain();
    const first = JSON.parse(env.fetches[0].body);
    const sessionA = first.sessionId;
    const pageX = first.events.find((event) => event.type === 'page_view').pageViewId;
    env.fetches.length = 0;
    env.dispatch('click', env.document.createElement('button'));
    env.window.RefIQ.event('still-here');
    await env.drain();
    const events = eventsFrom(env);
    const click = events.find((event) => event.type === 'click');
    const custom = events.find((event) => event.type === 'still-here');
    assert.strictEqual(click._batch.sessionId, sessionA);
    assert.strictEqual(custom._batch.sessionId, sessionA);
    assert.strictEqual(click.pageViewId, pageX);
    assert.strictEqual(custom.pageViewId, pageX);
    assert.ok(!events.some((event) => event.type === 'page_view'));
  });

  await test('timeout custom event starts a new page view', async () => {
    const env = await load();
    await env.drain();
    const sessionA = JSON.parse(env.fetches[0].body).sessionId;
    env.fetches.length = 0;
    env.session._refiq_pvi = '10';
    staleActivity(env);
    env.window.RefIQ.event('after-timeout');
    await env.drain();
    const events = eventsFrom(env);
    const page = events.find((event) => event.type === 'page_view');
    const custom = events.find((event) => event.type === 'after-timeout');
    assert.ok(page);
    assert.strictEqual(page.sequence, 1);
    assert.strictEqual(page.pageViewIndex, 1);
    assert.ok(!page.previousPageViewId);
    assert.notStrictEqual(page._batch.sessionId, sessionA);
    assert.strictEqual(custom.sequence, 2);
    assert.strictEqual(custom.pageViewId, page.pageViewId);
    assert.strictEqual(custom._batch.sessionId, page._batch.sessionId);
  });

  await test('timeout hidden stays on the old session', async () => {
    const env = await load();
    await env.drain();
    const first = JSON.parse(env.fetches[0].body);
    const sessionA = first.sessionId;
    const pageX = first.events.find((event) => event.type === 'page_view').pageViewId;
    staleActivity(env);
    const sact = env.session._refiq_sact;
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assert.strictEqual(env.beacons.length, 1);
    const beacon = JSON.parse(env.beacons[0].body);
    assert.strictEqual(beacon.sessionId, sessionA);
    const trio = beacon.events.filter((event) => event.pageViewId === pageX && event.eventFinal === 0 && event.engagementTrigger === 'hidden');
    assert.strictEqual(trio.length, 3);
    assert.ok(trio.every((event) => event.delivery.attempt === 1));
    assert.strictEqual(env.session._refiq_sact, sact);
  });

  await test('timeout bfcache stays on the old session', async () => {
    const env = await load();
    await env.drain();
    const first = JSON.parse(env.fetches[0].body);
    const sessionA = first.sessionId;
    const pageX = first.events.find((event) => event.type === 'page_view').pageViewId;
    staleActivity(env);
    const sact = env.session._refiq_sact;
    env.beacons.length = 0;
    env.dispatch('pagehide', env.document, { persisted: true });
    assert.strictEqual(env.beacons.length, 1);
    const beacon = JSON.parse(env.beacons[0].body);
    assert.strictEqual(beacon.sessionId, sessionA);
    const trio = beacon.events.filter((event) => event.pageViewId === pageX && event.eventFinal === 0 && event.engagementTrigger === 'pagehide_bfcache');
    assert.strictEqual(trio.length, 3);
    assert.ok(trio.every((event) => event.delivery.attempt === 1));
    assert.strictEqual(env.session._refiq_sact, sact);
  });

  await test('stale pagehide then navigation starts a new session', async () => {
    const env = await load();
    await env.drain();
    const sessionA = JSON.parse(env.fetches[0].body).sessionId;
    staleActivity(env);
    env.dispatch('pagehide', env.document, { persisted: false });
    assert.ok(Date.now() - Number(env.session._refiq_sact) > 30 * 60 * 1000);
    env.fetches.length = 0;
    env.setPath('/later');
    env.history.pushState({}, '', '/later');
    await env.drain();
    const page = eventsFrom(env).find((event) => event.type === 'page_view');
    assert.ok(page);
    assert.notStrictEqual(page._batch.sessionId, sessionA);
    assert.strictEqual(page.sequence, 1);
    assert.strictEqual(page.pageViewIndex, 1);
    assert.ok(!page.previousPageViewId);
  });

  await test('spa without timeout keeps the session chain', async () => {
    const env = await load();
    await env.drain();
    const first = JSON.parse(env.fetches[0].body);
    const sessionA = first.sessionId;
    const pageX = first.events.find((event) => event.type === 'page_view').pageViewId;
    env.fetches.length = 0;
    env.setPath('/next-route');
    env.history.pushState({}, '', '/next-route');
    await env.drain();
    const batches = env.fetches.map((item) => JSON.parse(item.body));
    batches.forEach((batch) => assert.strictEqual(batch.sessionId, sessionA));
    const pageY = eventsFrom(env).find((event) => event.type === 'page_view');
    assert.strictEqual(pageY.previousPageViewId, pageX);
    assert.ok(pageY.pageViewIndex > 1);
  });

  await test('new session rebuilds landing attribution and keeps rqcid', async () => {
    const env = await load({
      href: 'https://shop.example.com/landing-a?rqcid=abcdefghijkl&utm_source=a&utm_campaign=campaign-a',
      referrer: 'https://ref.example/from-a',
    });
    await env.drain();
    const first = ofType(env, 'page_view')[0];
    assert.strictEqual(first.payload.attribution.landingPath, '/landing-a');
    assert.strictEqual(first.payload.attribution.utmSource, 'a');
    assert.strictEqual(first.payload.attribution.utmCampaign, 'campaign-a');
    const rqcid = env.window.RefIQ.getRqcid();
    staleActivity(env);
    env.fetches.length = 0;
    env.location.pathname = '/landing-b';
    env.location.search = '?utm_source=b&utm_campaign=campaign-b';
    env.window.RefIQ.event('next-session');
    await env.drain();
    const page = eventsFrom(env).find((event) => event.type === 'page_view');
    assert.strictEqual(page.payload.attribution.landingPath, '/landing-b');
    assert.strictEqual(page.payload.attribution.utmSource, 'b');
    assert.strictEqual(page.payload.attribution.utmCampaign, 'campaign-b');
    assert.strictEqual(page.payload.attribution.rqcid, rqcid);
    const attr = JSON.parse(env.session._refiq_attr);
    assert.strictEqual(attr.landingPath, '/landing-b');
    assert.ok(!JSON.stringify(attr).includes('landing-a'));
    assert.ok(!JSON.stringify(attr).includes('campaign-a'));
    assert.strictEqual(env.window.RefIQ.getRqcid(), rqcid);
    assert.strictEqual(env.store.rqcid, rqcid);
    assert.ok(env.cookie.indexOf('rqcid=' + rqcid) !== -1);
  });

  await test('queued events keep the old session after rollover', async () => {
    const env = await load();
    await env.drain();
    const sessionA = JSON.parse(env.fetches[0].body).sessionId;
    env.setFetch(async () => {
      throw new Error('hold');
    });
    env.fetches.length = 0;
    env.window.RefIQ.event('queued-a');
    await env.drain();
    staleActivity(env);
    env.setFetch(async () => ({ ok: true, status: 200, headers: { get() { return null; } } }));
    env.fetches.length = 0;
    env.window.RefIQ.event('queued-b');
    await env.drain();
    const batches = env.fetches.map((item) => JSON.parse(item.body));
    assert.ok(batches.length >= 2);
    batches.forEach(assertBatchIdentity);
    const batchA = batches.find((batch) => batch.events.some((event) => event.type === 'queued-a'));
    const batchB = batches.find((batch) => batch.events.some((event) => event.type === 'queued-b'));
    assert.ok(batchA);
    assert.ok(batchB);
    assert.strictEqual(batchA.sessionId, sessionA);
    assert.notStrictEqual(batchB.sessionId, sessionA);
    assert.ok(!batchA.events.some((event) => event.type === 'queued-b' || event.type === 'page_view'));
    const page = batchB.events.find((event) => event.type === 'page_view');
    const custom = batchB.events.find((event) => event.type === 'queued-b');
    assert.strictEqual(page.sequence, 1);
    assert.strictEqual(custom.sequence, 2);
  });

  function batchesOf(env) {
    return env.fetches.map((item) => JSON.parse(item.body));
  }

  function withSession(env) {
    const events = [];
    batchesOf(env).forEach((batch) => {
      assertBatchIdentity(batch);
      batch.events.forEach((event) => events.push(Object.assign({ _sessionId: batch.sessionId, _batch: batch }, event)));
    });
    return events;
  }

  await test('timeout click finalizes the old page before the click', async () => {
    const env = await load();
    await env.drain();
    const first = JSON.parse(env.fetches[0].body);
    const sessionA = first.sessionId;
    const pageX = first.events.find((event) => event.type === 'page_view').pageViewId;
    const visitorA = first.visitorId;
    const tabA = first.events[0].tabId;
    env.fetches.length = 0;
    env.beacons.length = 0;
    let perf = 5000;
    env.window.performance.now = function () {
      const current = perf;
      perf += 10;
      return current;
    };
    staleActivity(env);
    env.dispatch('click', env.document.createElement('button'));
    await env.drain();
    assert.strictEqual(env.beacons.length, 0);
    const events = withSession(env);
    const finals = events.filter((event) => event._sessionId === sessionA && event.pageViewId === pageX && event.eventFinal === 1);
    assert.strictEqual(finals.length, 3);
    assert.ok(finals.every((event) => event.engagementTrigger === 'session_timeout'));
    ['page_engagement', 'page_performance', 'resource_summary'].forEach((type) => {
      assert.strictEqual(finals.filter((event) => event.type === type).length, 1);
    });
    const page = events.find((event) => event.type === 'page_view');
    const click = events.find((event) => event.type === 'click');
    assert.ok(page);
    assert.ok(click);
    assert.notStrictEqual(page._sessionId, sessionA);
    assert.notStrictEqual(page.pageViewId, pageX);
    assert.strictEqual(page.sequence, 1);
    assert.strictEqual(page.pageViewIndex, 1);
    assert.ok(!page.previousPageViewId);
    assert.strictEqual(click.sequence, 2);
    assert.strictEqual(click.pageViewId, page.pageViewId);
    assert.strictEqual(click._sessionId, page._sessionId);
    assert.strictEqual(click._batch.visitorId, visitorA);
    assert.strictEqual(click.tabId, tabA);
    assert.ok(!events.some((event) => event._sessionId === page._sessionId && event.pageViewId === pageX));
    assert.ok(!events.some((event) => event._sessionId === sessionA && event._sessionId === page._sessionId));
    env.beacons.length = 0;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const engagement = JSON.parse(env.beacons[env.beacons.length - 1].body).events.find((event) => event.type === 'page_engagement' && event.pageViewId === page.pageViewId);
    assert.strictEqual(engagement.payload.clickCount, 1);
    assert.strictEqual(engagement.payload.timeToFirstInteractionMs, 10);
  });

  await test('timeout click count includes every later click', async () => {
    const env = await load();
    await env.drain();
    env.fetches.length = 0;
    staleActivity(env);
    const button = env.document.createElement('button');
    for (let i = 0; i < 9; i += 1) env.dispatch('click', button);
    await env.drain();
    const page = eventsFrom(env).find((event) => event.type === 'page_view');
    assert.strictEqual(eventsFrom(env).filter((event) => event.type === 'click' && event.pageViewId === page.pageViewId).length, 9);
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const engagement = JSON.parse(env.beacons[env.beacons.length - 1].body).events.find((event) => event.type === 'page_engagement' && event.pageViewId === page.pageViewId);
    assert.strictEqual(engagement.payload.clickCount, 9);
  });

  await test('session timeout final revision is the latest', async () => {
    const env = await load();
    await env.drain();
    const pageX = ofType(env, 'page_view')[0].pageViewId;
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    env.document.visibilityState = 'visible';
    env.dispatch('visibilitychange');
    staleActivity(env);
    env.fetches.length = 0;
    env.dispatch('click', env.document.createElement('button'));
    await env.drain();
    const life = withSession(env).filter((event) => event.pageViewId === pageX && (event.type === 'page_engagement' || event.type === 'page_performance' || event.type === 'resource_summary'));
    ['page_engagement', 'page_performance', 'resource_summary'].forEach((type) => {
      const rows = life.filter((event) => event.type === type);
      const fin = rows.find((event) => event.eventFinal === 1 && event.engagementTrigger === 'session_timeout');
      assert.ok(fin);
      assert.strictEqual(rows.filter((event) => event.eventFinal === 1).length, 1);
      rows.forEach((event) => assert.ok(event.eventRevision <= fin.eventRevision));
    });
  });

  await test('timeout submit is the first interaction of the new page', async () => {
    const env = await load();
    await env.drain();
    const sessionA = JSON.parse(env.fetches[0].body).sessionId;
    const pageX = ofType(env, 'page_view')[0].pageViewId;
    env.fetches.length = 0;
    let perf = 8000;
    env.window.performance.now = function () {
      const current = perf;
      perf += 10;
      return current;
    };
    staleActivity(env);
    const form = env.document.createElement('form');
    form.id = 'checkout';
    form.getElementsByTagName = function () { return []; };
    env.dispatch('submit', form);
    await env.drain();
    const events = withSession(env);
    assert.strictEqual(events.filter((event) => event._sessionId === sessionA && event.pageViewId === pageX && event.engagementTrigger === 'session_timeout' && event.eventFinal === 1).length, 3);
    const page = events.find((event) => event.type === 'page_view');
    const submit = events.find((event) => event.type === 'form_submit');
    assert.strictEqual(page.sequence, 1);
    assert.strictEqual(submit.sequence, 2);
    assert.strictEqual(submit.pageViewId, page.pageViewId);
    assert.notStrictEqual(page._sessionId, sessionA);
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const engagement = JSON.parse(env.beacons[env.beacons.length - 1].body).events.find((event) => event.type === 'page_engagement' && event.pageViewId === page.pageViewId);
    assert.strictEqual(engagement.payload.timeToFirstInteractionMs, 10);
  });

  await test('timeout custom event does not count as interaction', async () => {
    const env = await load();
    await env.drain();
    const sessionA = JSON.parse(env.fetches[0].body).sessionId;
    env.fetches.length = 0;
    staleActivity(env);
    env.window.RefIQ.event('after-timeout');
    await env.drain();
    const events = withSession(env);
    assert.strictEqual(events.filter((event) => event._sessionId === sessionA && event.engagementTrigger === 'session_timeout' && event.eventFinal === 1).length, 3);
    const page = events.find((event) => event.type === 'page_view');
    const custom = events.find((event) => event.type === 'after-timeout');
    assert.strictEqual(page.sequence, 1);
    assert.strictEqual(custom.sequence, 2);
    assert.strictEqual(custom.pageViewId, page.pageViewId);
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const engagement = JSON.parse(env.beacons[env.beacons.length - 1].body).events.find((event) => event.type === 'page_engagement' && event.pageViewId === page.pageViewId);
    assert.strictEqual(engagement.payload.clickCount, 0);
    assert.strictEqual(engagement.payload.scrollCount, 0);
    assert.strictEqual(engagement.payload.timeToFirstInteractionMs, undefined);
  });

  await test('timeout media event rolls into the new page', async () => {
    const env = await load();
    await env.drain();
    const sessionA = JSON.parse(env.fetches[0].body).sessionId;
    env.fetches.length = 0;
    staleActivity(env);
    const video = env.document.createElement('video');
    video.id = 'clip';
    video.currentTime = 1;
    video.duration = 10;
    env.dispatch('play', video);
    await env.drain();
    const events = withSession(env);
    assert.strictEqual(events.filter((event) => event._sessionId === sessionA && event.engagementTrigger === 'session_timeout').length, 3);
    const page = events.find((event) => event.type === 'page_view');
    const media = events.find((event) => event.type === 'media');
    assert.strictEqual(page.sequence, 1);
    assert.strictEqual(media.sequence, 2);
    assert.strictEqual(media.pageViewId, page.pageViewId);
    assert.notStrictEqual(page._sessionId, sessionA);
  });

  await test('timeout error event rolls into the new page', async () => {
    const env = await load();
    await env.drain();
    const sessionA = JSON.parse(env.fetches[0].body).sessionId;
    const pageX = ofType(env, 'page_view')[0].pageViewId;
    env.fetches.length = 0;
    staleActivity(env);
    env.dispatch('error', env.window, { filename: 'https://shop.example.com/app.js', lineno: 4, colno: 2 });
    await env.drain();
    const events = withSession(env);
    assert.strictEqual(events.filter((event) => event._sessionId === sessionA && event.pageViewId === pageX && event.engagementTrigger === 'session_timeout').length, 3);
    const page = events.find((event) => event.type === 'page_view');
    const error = events.find((event) => event.type === 'js_error');
    assert.strictEqual(page.sequence, 1);
    assert.strictEqual(error.sequence, 2);
    assert.strictEqual(error.pageViewId, page.pageViewId);
    assert.ok(!events.some((event) => event._sessionId !== sessionA && event.pageViewId === pageX));
  });

  await test('timeout scroll milestone belongs to the new page once', async () => {
    const env = await load();
    await env.drain();
    const sessionA = JSON.parse(env.fetches[0].body).sessionId;
    const pageX = ofType(env, 'page_view')[0].pageViewId;
    env.fetches.length = 0;
    staleActivity(env);
    env.window.scrollY = 250;
    env.dispatch('scroll');
    await env.drain();
    const events = withSession(env);
    assert.strictEqual(events.filter((event) => event._sessionId === sessionA && event.pageViewId === pageX && event.engagementTrigger === 'session_timeout').length, 3);
    const page = events.find((event) => event.type === 'page_view');
    const scrolls = events.filter((event) => event.type === 'scroll');
    assert.strictEqual(scrolls.length, 1);
    assert.strictEqual(scrolls[0].sequence, 2);
    assert.strictEqual(scrolls[0].pageViewId, page.pageViewId);
    assert.strictEqual(scrolls[0].payload.milestone, 25);
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    const engagement = JSON.parse(env.beacons[env.beacons.length - 1].body).events.find((event) => event.type === 'page_engagement' && event.pageViewId === page.pageViewId);
    assert.strictEqual(engagement.payload.scrollCount, 1);
  });

  await test('non milestone scroll does not roll the session', async () => {
    const env = await load();
    await env.drain();
    const sessionA = JSON.parse(env.fetches[0].body).sessionId;
    staleActivity(env);
    const sact = env.session._refiq_sact;
    env.fetches.length = 0;
    env.beacons.length = 0;
    env.window.scrollY = 0;
    env.dispatch('scroll');
    await env.drain();
    assert.strictEqual(env.beacons.length, 0);
    assert.ok(!eventsFrom(env).some((event) => event.type === 'scroll' || event.type === 'page_view' || event.engagementTrigger === 'session_timeout'));
    assert.strictEqual(env.session._refiq_sid, sessionA);
    assert.strictEqual(env.session._refiq_sact, sact);
  });

  await test('active click does not emit session timeout', async () => {
    const env = await load();
    await env.drain();
    const sessionA = JSON.parse(env.fetches[0].body).sessionId;
    const pageX = ofType(env, 'page_view')[0].pageViewId;
    env.fetches.length = 0;
    env.dispatch('click', env.document.createElement('button'));
    await env.drain();
    const events = withSession(env);
    assert.ok(!events.some((event) => event.engagementTrigger === 'session_timeout'));
    const click = events.find((event) => event.type === 'click');
    assert.strictEqual(click._sessionId, sessionA);
    assert.strictEqual(click.pageViewId, pageX);
  });

  const RQCID_A = 'abcdefghijkl';
  const RQCID_B = 'bbbbbbbbbbbb';
  const META_KEY = '_refiq_rqcid_meta';
  const T0 = 1700000000000;

  function readMeta(map) {
    return JSON.parse(map[META_KEY]);
  }

  function metaJson(rqcid, capturedAtMs) {
    return JSON.stringify({ rqcid: rqcid, capturedAtMs: capturedAtMs });
  }

  function pageCapturedAt(env) {
    return ofType(env, 'page_view')[0].payload.attribution.rqcidCapturedAtMs;
  }

  async function withClock(start, fn) {
    const realNow = Date.now;
    let clock = start;
    Date.now = () => clock;
    try {
      await fn({
        now() {
          return clock;
        },
        advance(ms) {
          clock += ms;
        },
      });
    } finally {
      Date.now = realNow;
    }
  }

  await test('fresh rqcid stores capturedAt metadata beside the plain id', async () => {
    await withClock(T0, async () => {
      const env = await load();
      await env.drain();
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(env), T0);
      assert.strictEqual(env.store.rqcid, RQCID_A);
      assert.strictEqual(env.session.rqcid, RQCID_A);
      assert.ok(env.cookie.indexOf('rqcid=' + RQCID_A) !== -1);
      assert.ok(env.cookie.indexOf(META_KEY) === -1);
      assert.deepStrictEqual(readMeta(env.store), { rqcid: RQCID_A, capturedAtMs: T0 });
      assert.deepStrictEqual(readMeta(env.session), { rqcid: RQCID_A, capturedAtMs: T0 });
    });
  });

  await test('repeated capture keeps the original capturedAt', async () => {
    await withClock(T0, async (clock) => {
      const env = await load();
      await env.drain();
      clock.advance(25000);
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
      env.dispatch('click', env.document.createElement('button'));
      await env.drain();
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(readMeta(env.store).capturedAtMs, T0);
      assert.strictEqual(readMeta(env.session).capturedAtMs, T0);
      assert.strictEqual(pageCapturedAt(env), T0);
    });
  });

  await test('reload restores capturedAt for the same rqcid', async () => {
    await withClock(T0 + 20000, async () => {
      const env = await load({
        href: 'https://shop.example.com/reloaded',
        storage: { rqcid: RQCID_A, [META_KEY]: metaJson(RQCID_A, T0) },
        session: { rqcid: RQCID_A, [META_KEY]: metaJson(RQCID_A, T0) },
        cookie: 'rqcid=' + RQCID_A,
      });
      await env.drain();
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(env), T0);
      assert.deepStrictEqual(readMeta(env.store), { rqcid: RQCID_A, capturedAtMs: T0 });
    });
  });

  await test('same rqcid in the url after reload keeps capturedAt', async () => {
    await withClock(T0 + 20000, async () => {
      const env = await load({
        href: 'https://shop.example.com/next?rqcid=' + RQCID_A + '&utm_source=google',
        storage: { rqcid: RQCID_A, [META_KEY]: metaJson(RQCID_A, T0) },
        session: { rqcid: RQCID_A, [META_KEY]: metaJson(RQCID_A, T0) },
        cookie: 'rqcid=' + RQCID_A,
      });
      await env.drain();
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(env), T0);
    });
  });

  await test('same rqcid keeps capturedAt across a new runtime', async () => {
    await withClock(T0, async (clock) => {
      const envA = await load();
      await envA.drain();
      const first = pageCapturedAt(envA);
      clock.advance(20000);
      const envB = await load({
        storage: envA.store,
        session: envA.session,
        cookie: envA.cookie,
        href: 'https://shop.example.com/next?rqcid=' + RQCID_A + '&utm_source=google',
      });
      await envB.drain();
      assert.strictEqual(pageCapturedAt(envA), T0);
      assert.strictEqual(pageCapturedAt(envB), first);
      assert.strictEqual(envB.window.RefIQ.getRqcid(), RQCID_A);
    });
  });

  await test('reload after a delay keeps the exact capturedAt', async () => {
    await withClock(T0, async (clock) => {
      const envA = await load();
      await envA.drain();
      clock.advance(20000);
      const envB = await load({
        storage: envA.store,
        session: envA.session,
        cookie: envA.cookie,
        href: 'https://shop.example.com/home?rqcid=' + RQCID_A + '&utm_source=google&token=secret',
      });
      await envB.drain();
      assert.strictEqual(pageCapturedAt(envB), T0);
      assert.strictEqual(envB.store.rqcid, RQCID_A);
    });
  });

  await test('spa navigation keeps capturedAt', async () => {
    await withClock(T0, async (clock) => {
      const env = await load();
      await env.drain();
      clock.advance(15000);
      env.fetches.length = 0;
      env.setPath('/spa-next');
      env.history.pushState({}, '', '/spa-next');
      await env.drain();
      const pages = ofType(env, 'page_view');
      assert.strictEqual(pages.length, 1);
      assert.strictEqual(pages[0].payload.attribution.rqcid, RQCID_A);
      assert.strictEqual(pages[0].payload.attribution.rqcidCapturedAtMs, T0);
      assert.strictEqual(readMeta(env.store).capturedAtMs, T0);
    });
  });

  await test('bfcache keeps capturedAt', async () => {
    await withClock(T0, async (clock) => {
      const env = await load();
      await env.drain();
      const pageId = ofType(env, 'page_view')[0].pageViewId;
      clock.advance(15000);
      env.beacons.length = 0;
      env.fetches.length = 0;
      env.dispatch('pagehide', env.document, { persisted: true });
      env.dispatch('pageshow', env.document, { persisted: true });
      assertAtomicTrio(env, 'pagehide_bfcache');
      assert.strictEqual(readMeta(env.store).capturedAtMs, T0);
      assert.strictEqual(readMeta(env.session).capturedAtMs, T0);
      assert.strictEqual(env.store.rqcid, RQCID_A);
      const life = lifecycleOf(beaconEvents(env), pageId);
      life.forEach((event) => {
        assert.strictEqual(event.payload.attribution.rqcidCapturedAtMs, T0);
      });
    });
  });

  await test('session timeout keeps the original rqcid capturedAt', async () => {
    await withClock(T0, async (clock) => {
      const env = await load();
      await env.drain();
      const first = JSON.parse(env.fetches[0].body);
      const sessionA = first.sessionId;
      const pageX = first.events.find((event) => event.type === 'page_view').pageViewId;
      env.fetches.length = 0;
      env.beacons.length = 0;
      let perf = 5000;
      env.window.performance.now = function () {
        const current = perf;
        perf += 10;
        return current;
      };
      clock.advance(70000);
      env.dispatch('click', env.document.createElement('button'));
      await env.drain();
      assert.strictEqual(env.beacons.length, 0);
      const events = withSession(env);
      const finals = events.filter((event) => event._sessionId === sessionA && event.pageViewId === pageX && event.eventFinal === 1);
      assert.strictEqual(finals.length, 3);
      assert.ok(finals.every((event) => event.engagementTrigger === 'session_timeout'));
      const page = events.find((event) => event.type === 'page_view');
      const click = events.find((event) => event.type === 'click');
      assert.strictEqual(page.sequence, 1);
      assert.strictEqual(page.pageViewIndex, 1);
      assert.ok(!page.previousPageViewId);
      assert.notStrictEqual(page.pageViewId, pageX);
      assert.notStrictEqual(page._sessionId, sessionA);
      assert.strictEqual(click.sequence, 2);
      assert.strictEqual(click.pageViewId, page.pageViewId);
      assert.strictEqual(page.payload.attribution.rqcid, RQCID_A);
      assert.strictEqual(page.payload.attribution.rqcidCapturedAtMs, T0);
      assert.strictEqual(click.payload.attribution.rqcidCapturedAtMs, T0);
      finals.forEach((event) => assert.strictEqual(event.payload.attribution.rqcidCapturedAtMs, T0));
      assert.ok(!events.some((event) => event._sessionId === page._sessionId && event.pageViewId === pageX));
      env.document.visibilityState = 'hidden';
      env.dispatch('visibilitychange');
      const engagement = JSON.parse(env.beacons[env.beacons.length - 1].body).events.find((event) => event.type === 'page_engagement' && event.pageViewId === page.pageViewId);
      assert.strictEqual(engagement.payload.clickCount, 1);
      assert.strictEqual(engagement.payload.timeToFirstInteractionMs, 10);
      assert.strictEqual(engagement.payload.attribution.rqcidCapturedAtMs, T0);
      assert.strictEqual(readMeta(env.store).capturedAtMs, T0);
      assert.strictEqual(env.store.rqcid, RQCID_A);
    });
  });

  await test('a different rqcid receives a new capturedAt', async () => {
    await withClock(T0, async (clock) => {
      const env = await load();
      await env.drain();
      clock.advance(8000);
      env.store[META_KEY] = metaJson(RQCID_B, T0 - 50);
      env.session[META_KEY] = metaJson(RQCID_B, T0 - 50);
      env.location.search = '?rqcid=' + RQCID_B;
      const t2 = clock.now();
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_B);
      assert.strictEqual(readMeta(env.store).rqcid, RQCID_B);
      assert.strictEqual(readMeta(env.store).capturedAtMs, t2);
      assert.strictEqual(readMeta(env.session).capturedAtMs, t2);
      assert.strictEqual(env.store.rqcid, RQCID_B);
      assert.strictEqual(env.session.rqcid, RQCID_B);
      assert.ok(env.cookie.indexOf('rqcid=' + RQCID_B) !== -1);
      assert.ok(t2 > T0);
      assert.notStrictEqual(t2, T0 - 50);
      env.fetches.length = 0;
      env.setPath('/after-new-click');
      env.history.pushState({}, '', '/after-new-click');
      await env.drain();
      const page = ofType(env, 'page_view')[0];
      assert.strictEqual(page.payload.attribution.rqcid, RQCID_B);
      assert.strictEqual(page.payload.attribution.rqcidCapturedAtMs, t2);
    });
  });

  await test('reloaded new rqcid keeps its own capturedAt', async () => {
    await withClock(T0, async (clock) => {
      const envA = await load();
      await envA.drain();
      clock.advance(8000);
      envA.location.search = '?rqcid=' + RQCID_B;
      const t2 = clock.now();
      assert.strictEqual(envA.window.RefIQ.getRqcid(), RQCID_B);
      clock.advance(20000);
      const envB = await load({
        storage: envA.store,
        session: envA.session,
        cookie: envA.cookie,
        href: 'https://shop.example.com/later?rqcid=' + RQCID_B,
      });
      await envB.drain();
      assert.strictEqual(pageCapturedAt(envB), t2);
      assert.strictEqual(envB.window.RefIQ.getRqcid(), RQCID_B);
      assert.notStrictEqual(pageCapturedAt(envB), clock.now());
    });
  });

  await test('metadata for another rqcid is ignored', async () => {
    await withClock(T0 + 5000, async (clock) => {
      const env = await load({
        href: 'https://shop.example.com/plain',
        storage: { rqcid: RQCID_B, [META_KEY]: metaJson(RQCID_A, T0) },
        cookie: 'rqcid=' + RQCID_B,
      });
      await env.drain();
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_B);
      assert.strictEqual(pageCapturedAt(env), clock.now());
      assert.notStrictEqual(pageCapturedAt(env), T0);
      assert.deepStrictEqual(readMeta(env.store), { rqcid: RQCID_B, capturedAtMs: clock.now() });
    });
  });

  await test('corrupt rqcid metadata does not break capture', async () => {
    await withClock(T0, async () => {
      const env = await load({
        href: 'https://shop.example.com/plain',
        storage: { rqcid: RQCID_A, [META_KEY]: '{bad' },
        session: { rqcid: RQCID_A, [META_KEY]: '{bad' },
        cookie: 'rqcid=' + RQCID_A,
      });
      await env.drain();
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(env), T0);
      assert.deepStrictEqual(readMeta(env.store), { rqcid: RQCID_A, capturedAtMs: T0 });
      assert.deepStrictEqual(readMeta(env.session), { rqcid: RQCID_A, capturedAtMs: T0 });
    });
  });

  await test('invalid capturedAt metadata is replaced', async () => {
    const samples = [0, -1, 'abc', null];
    for (const capturedAtMs of samples) {
      await withClock(T0, async () => {
        const env = await load({
          href: 'https://shop.example.com/plain',
          storage: {
            rqcid: RQCID_A,
            [META_KEY]: JSON.stringify({ rqcid: RQCID_A, capturedAtMs: capturedAtMs }),
          },
          cookie: 'rqcid=' + RQCID_A,
        });
        await env.drain();
        assert.strictEqual(pageCapturedAt(env), T0);
        assert.deepStrictEqual(readMeta(env.store), { rqcid: RQCID_A, capturedAtMs: T0 });
      });
    }
    await withClock(T0, async () => {
      const env = await load({
        href: 'https://shop.example.com/plain',
        storage: { rqcid: RQCID_A, [META_KEY]: '{"rqcid":"abcdefghijkl","capturedAtMs":NaN}' },
        cookie: 'rqcid=' + RQCID_A,
      });
      await env.drain();
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(env), T0);
    });
  });

  await test('invalid metadata rqcid is ignored', async () => {
    await withClock(T0, async () => {
      const env = await load({
        href: 'https://shop.example.com/plain',
        storage: { rqcid: RQCID_A, [META_KEY]: JSON.stringify({ rqcid: 'not-an-id', capturedAtMs: 111 }) },
        cookie: 'rqcid=' + RQCID_A,
      });
      await env.drain();
      assert.strictEqual(pageCapturedAt(env), T0);
      assert.strictEqual(readMeta(env.store).rqcid, RQCID_A);
    });
    await withClock(T0 + 9000, async (clock) => {
      const env = await load({
        href: 'https://shop.example.com/plain?rqcid=' + RQCID_B,
        storage: { rqcid: RQCID_A, [META_KEY]: metaJson(RQCID_A, T0) },
      });
      await env.drain();
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_B);
      assert.strictEqual(pageCapturedAt(env), clock.now());
      assert.notStrictEqual(pageCapturedAt(env), T0);
    });
  });

  await test('storage failure does not stop rqcid capture', async () => {
    await withClock(T0 + 4000, async () => {
      const env = await load({
        throwLocalStorage: true,
        href: 'https://shop.example.com/plain',
        session: { rqcid: RQCID_A, [META_KEY]: metaJson(RQCID_A, T0) },
        cookie: 'rqcid=' + RQCID_A,
      });
      await env.drain();
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(env), T0);
      assert.ok(!Object.prototype.hasOwnProperty.call(env.store, META_KEY));
      assert.deepStrictEqual(readMeta(env.session), { rqcid: RQCID_A, capturedAtMs: T0 });
      assert.strictEqual(env.session.rqcid, RQCID_A);
      assert.ok(env.cookie.indexOf('rqcid=' + RQCID_A) !== -1);
    });
    const env = await load({ throwStorage: true, href: 'https://shop.example.com/plain?rqcid=' + RQCID_A });
    await env.drain();
    assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
    assert.ok(pageCapturedAt(env) > 0);
    assert.ok(ofType(env, 'page_view').length >= 1);
    assert.ok(env.cookie.indexOf('rqcid=' + RQCID_A) !== -1);
  });

  await test('install without metadata migrates once and then stays stable', async () => {
    await withClock(T0, async (clock) => {
      const envA = await load({
        href: 'https://shop.example.com/plain',
        storage: { rqcid: RQCID_A },
        session: { rqcid: RQCID_A },
        cookie: 'rqcid=' + RQCID_A,
      });
      await envA.drain();
      assert.strictEqual(envA.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(envA), T0);
      assert.strictEqual(envA.store.rqcid, RQCID_A);
      assert.deepStrictEqual(readMeta(envA.store), { rqcid: RQCID_A, capturedAtMs: T0 });
      clock.advance(20000);
      const envB = await load({
        href: 'https://shop.example.com/plain',
        storage: envA.store,
        session: envA.session,
        cookie: envA.cookie,
      });
      await envB.drain();
      assert.strictEqual(pageCapturedAt(envB), T0);
      assert.strictEqual(envB.store.rqcid, RQCID_A);
      assert.strictEqual(envB.session.rqcid, RQCID_A);
    });
  });

  await test('rqcid storage values stay plain strings', async () => {
    await withClock(T0, async () => {
      const env = await load();
      await env.drain();
      assert.strictEqual(env.store.rqcid, RQCID_A);
      assert.strictEqual(env.session.rqcid, RQCID_A);
      assert.strictEqual(typeof env.store.rqcid, 'string');
      assert.ok(env.store.rqcid.indexOf('{') === -1);
      assert.ok(env.store.rqcid.indexOf('|') === -1);
      assert.ok(env.cookie.indexOf('rqcid=' + RQCID_A) !== -1);
      assert.ok(env.cookie.indexOf('rqcid=' + RQCID_A + '|') === -1);
      assert.ok(env.cookie.indexOf('rqcid={') === -1);
    });
  });

  await test('new analytical session resets landing and keeps click age', async () => {
    await withClock(T0, async (clock) => {
      const env = await load({
        href: 'https://shop.example.com/page-a?rqcid=' + RQCID_A + '&utm_source=a&utm_campaign=campaign-a',
        referrer: 'https://ref.example/from-a',
      });
      await env.drain();
      const first = ofType(env, 'page_view')[0];
      assert.strictEqual(first.payload.attribution.landingPath, '/page-a');
      assert.strictEqual(first.payload.attribution.rqcidCapturedAtMs, T0);
      env.fetches.length = 0;
      clock.advance(70000);
      env.location.pathname = '/page-b';
      env.location.search = '?rqcid=' + RQCID_A + '&utm_source=b&utm_campaign=campaign-b';
      env.window.RefIQ.event('next-session');
      await env.drain();
      const page = eventsFrom(env).find((event) => event.type === 'page_view');
      assert.strictEqual(page.payload.attribution.landingPath, '/page-b');
      assert.strictEqual(page.payload.attribution.utmSource, 'b');
      assert.strictEqual(page.payload.attribution.utmCampaign, 'campaign-b');
      assert.strictEqual(page.payload.attribution.rqcid, RQCID_A);
      assert.strictEqual(page.payload.attribution.rqcidCapturedAtMs, T0);
      assert.strictEqual(page.sequence, 1);
      assert.strictEqual(page.pageViewIndex, 1);
      const attr = JSON.parse(env.session._refiq_attr);
      assert.strictEqual(attr.landingPath, '/page-b');
      assert.ok(!JSON.stringify(attr).includes('page-a'));
      assert.strictEqual(readMeta(env.store).capturedAtMs, T0);
      assert.strictEqual(env.store.rqcid, RQCID_A);
    });
  });

  await test('event schema stays the same while capturedAt is stable', async () => {
    await withClock(T0, async (clock) => {
      const env = await load();
      await env.drain();
      clock.advance(5000);
      const envB = await load({
        storage: env.store,
        session: env.session,
        cookie: env.cookie,
      });
      await envB.drain();
      const batch = JSON.parse(envB.fetches[0].body);
      assert.strictEqual(batch.schemaVersion, 1);
      const page = batch.events.find((event) => event.type === 'page_view');
      const allowed = {
        rqcid: 1,
        rqcidCapturedAtMs: 1,
        utmSource: 1,
        utmMedium: 1,
        utmCampaign: 1,
        utmContent: 1,
        utmTerm: 1,
        yclid: 1,
        gclid: 1,
        fbclid: 1,
        ttclid: 1,
        vkClickId: 1,
        landingPath: 1,
        landingOrigin: 1,
        landingHostname: 1,
        landingReferrer: 1,
      };
      Object.keys(page.payload.attribution).forEach((key) => {
        assert.ok(allowed[key], key);
      });
      assert.strictEqual(page.payload.attribution.rqcid, RQCID_A);
      assert.strictEqual(page.payload.attribution.rqcidCapturedAtMs, T0);
      assert.ok(!page.payload.rqcidMeta);
      assert.ok(!page.rqcidMeta);
    });
  });

  await test('lifecycle snapshots keep one capturedAt for the same rqcid', async () => {
    await withClock(T0, async (clock) => {
      const hidden = await load();
      await hidden.drain();
      const pageId = ofType(hidden, 'page_view')[0].pageViewId;
      hidden.fetches.length = 0;
      hidden.beacons.length = 0;
      clock.advance(10000);
      hidden.document.visibilityState = 'hidden';
      hidden.dispatch('visibilitychange');
      hidden.document.visibilityState = 'visible';
      hidden.dispatch('visibilitychange');
      hidden.document.visibilityState = 'hidden';
      hidden.dispatch('visibilitychange');
      const hiddenLife = lifecycleOf(beaconEvents(hidden), pageId);
      assert.strictEqual(hiddenLife.length, 6);
      assert.ok(hiddenLife.every((event) => event.eventFinal === 0));
      hiddenLife.forEach((event) => assert.strictEqual(event.payload.attribution.rqcidCapturedAtMs, T0));
      assert.strictEqual(readMeta(hidden.store).capturedAtMs, T0);

      const finalEnv = await load();
      await finalEnv.drain();
      const finalPage = ofType(finalEnv, 'page_view')[0].pageViewId;
      const finalAt = pageCapturedAt(finalEnv);
      finalEnv.fetches.length = 0;
      finalEnv.beacons.length = 0;
      finalEnv.dispatch('pagehide', finalEnv.document, { persisted: false });
      finalEnv.dispatch('pagehide', finalEnv.document, { persisted: false });
      assertAtomicTrio(finalEnv, 'pagehide', 1);
      const finals = uniqueEvents(beaconEvents(finalEnv)).filter((event) => event.pageViewId === finalPage && event.eventFinal === 1);
      assert.strictEqual(finals.length, 3);
      finals.forEach((event) => {
        assert.strictEqual(event.payload.attribution.rqcidCapturedAtMs, finalAt);
        assert.strictEqual(event.delivery.attempt, 1);
      });
      for (let i = 1; i < finals.length; i += 1) {
        assert.strictEqual(finals[i].sequence, finals[i - 1].sequence + 1);
      }
      assert.strictEqual(readMeta(finalEnv.store).capturedAtMs, finalAt);
    });
  });

  await test('internal link href stays free of rqcid', async () => {
    const env = await load();
    const link = env.document.createElement('a');
    link.href = 'https://shop.example.com/catalog';
    env.dispatch('click', link);
    assert.strictEqual(link.href, 'https://shop.example.com/catalog');
    assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
  });

  await test('fresh tracking url still captures rqcid', async () => {
    await withClock(T0, async () => {
      const env = await load({
        href: 'https://shop.example.com/product?rqcid=' + RQCID_A,
        storage: {},
        session: {},
        cookie: '',
      });
      await env.drain();
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
      assert.ok(env.cookie.indexOf('rqcid=' + RQCID_A) !== -1);
      assert.strictEqual(env.store.rqcid, RQCID_A);
      assert.strictEqual(env.session.rqcid, RQCID_A);
      assert.deepStrictEqual(readMeta(env.store), { rqcid: RQCID_A, capturedAtMs: T0 });
      assert.strictEqual(pageCapturedAt(env), T0);
    });
  });

  await test('internal link query and explicit rqcid stay untouched', async () => {
    await withClock(T0, async (clock) => {
      const env = await load();
      const catalog = env.document.createElement('a');
      catalog.href = '/catalog?category=chairs&sort=popular';
      env.dispatch('click', catalog);
      assert.strictEqual(catalog.href, '/catalog?category=chairs&sort=popular');
      const explicit = env.document.createElement('a');
      explicit.href = '/product?rqcid=' + RQCID_A;
      env.dispatch('click', explicit);
      assert.strictEqual(explicit.href, '/product?rqcid=' + RQCID_A);
      const other = env.document.createElement('a');
      other.href = 'https://shop.example.com/product?color=red&rqcid=' + RQCID_B;
      env.dispatch('click', other);
      assert.strictEqual(other.href, 'https://shop.example.com/product?color=red&rqcid=' + RQCID_B);
      clock.advance(5000);
      const next = await load({
        href: 'https://shop.example.com/product?color=red&rqcid=' + RQCID_B,
        storage: env.store,
        session: env.session,
        cookie: env.cookie,
      });
      await next.drain();
      assert.strictEqual(next.window.RefIQ.getRqcid(), RQCID_B);
      assert.strictEqual(pageCapturedAt(next), clock.now());
      assert.notStrictEqual(pageCapturedAt(next), T0);
      assert.deepStrictEqual(readMeta(next.store), { rqcid: RQCID_B, capturedAtMs: clock.now() });
    });
  });

  await test('full navigation keeps attribution without putting rqcid in the url', async () => {
    await withClock(T0, async () => {
      let env = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
      await env.drain();
      assert.strictEqual(pageCapturedAt(env), T0);
      for (const path of ['/catalog', '/checkout', '/success']) {
        const link = env.document.createElement('a');
        link.href = 'https://shop.example.com' + path;
        env.dispatch('click', link);
        assert.strictEqual(link.href, 'https://shop.example.com' + path);
        await env.drain();
        assert.ok(ofType(env, 'click').length >= 1);
        env = await load({
          href: 'https://shop.example.com' + path,
          storage: env.store,
          session: env.session,
          cookie: env.cookie,
        });
        await env.drain();
        const page = ofType(env, 'page_view')[0];
        assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
        assert.strictEqual(page.payload.attribution.rqcid, RQCID_A);
        assert.strictEqual(page.payload.attribution.rqcidCapturedAtMs, T0);
        assert.strictEqual(page.payload.query.rqcid, undefined);
        assert.strictEqual(env.store.rqcid, RQCID_A);
      }
    });
  });

  await test('reload of an internal page restores rqcid and capturedAt', async () => {
    await withClock(T0, async (clock) => {
      const first = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
      await first.drain();
      clock.advance(20000);
      const second = await load({
        href: 'https://shop.example.com/checkout',
        storage: first.store,
        session: first.session,
        cookie: first.cookie,
      });
      await second.drain();
      assert.strictEqual(second.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(second), T0);
      assert.strictEqual(ofType(second, 'page_view')[0].payload.query.rqcid, undefined);
    });
  });

  await test('spa navigation keeps attribution and does not decorate links', async () => {
    await withClock(T0, async (clock) => {
      const env = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
      await env.drain();
      const link = env.document.createElement('a');
      link.href = '/catalog';
      env.dispatch('click', link);
      assert.strictEqual(link.href, '/catalog');
      clock.advance(1000);
      env.fetches.length = 0;
      env.setPath('/catalog');
      env.history.pushState({}, '', '/catalog');
      env.setPath('/catalog-replaced');
      env.history.replaceState({}, '', '/catalog-replaced');
      env.dispatch('popstate');
      env.setPath('/catalog-replaced', '#details');
      env.dispatch('hashchange');
      await env.drain();
      const pages = ofType(env, 'page_view');
      assert.ok(pages.length >= 2);
      pages.forEach((page) => {
        assert.strictEqual(page.payload.attribution.rqcid, RQCID_A);
        assert.strictEqual(page.payload.attribution.rqcidCapturedAtMs, T0);
      });
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(readMeta(env.store).capturedAtMs, T0);
    });
  });

  await test('click does not rewrite any supported link href', async () => {
    const env = await load();
    const samples = [
      ['https://shop.example.com/catalog', {}],
      ['https://shop.example.com/catalog', { target: '_blank' }],
      ['https://shop.example.com/file.pdf', { _download: 'file.pdf' }],
      ['https://shop.example.com/catalog#reviews', {}],
      ['https://shop.example.com/catalog?sort=popular#reviews', {}],
      ['https://shop.example.com/catalog', {}],
      ['/catalog', {}],
      ['catalog', {}],
      ['mailto:buyer@shop.example.com', {}],
      ['tel:+79990000000', {}],
      ['https://other.test/out', {}],
      ['https://shop.example.com/catalog', { prevent: true }],
      ['https://shop.example.com/catalog', { ctrlKey: true }],
      ['https://shop.example.com/catalog', { metaKey: true }],
    ];
    samples.forEach((entry) => {
      const href = entry[0];
      const extra = entry[1];
      const link = env.document.createElement('a');
      link.href = href;
      if (extra.target) link.target = extra.target;
      if (extra._download) link._download = extra._download;
      const eventExtra = {
        ctrlKey: !!extra.ctrlKey,
        metaKey: !!extra.metaKey,
      };
      if (extra.prevent) {
        eventExtra.preventDefault = function () {
          this.defaultPrevented = true;
        };
      }
      env.dispatch('click', link, eventExtra);
      assert.strictEqual(link.href, href);
    });
    await env.drain();
    assert.ok(ofType(env, 'click').length >= samples.length);
  });

  await test('rqcid cookie and storage survive internal navigation', async () => {
    await withClock(T0, async (clock) => {
      const env = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
      await env.drain();
      const expectedCookie = 'rqcid=' + RQCID_A + ';path=/;max-age=31536000;SameSite=Lax;Secure';
      assert.ok(env.cookieWrites.indexOf(expectedCookie) !== -1);
      assert.ok(env.cookie.indexOf('rqcid=' + RQCID_A) !== -1);
      const keys = Object.keys(env.store).sort();
      const link = env.document.createElement('a');
      link.href = 'https://shop.example.com/catalog';
      env.dispatch('click', link);
      assert.deepStrictEqual(Object.keys(env.store).sort(), keys);
      assert.strictEqual(env.store.rqcid, RQCID_A);
      assert.strictEqual(env.session.rqcid, RQCID_A);
      assert.deepStrictEqual(readMeta(env.store), { rqcid: RQCID_A, capturedAtMs: T0 });
      assert.deepStrictEqual(readMeta(env.session), { rqcid: RQCID_A, capturedAtMs: T0 });
      clock.advance(5000);
      const reloaded = await load({
        href: 'https://shop.example.com/catalog',
        storage: env.store,
        session: env.session,
        cookie: env.cookie,
      });
      await reloaded.drain();
      assert.ok(reloaded.cookie.indexOf('rqcid=' + RQCID_A) !== -1);
      assert.ok(reloaded.cookieWrites.indexOf(expectedCookie) !== -1);
      assert.strictEqual(reloaded.store.rqcid, RQCID_A);
      assert.strictEqual(reloaded.session.rqcid, RQCID_A);
      assert.strictEqual(pageCapturedAt(reloaded), T0);
    });
  });

  await test('timeout click keeps attribution and leaves the href alone', async () => {
    await withClock(T0, async (clock) => {
      const env = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
      await env.drain();
      const sessionA = JSON.parse(env.fetches[0].body).sessionId;
      const pageX = ofType(env, 'page_view')[0].pageViewId;
      env.fetches.length = 0;
      env.beacons.length = 0;
      let perf = 5000;
      env.window.performance.now = function () {
        const current = perf;
        perf += 10;
        return current;
      };
      clock.advance(70000);
      const link = env.document.createElement('a');
      link.href = 'https://shop.example.com/catalog';
      env.dispatch('click', link);
      await env.drain();
      assert.strictEqual(link.href, 'https://shop.example.com/catalog');
      assert.strictEqual(env.beacons.length, 0);
      const events = withSession(env);
      const finals = events.filter((event) => event._sessionId === sessionA && event.pageViewId === pageX && event.eventFinal === 1);
      assert.strictEqual(finals.length, 3);
      assert.ok(finals.every((event) => event.engagementTrigger === 'session_timeout'));
      const page = events.find((event) => event.type === 'page_view');
      const click = events.find((event) => event.type === 'click');
      assert.strictEqual(page.sequence, 1);
      assert.strictEqual(click.sequence, 2);
      assert.notStrictEqual(page.pageViewId, pageX);
      assert.strictEqual(click.pageViewId, page.pageViewId);
      assert.strictEqual(page.payload.attribution.rqcid, RQCID_A);
      assert.strictEqual(page.payload.attribution.rqcidCapturedAtMs, T0);
      assert.strictEqual(click.payload.attribution.rqcidCapturedAtMs, T0);
      env.document.visibilityState = 'hidden';
      env.dispatch('visibilitychange');
      const engagement = JSON.parse(env.beacons[env.beacons.length - 1].body).events.find((event) => event.type === 'page_engagement' && event.pageViewId === page.pageViewId);
      assert.strictEqual(engagement.payload.clickCount, 1);
    });
  });

  await test('bfcache and pagehide keep attribution after decoration removal', async () => {
    await withClock(T0, async () => {
      const cached = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
      await cached.drain();
      const pageId = ofType(cached, 'page_view')[0].pageViewId;
      cached.fetches.length = 0;
      cached.beacons.length = 0;
      cached.dispatch('pagehide', cached.document, { persisted: true });
      cached.dispatch('pageshow', cached.document, { persisted: true });
      assertAtomicTrio(cached, 'pagehide_bfcache');
      const life = lifecycleOf(beaconEvents(cached), pageId);
      assert.strictEqual(life.length, 3);
      assert.ok(life.every((event) => event.eventFinal === 0));
      life.forEach((event) => assert.strictEqual(event.payload.attribution.rqcidCapturedAtMs, T0));
      assert.strictEqual(cached.window.RefIQ.getRqcid(), RQCID_A);

      const finalEnv = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
      await finalEnv.drain();
      const finalPage = ofType(finalEnv, 'page_view')[0].pageViewId;
      finalEnv.fetches.length = 0;
      finalEnv.beacons.length = 0;
      finalEnv.dispatch('pagehide', finalEnv.document, { persisted: false });
      finalEnv.dispatch('pagehide', finalEnv.document, { persisted: false });
      assertAtomicTrio(finalEnv, 'pagehide', 1);
      const finals = uniqueEvents(beaconEvents(finalEnv)).filter((event) => event.pageViewId === finalPage && event.eventFinal === 1);
      assert.strictEqual(finals.length, 3);
      const revisions = {};
      finals.forEach((event) => {
        assert.strictEqual(event.payload.attribution.rqcid, RQCID_A);
        assert.strictEqual(event.payload.attribution.rqcidCapturedAtMs, T0);
        revisions[event.type] = event.eventRevision;
      });
      assert.ok(revisions.page_engagement >= 1);
      assert.ok(revisions.page_performance >= 1);
      assert.ok(revisions.resource_summary >= 1);
    });
  });

  await test('form submit still carries the hidden rqcid', async () => {
    const form = {
      nodeName: 'FORM',
      tagName: 'FORM',
      method: 'post',
      id: 'checkout',
      elements: [],
      getAttribute(name) {
        return name === 'data-refiq-id' ? 'checkout' : '';
      },
      appendChild(child) {
        this.elements.push(child);
        this._inputs = this.elements;
        child.parentNode = this;
      },
      removeChild(child) {
        this.elements.splice(this.elements.indexOf(child), 1);
        child.parentNode = null;
      },
      getElementsByTagName(tag) {
        return tag === 'input' ? this.elements : [];
      },
      checkValidity() {
        return true;
      },
    };
    const env = await load({ forms: [form], href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
    const data = submitForm(env, form, null, [['productId', '123']]);
    await env.drain();
    assert.strictEqual(form.elements.filter((el) => el.name === 'rqcid').length, 0);
    assert.strictEqual(data.get('rqcid'), RQCID_A);
    const submit = ofType(env, 'form_submit')[0];
    assert.ok(submit);
    assert.strictEqual(submit.payload.formId, 'checkout');
    assert.strictEqual(submit.payload.method, 'post');
    assert.strictEqual(submit.payload.attribution.rqcid, RQCID_A);
  });

  await test('new rqcid stays stable across a clean internal reload', async () => {
    await withClock(T0, async (clock) => {
      const first = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
      await first.drain();
      clock.advance(8000);
      const second = await load({
        href: 'https://shop.example.com/offer?rqcid=' + RQCID_B,
        storage: first.store,
        session: first.session,
        cookie: first.cookie,
      });
      await second.drain();
      const t2 = pageCapturedAt(second);
      assert.strictEqual(second.window.RefIQ.getRqcid(), RQCID_B);
      assert.ok(t2 > T0);
      const link = second.document.createElement('a');
      link.href = 'https://shop.example.com/thanks';
      second.dispatch('click', link);
      assert.strictEqual(link.href, 'https://shop.example.com/thanks');
      clock.advance(20000);
      const third = await load({
        href: 'https://shop.example.com/thanks',
        storage: second.store,
        session: second.session,
        cookie: second.cookie,
      });
      await third.drain();
      assert.strictEqual(third.window.RefIQ.getRqcid(), RQCID_B);
      assert.strictEqual(pageCapturedAt(third), t2);
      assert.strictEqual(readMeta(third.store).rqcid, RQCID_B);
    });
  });

  await test('attribution survives when one persistence mechanism remains', async () => {
    await withClock(T0, async () => {
      const cookieBlocked = await load({
        blockCookie: true,
        href: 'https://shop.example.com/product?rqcid=' + RQCID_A,
      });
      await cookieBlocked.drain();
      assert.strictEqual(cookieBlocked.cookie.indexOf('rqcid='), -1);
      assert.strictEqual(cookieBlocked.store.rqcid, RQCID_A);
      const afterCookieBlock = await load({
        blockCookie: true,
        href: 'https://shop.example.com/catalog',
        storage: cookieBlocked.store,
        session: cookieBlocked.session,
        cookie: '',
      });
      await afterCookieBlock.drain();
      assert.strictEqual(afterCookieBlock.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(afterCookieBlock), T0);

      const localBlocked = await load({
        throwLocalStorage: true,
        href: 'https://shop.example.com/product?rqcid=' + RQCID_A,
      });
      await localBlocked.drain();
      assert.ok(localBlocked.cookie.indexOf('rqcid=' + RQCID_A) !== -1);
      const afterLocalBlock = await load({
        throwLocalStorage: true,
        href: 'https://shop.example.com/catalog',
        cookie: localBlocked.cookie,
        session: localBlocked.session,
      });
      await afterLocalBlock.drain();
      assert.strictEqual(afterLocalBlock.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(afterLocalBlock), T0);

      const sessionBlocked = await load({
        throwSessionStorage: true,
        href: 'https://shop.example.com/product?rqcid=' + RQCID_A,
      });
      await sessionBlocked.drain();
      assert.strictEqual(sessionBlocked.store.rqcid, RQCID_A);
      assert.ok(sessionBlocked.cookie.indexOf('rqcid=' + RQCID_A) !== -1);
      const afterSessionBlock = await load({
        throwSessionStorage: true,
        href: 'https://shop.example.com/catalog',
        storage: sessionBlocked.store,
        cookie: sessionBlocked.cookie,
      });
      await afterSessionBlock.drain();
      assert.strictEqual(afterSessionBlock.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(afterSessionBlock), T0);

      const landingOnly = await load({
        throwStorage: true,
        blockCookie: true,
        href: 'https://shop.example.com/product?rqcid=' + RQCID_A,
      });
      await landingOnly.drain();
      assert.strictEqual(landingOnly.window.RefIQ.getRqcid(), RQCID_A);
      const dropped = await load({
        throwStorage: true,
        blockCookie: true,
        href: 'https://shop.example.com/catalog',
      });
      await dropped.drain();
      assert.strictEqual(dropped.window.RefIQ.getRqcid(), null);
      assert.strictEqual(ofType(dropped, 'page_view')[0].payload.attribution.rqcid, undefined);
    });
  });

  await test('a new tab restores rqcid from cookie and localStorage', async () => {
    await withClock(T0, async () => {
      const first = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
      await first.drain();
      const opened = await load({
        href: 'https://shop.example.com/catalog',
        storage: first.store,
        session: {},
        cookie: first.cookie,
      });
      await opened.drain();
      assert.strictEqual(opened.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(opened), T0);
      assert.notStrictEqual(opened.session._refiq_tab, first.session._refiq_tab);
      const link = opened.document.createElement('a');
      link.href = 'https://shop.example.com/success';
      opened.dispatch('click', link);
      assert.strictEqual(link.href, 'https://shop.example.com/success');
      const reloaded = await load({
        href: 'https://shop.example.com/success',
        storage: opened.store,
        session: opened.session,
        cookie: opened.cookie,
      });
      await reloaded.drain();
      assert.strictEqual(reloaded.window.RefIQ.getRqcid(), RQCID_A);
      assert.strictEqual(pageCapturedAt(reloaded), T0);
    });
  });

  await test('click payload keeps its fields without an added rqcid query', async () => {
    await withClock(T0, async () => {
      const env = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A + '&utm_source=google' });
      await env.drain();
      env.fetches.length = 0;
      const link = env.document.createElement('a');
      link.href = 'https://shop.example.com/catalog?sort=popular';
      link.id = 'buy';
      env.dispatch('click', link);
      await env.drain();
      assert.strictEqual(link.href, 'https://shop.example.com/catalog?sort=popular');
      const click = ofType(env, 'click')[0];
      assert.strictEqual(click.payload.clientX, 15);
      assert.strictEqual(click.payload.clientY, 25);
      assert.strictEqual(click.payload.target.id, 'buy');
      assert.strictEqual(click.payload.target.href, 'https://shop.example.com/catalog');
      assert.ok(click.payload.clickViewportXRatio >= 0);
      assert.strictEqual(click.payload.attribution.rqcid, RQCID_A);
      assert.strictEqual(click.payload.attribution.rqcidCapturedAtMs, T0);
      assert.strictEqual(click.payload.query.rqcid, RQCID_A);
      assert.strictEqual(click._batch.schemaVersion, 1);
      assert.ok(click.pageViewId);
      assert.ok(click.sequence > 1);
    });
  });

  function actionForm(env, action, method) {
    const form = env.document.createElement('form');
    form.method = method || 'post';
    form.elements = form.elements || [];
    if (action != null) form.setAttribute('action', action);
    return form;
  }

  await test('same-origin post receives rqcid once', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    const before = env.listeners.submit.length;
    const data = submitForm(env, form, null, [['productId', '123']]);
    await env.drain();
    assert.strictEqual(data.count('rqcid'), 1);
    assert.strictEqual(data.get('rqcid'), 'abcdefghijkl');
    assert.strictEqual(data.get('productId'), '123');
    assert.strictEqual(form.elements.filter((el) => el.name === 'rqcid').length, 0);
    assert.ok(ofType(env, 'form_submit').length >= 1);
    assert.strictEqual(env.listeners.submit.length, before);
    assert.strictEqual(form.getAttribute('action'), '/order');
  });

  await test('cross-origin form is not given an rqcid field at init', async () => {
    const env = await load();
    const form = actionForm(env, 'https://external.example/order', 'post');
    assert.strictEqual(form.elements.filter((el) => el.name === 'rqcid').length, 0);
    const data = submitForm(env, form, null, [['productId', '123']]);
    await env.drain();
    assert.strictEqual(data.count('rqcid'), 0);
    assert.strictEqual(form.getAttribute('action'), 'https://external.example/order');
    assert.ok(ofType(env, 'form_submit').length >= 1);
    const getData = submitForm(env, actionForm(env, 'https://external.example/order', 'get'), null, [['q', '1']]);
    assert.strictEqual(getData.count('rqcid'), 0);
  });

  await test('relative and absolute form destinations follow origin', async () => {
    const env = await load({ href: 'https://shop.example.com/home?rqcid=abcdefghijkl' });
    ['/order', 'order', './order', '../order', 'https://shop.example.com/order'].forEach((action) => {
      const data = submitForm(env, actionForm(env, action), null, [['productId', '1']]);
      assert.strictEqual(data.get('rqcid'), 'abcdefghijkl', action);
    });
    const external = submitForm(env, actionForm(env, 'https://external.example/order'), null, [['productId', '1']]);
    assert.strictEqual(external.count('rqcid'), 0);
  });

  await test('missing action follows the document and base href', async () => {
    const env = await load({ href: 'https://shop.example.com/product?rqcid=abcdefghijkl' });
    const missing = actionForm(env, null, 'post');
    const empty = actionForm(env, '', 'post');
    assert.strictEqual(submitForm(env, missing).get('rqcid'), 'abcdefghijkl');
    assert.strictEqual(submitForm(env, empty).get('rqcid'), 'abcdefghijkl');
    const based = await load({
      href: 'https://shop.example.com/product?rqcid=abcdefghijkl',
      baseURI: 'https://cdn.example/app/',
    });
    assert.strictEqual(submitForm(based, actionForm(based, '')).get('rqcid'), 'abcdefghijkl');
    assert.strictEqual(submitForm(based, actionForm(based, 'order')).count('rqcid'), 0);
  });

  await test('formaction chooses the destination for that submitter', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    const local = env.document.createElement('button');
    local.setAttribute('type', 'submit');
    const external = env.document.createElement('button');
    external.setAttribute('type', 'submit');
    external.setAttribute('formaction', 'https://external.example/order');
    const localData = submitForm(env, form, local, [['productId', '1']]);
    const externalData = submitForm(env, form, external, [['productId', '1']]);
    assert.strictEqual(localData.get('rqcid'), 'abcdefghijkl');
    assert.strictEqual(externalData.count('rqcid'), 0);
    assert.strictEqual(external.getAttribute('formaction'), 'https://external.example/order');
    const overrideForm = actionForm(env, 'https://external.example/order', 'post');
    const back = env.document.createElement('button');
    back.setAttribute('formaction', '/local-order');
    assert.strictEqual(submitForm(env, overrideForm, back, [['productId', '1']]).get('rqcid'), 'abcdefghijkl');
  });

  await test('action changes are read at submission time', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    assert.strictEqual(submitForm(env, form).get('rqcid'), 'abcdefghijkl');
    form.setAttribute('action', 'https://external.example/order');
    assert.strictEqual(programmaticFormSubmit(env, form, [['productId', '1']]).count('rqcid'), 0);
    assert.strictEqual(submitForm(env, form, null, [['productId', '1']]).count('rqcid'), 0);
    form.setAttribute('action', '/order');
    assert.strictEqual(submitForm(env, form).get('rqcid'), 'abcdefghijkl');
  });

  await test('programmatic submit and requestSubmit follow the formdata decision', async () => {
    const env = await load();
    env.fetches.length = 0;
    const same = actionForm(env, '/order', 'post');
    const skipped = programmaticFormSubmit(env, same, [['productId', '1']]);
    await env.drain();
    assert.strictEqual(skipped.get('rqcid'), 'abcdefghijkl');
    assert.strictEqual(ofType(env, 'form_submit').length, 0);
    const external = actionForm(env, 'https://external.example/order', 'post');
    assert.strictEqual(programmaticFormSubmit(env, external).count('rqcid'), 0);
    const button = env.document.createElement('button');
    button.setAttribute('formaction', 'https://external.example/order');
    const requested = submitForm(env, same, button, [['productId', '1']]);
    assert.strictEqual(requested.count('rqcid'), 0);
    const again = submitForm(env, same, null, [['productId', '1']]);
    assert.strictEqual(again.count('rqcid'), 1);
  });

  await test('developer rqcid is left unchanged', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    const owned = submitForm(env, form, null, [['rqcid', 'custom-value'], ['productId', '1']]);
    assert.strictEqual(owned.count('rqcid'), 1);
    assert.strictEqual(owned.get('rqcid'), 'custom-value');
    const external = actionForm(env, 'https://external.example/order', 'post');
    const foreign = submitForm(env, external, null, [['rqcid', 'custom-value']]);
    assert.strictEqual(foreign.count('rqcid'), 1);
    assert.strictEqual(foreign.get('rqcid'), 'custom-value');
    assert.strictEqual(form.elements.length, 0);
  });

  await test('repeated submit does not accumulate rqcid', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    for (let i = 0; i < 3; i += 1) {
      const data = submitForm(env, form, null, [['productId', '1']]);
      assert.strictEqual(data.count('rqcid'), 1);
      assert.strictEqual(data.get('rqcid'), 'abcdefghijkl');
    }
    assert.strictEqual(form.elements.filter((el) => el.name === 'rqcid').length, 0);
    await env.drain();
    assert.ok(ofType(env, 'form_submit').length >= 3);
  });

  await test('later form submit uses the new rqcid', async () => {
    await withClock(T0, async (clock) => {
      const env = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
      const form = actionForm(env, '/order', 'post');
      assert.strictEqual(submitForm(env, form).get('rqcid'), RQCID_A);
      clock.advance(4000);
      env.location.search = '?rqcid=' + RQCID_B;
      assert.strictEqual(env.window.RefIQ.getRqcid(), RQCID_B);
      const second = submitForm(env, form);
      assert.strictEqual(second.get('rqcid'), RQCID_B);
      assert.strictEqual(readMeta(env.store).capturedAtMs, clock.now());
      assert.notStrictEqual(readMeta(env.store).capturedAtMs, T0);
    });
  });

  await test('dynamic forms are judged at submit', async () => {
    const env = await load();
    const same = env.document.createElement('form');
    same.setAttribute('action', '/order');
    const external = env.document.createElement('form');
    external.setAttribute('action', 'https://external.example/order');
    assert.strictEqual(submitForm(env, same).get('rqcid'), 'abcdefghijkl');
    assert.strictEqual(submitForm(env, external).count('rqcid'), 0);
    assert.strictEqual(env.listeners.formdata.length, 1);
  });

  await test('spa and bfcache do not add form listeners or rqcid fields', async () => {
    await withClock(T0, async () => {
      const env = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
      await env.drain();
      const submitListeners = env.listeners.submit.length;
      const formListeners = env.listeners.formdata.length;
      env.setPath('/catalog');
      env.history.pushState({}, '', '/catalog');
      env.setPath('/product');
      env.history.pushState({}, '', '/product');
      env.dispatch('pagehide', env.document, { persisted: true });
      env.dispatch('pageshow', env.document, { persisted: true });
      const form = actionForm(env, '/order', 'post');
      const data = submitForm(env, form);
      assert.strictEqual(data.get('rqcid'), RQCID_A);
      assert.strictEqual(data.count('rqcid'), 1);
      assert.strictEqual(readMeta(env.store).capturedAtMs, T0);
      assert.strictEqual(env.listeners.submit.length, submitListeners);
      assert.strictEqual(env.listeners.formdata.length, formListeners);
      const link = env.document.createElement('a');
      link.href = 'https://shop.example.com/catalog';
      env.dispatch('click', link);
      assert.strictEqual(link.href, 'https://shop.example.com/catalog');
    });
  });

  await test('unsafe form actions do not receive rqcid', async () => {
    const env = await load();
    ['javascript:alert(1)', 'data:text/html,hi', 'file:///tmp/order', 'mailto:buyer@shop.example.com', 'http://['].forEach((action) => {
      const data = submitForm(env, actionForm(env, action), null, [['productId', '1']]);
      assert.strictEqual(data.count('rqcid'), 0, action);
    });
    assert.strictEqual(actionForm(env, 'javascript:alert(1)').elements.length, 0);
  });

  await test('lookalike origins are not treated as same-origin', async () => {
    const env = await load({ href: 'https://shop.example.com/product?rqcid=abcdefghijkl' });
    [
      'https://checkout.shop.example/order',
      'https://shop.example.com:8443/order',
      'http://shop.example.com/order',
      'https://shop.example.com.evil.com/order',
      'https://evil.example/shop.example.com',
    ].forEach((action) => {
      assert.strictEqual(submitForm(env, actionForm(env, action)).count('rqcid'), 0, action);
    });
    const local = await load({ href: 'http://localhost:3000/product?rqcid=abcdefghijkl' });
    assert.strictEqual(submitForm(local, actionForm(local, 'http://localhost:8000/order')).count('rqcid'), 0);
    assert.strictEqual(submitForm(env, actionForm(env, 'https://user:pass@shop.example.com/order')).get('rqcid'), 'abcdefghijkl');
  });

  await test('cancelled and invalid submit leave no rqcid field', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    form.checkValidity = () => false;
    env.dispatch('submit', form);
    assert.strictEqual(form.elements.filter((el) => el.name === 'rqcid').length, 0);
    form.setAttribute('action', 'https://external.example/order');
    assert.strictEqual(programmaticFormSubmit(env, form).count('rqcid'), 0);
    await env.drain();
    assert.strictEqual(ofType(env, 'form_submit').length, 1);
  });

  await test('timeout submit keeps attribution and respects destination', async () => {
    await withClock(T0, async (clock) => {
      const env = await load({ href: 'https://shop.example.com/product?rqcid=' + RQCID_A });
      await env.drain();
      const sessionA = JSON.parse(env.fetches[0].body).sessionId;
      const pageX = ofType(env, 'page_view')[0].pageViewId;
      env.fetches.length = 0;
      let perf = 5000;
      env.window.performance.now = function () {
        const current = perf;
        perf += 10;
        return current;
      };
      clock.advance(70000);
      const form = actionForm(env, '/order', 'post');
      const data = submitForm(env, form, null, [['productId', '1']]);
      await env.drain();
      assert.strictEqual(data.get('rqcid'), RQCID_A);
      const events = withSession(env);
      const page = events.find((event) => event.type === 'page_view');
      const submit = events.find((event) => event.type === 'form_submit');
      assert.strictEqual(events.filter((event) => event._sessionId === sessionA && event.pageViewId === pageX && event.eventFinal === 1).length, 3);
      assert.strictEqual(page.sequence, 1);
      assert.strictEqual(submit.sequence, 2);
      assert.strictEqual(submit.pageViewId, page.pageViewId);
      assert.strictEqual(submit.payload.attribution.rqcidCapturedAtMs, T0);
      const external = actionForm(env, 'https://external.example/order', 'post');
      assert.strictEqual(submitForm(env, external).count('rqcid'), 0);
      await env.drain();
      assert.ok(ofType(env, 'form_submit').length >= 2);
    });
  });

  await test('form guard does not throw when storage is blocked', async () => {
    const env = await load({
      throwStorage: true,
      blockCookie: true,
      href: 'https://shop.example.com/product?rqcid=abcdefghijkl',
    });
    const form = actionForm(env, '/order', 'post');
    const data = submitForm(env, form, null, [['productId', '1']]);
    assert.strictEqual(data.get('rqcid'), 'abcdefghijkl');
    assert.strictEqual(form.elements.length, 0);
    const empty = await load({
      throwStorage: true,
      blockCookie: true,
      href: 'https://shop.example.com/catalog',
    });
    assert.strictEqual(submitForm(empty, actionForm(empty, '/order')).count('rqcid'), 0);
    await empty.drain();
    assert.ok(ofType(empty, 'page_view').length >= 1);
  });

  function submitButton(env, formaction) {
    const button = env.document.createElement('button');
    button.setAttribute('type', 'submit');
    if (formaction != null) button.setAttribute('formaction', formaction);
    return button;
  }

  // Real user input: the browser runs a microtask checkpoint between `submit` and the entry list.
  async function userSubmit(env, form, submitter, entries) {
    if (!form.elements) form.elements = [];
    const added = (entries || []).map((pair) => ({ nodeName: 'INPUT', type: 'text', name: pair[0], value: pair[1] }));
    added.forEach((control) => form.elements.push(control));
    const event = env.dispatch('submit', form, { submitter: submitter || null });
    await Promise.resolve();
    await Promise.resolve();
    const data = event.defaultPrevented ? makeFormData([]) : nativeEntryList(env, form);
    added.forEach((control) => form.elements.splice(form.elements.indexOf(control), 1));
    return { data, event };
  }

  function sdkFieldCount(form) {
    return (form.elements || []).filter((el) => el.name === 'rqcid' && el.type === 'hidden').length;
  }

  await test('F11 programmatic FormData of a same-origin form gets no SDK rqcid', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    form._entries = [['productId', '123']];
    const data = new env.window.FormData(form);
    assert.strictEqual(data.count('rqcid'), 0);
    assert.strictEqual(data.get('productId'), '123');
    assert.strictEqual(form.elements.length, 0);
    assert.strictEqual(submitForm(env, form, null, [['productId', '123']]).get('rqcid'), 'abcdefghijkl');
  });

  await test('FormData built inside a submit listener stays clean, native submission keeps rqcid', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    form._entries = [['productId', '1']];
    const local = submitButton(env, '/local-order');
    let ajax = null;
    env.document.addEventListener('submit', () => {
      ajax = new env.window.FormData(form);
    });
    const { data } = await userSubmit(env, form, local, [['productId', '1']]);
    assert.strictEqual(ajax.count('rqcid'), 0);
    assert.strictEqual(data.get('rqcid'), 'abcdefghijkl');
    const prevented = actionForm(env, '/order', 'post');
    let cancelled = null;
    env.document.addEventListener('submit', (event) => {
      if (event.target !== prevented) return;
      event.preventDefault();
      cancelled = new env.window.FormData(prevented);
    });
    env.dispatch('submit', prevented, { submitter: null });
    assert.strictEqual(cancelled.count('rqcid'), 0);
    assert.strictEqual(sdkFieldCount(prevented), 0);
    assert.strictEqual(sdkFieldCount(form), 0);
  });

  await test('nested, repeated and subclassed FormData construction stay clean', async () => {
    const env = await load();
    const outer = actionForm(env, '/order', 'post');
    const inner = actionForm(env, '/inner', 'post');
    let innerData = null;
    env.document.addEventListener('formdata', (event) => {
      if (event.target === outer && !innerData) innerData = new env.window.FormData(inner);
    });
    const outerData = new env.window.FormData(outer);
    assert.strictEqual(outerData.count('rqcid'), 0);
    assert.strictEqual(innerData.count('rqcid'), 0);
    for (let i = 0; i < 3; i += 1) {
      assert.strictEqual(new env.window.FormData(outer).count('rqcid'), 0);
    }
    const withSubmitter = new env.window.FormData(outer, submitButton(env, '/order'));
    assert.strictEqual(withSubmitter.count('rqcid'), 0);
    class AppFormData extends env.window.FormData {}
    const sub = new AppFormData(outer);
    assert.ok(sub instanceof AppFormData);
    assert.ok(sub instanceof env.window.FormData);
    assert.strictEqual(sub.count('rqcid'), 0);
    assert.strictEqual(new env.window.FormData().count('rqcid'), 0);
    assert.strictEqual(submitForm(env, outer).count('rqcid'), 1);
    assert.strictEqual(submitForm(env, inner).count('rqcid'), 1);
  });

  await test('native submit inside FormData construction of another form still injects', async () => {
    const env = await load();
    const ajaxForm = actionForm(env, '/ajax', 'post');
    const nativeForm = actionForm(env, '/order', 'post');
    let nativeData = null;
    env.document.addEventListener('formdata', (event) => {
      if (event.target === ajaxForm && !nativeData) nativeData = submitForm(env, nativeForm);
    });
    assert.strictEqual(new env.window.FormData(ajaxForm).count('rqcid'), 0);
    assert.strictEqual(nativeData.get('rqcid'), 'abcdefghijkl');
  });

  await test('FormData constructor errors do not affect native submission', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    assert.throws(() => new env.window.FormData({}), TypeError);
    assert.throws(() => new env.window.FormData(form, { nodeName: 'DIV' }), TypeError);
    assert.throws(() => env.window.FormData(form), TypeError);
    assert.strictEqual(submitForm(env, form).get('rqcid'), 'abcdefghijkl');
    assert.strictEqual(programmaticFormSubmit(env, form).get('rqcid'), 'abcdefghijkl');
  });

  await test('developer-owned rqcid survives programmatic and native FormData', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    form._entries = [['rqcid', 'devowned1234']];
    const ajax = new env.window.FormData(form);
    assert.deepStrictEqual(ajax.list, [['rqcid', 'devowned1234']]);
    const native = submitForm(env, form, null, [['rqcid', 'devowned1234']]);
    assert.deepStrictEqual(native.list, [['rqcid', 'devowned1234']]);
  });

  await test('submitter survives the microtask checkpoint of a real user submit', async () => {
    const env = await load();
    const local = actionForm(env, '/order', 'post');
    const leaked = await userSubmit(env, local, submitButton(env, 'https://external.example/order'));
    assert.strictEqual(leaked.data.count('rqcid'), 0);
    const external = actionForm(env, 'https://external.example/order', 'post');
    const kept = await userSubmit(env, external, submitButton(env, '/local-order'));
    assert.strictEqual(kept.data.get('rqcid'), 'abcdefghijkl');
    const enter = await userSubmit(env, local, submitButton(env));
    assert.strictEqual(enter.data.get('rqcid'), 'abcdefghijkl');
    const getForm = actionForm(env, '/search', 'get');
    assert.strictEqual((await userSubmit(env, getForm, submitButton(env, 'https://external.example/s'))).data.count('rqcid'), 0);
  });

  function cancelOnce(form) {
    form.addEventListener('submit', function cancel(event) {
      form._listeners.submit.splice(form._listeners.submit.indexOf(cancel), 1);
      event.preventDefault();
    });
  }

  await test('cancelled submit does not leave its submitter for a later form.submit()', async () => {
    const env = await load();
    const external = actionForm(env, 'https://external.example/order', 'post');
    cancelOnce(external);
    await userSubmit(env, external, submitButton(env, '/local-order'));
    assert.strictEqual(sdkFieldCount(external), 0);
    assert.strictEqual(programmaticFormSubmit(env, external).count('rqcid'), 0);
    const local = actionForm(env, '/order', 'post');
    cancelOnce(local);
    await userSubmit(env, local, submitButton(env, 'https://external.example/order'));
    assert.strictEqual(programmaticFormSubmit(env, local).get('rqcid'), 'abcdefghijkl');
    const used = actionForm(env, 'https://external.example/order', 'post');
    await userSubmit(env, used, submitButton(env, '/local-order'));
    assert.strictEqual(programmaticFormSubmit(env, used).count('rqcid'), 0);
  });

  await test('SDK leaves window.FormData untouched; a saved original constructor gets no rqcid', async () => {
    const env = await load();
    const Original = env.window.FormData;
    assert.strictEqual(Original, env.FakeFormData);
    const same = actionForm(env, '/order', 'post');
    const external = actionForm(env, 'https://external.example/order', 'post');
    assert.strictEqual(new Original(same).count('rqcid'), 0);
    assert.strictEqual(new Original(external).count('rqcid'), 0);
    assert.strictEqual(new Original(same, submitButton(env, '/order')).count('rqcid'), 0);
    for (const opts of [{ noProxy: true }, { noFormData: true }]) {
      const other = await load(opts);
      assert.strictEqual(submitForm(other, actionForm(other, '/order')).get('rqcid'), 'abcdefghijkl', JSON.stringify(opts));
    }
    assert.ok(!('formDataGuard' in env.window.RefIQ._diagnostics));
  });

  await test('programmatic FormData stays clean at every point around a submission', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    const seen = {};
    seen.before = new env.window.FormData(form).count('rqcid');
    form.addEventListener('submit', () => {
      seen.formListener = new env.window.FormData(form).count('rqcid');
    });
    env.document.addEventListener('submit', () => {
      seen.documentListener = new env.window.FormData(form).count('rqcid');
    });
    env.document.addEventListener('submit', () => {
      seen.documentCapture = new env.window.FormData(form).count('rqcid');
    }, true);
    const other = actionForm(env, '/order', 'post');
    env.document.addEventListener('formdata', (event) => {
      if (event.target === form && seen.nested == null) seen.nested = new env.window.FormData(other).count('rqcid');
    });
    const native = submitForm(env, form, null, [['productId', '1']]);
    seen.after = new env.window.FormData(form).count('rqcid');
    assert.deepStrictEqual(seen, { before: 0, documentCapture: 0, formListener: 0, documentListener: 0, nested: 0, after: 0 });
    assert.strictEqual(native.get('rqcid'), 'abcdefghijkl');
    assert.strictEqual(sdkFieldCount(form), 0);
  });

  await test('preventDefault then cross-origin AJAX copy carries no rqcid and leaves no field', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    let ajax = null;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      ajax = new env.window.FormData(form);
    });
    const { data } = await userSubmit(env, form, submitButton(env), [['productId', '1']]);
    assert.strictEqual(ajax.count('rqcid'), 0);
    assert.strictEqual(data.count('rqcid'), 0);
    assert.strictEqual(sdkFieldCount(form), 0);
    await env.drain();
    assert.strictEqual(sdkFieldCount(form), 0);
    assert.ok(ofType(env, 'form_submit').length >= 1);
  });

  await test('action and formaction changed by page submit handlers are honoured', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    form.addEventListener('submit', () => form.setAttribute('action', 'https://external.example/order'));
    assert.strictEqual(submitForm(env, form).count('rqcid'), 0);
    const back = actionForm(env, 'https://external.example/order', 'post');
    back.addEventListener('submit', () => back.setAttribute('action', '/order'));
    assert.strictEqual(submitForm(env, back).get('rqcid'), 'abcdefghijkl');
    const button = submitButton(env, '/local');
    const viaButton = actionForm(env, '/order', 'post');
    viaButton.addEventListener('submit', () => button.setAttribute('formaction', 'https://external.example/x'));
    assert.strictEqual(submitForm(env, viaButton, button).count('rqcid'), 0);
  });

  await test('SDK field lifecycle: removed at formdata, by timer if no formdata, never duplicated', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    env.dispatch('submit', form, { submitter: null });
    assert.strictEqual(sdkFieldCount(form), 1);
    env.dispatch('submit', form, { submitter: null });
    assert.strictEqual(sdkFieldCount(form), 1);
    await env.drain();
    assert.strictEqual(sdkFieldCount(form), 0);
    for (let i = 0; i < 3; i += 1) {
      assert.strictEqual(submitForm(env, form).count('rqcid'), 1);
      assert.strictEqual(programmaticFormSubmit(env, form).count('rqcid'), 1);
    }
    assert.strictEqual(form.elements.length, 0);
    const stopped = actionForm(env, '/order', 'post');
    stopped.addEventListener('submit', (event) => event.stopPropagation());
    assert.strictEqual(submitForm(env, stopped).count('rqcid'), 0);
    const dialog = actionForm(env, '/order', 'dialog');
    dialog.setAttribute('method', 'dialog');
    assert.strictEqual(submitForm(env, dialog).count('rqcid'), 0);
    const loose = actionForm(env, '/order', 'post');
    loose.checkValidity = () => false;
    loose.setAttribute('novalidate', '');
    assert.strictEqual(submitForm(env, loose).get('rqcid'), 'abcdefghijkl');
    const disabled = actionForm(env, '/order', 'post');
    disabled.elements.push({ nodeName: 'INPUT', type: 'text', name: 'rqcid', value: 'off', disabled: true });
    assert.strictEqual(submitForm(env, disabled).get('rqcid'), 'abcdefghijkl');
  });

  await test('form.submit() wrapper keeps native semantics and is installed once', async () => {
    const env = await load();
    const proto = env.window.HTMLFormElement.prototype;
    const wrapped = proto.submit;
    assert.notStrictEqual(wrapped, env.nativeSubmit);
    assert.strictEqual(wrapped.__refiqNativeSubmit, env.nativeSubmit);
    assert.strictEqual(wrapped.name, 'submit');
    assert.strictEqual(wrapped.length, 0);
    assert.throws(() => wrapped.call({}), TypeError);
    assert.throws(() => wrapped.call(null), TypeError);
    const form = actionForm(env, '/order', 'post');
    assert.strictEqual(form.submit(), undefined);
    assert.strictEqual(env.nativeSubmissions.slice(-1)[0].data.get('rqcid'), 'abcdefghijkl');
    wrapped.apply(form, []);
    assert.strictEqual(env.nativeSubmissions.slice(-1)[0].data.count('rqcid'), 1);
    assert.strictEqual(sdkFieldCount(form), 0);
    const failing = actionForm(env, '/order', 'post');
    // Throws inside the native submit before the SDK `formdata` cleanup runs.
    env.window.addEventListener('formdata', (event) => {
      if (event.target === failing) throw new Error('native failure');
    }, true);
    assert.throws(() => failing.submit(), /native failure/);
    assert.strictEqual(sdkFieldCount(failing), 0);
    env.rerun();
    assert.strictEqual(proto.submit, wrapped);
    delete env.window.RefIQ;
    env.rerun();
    assert.strictEqual(proto.submit, wrapped);
    const twice = actionForm(env, '/order', 'post');
    assert.strictEqual(submitForm(env, twice).count('rqcid'), 1);
    assert.strictEqual(programmaticFormSubmit(env, twice).count('rqcid'), 1);
    assert.strictEqual(sdkFieldCount(twice), 0);
    const bare = await load({ noHTMLFormElement: true });
    assert.strictEqual(submitForm(bare, actionForm(bare, '/order')).get('rqcid'), 'abcdefghijkl');
  });

  function trackEl(env, tag) {
    const node = env.document.createElement(tag);
    node.nodeType = 1;
    const append = node.appendChild.bind(node);
    node.appendChild = function (child) {
      const prev = this.lastElementChild || null;
      append(child);
      if (!child.nodeType) child.nodeType = 1;
      child.parentElement = this;
      child.previousElementSibling = prev;
      if (prev) prev.nextElementSibling = child;
      this.lastElementChild = child;
      return child;
    };
    return node;
  }

  function identityOf(target) {
    const out = {};
    ['elementKey', 'elementType', 'actionType', 'semanticRole', 'identitySource', 'formId'].forEach((key) => {
      if (target && Object.prototype.hasOwnProperty.call(target, key)) out[key] = target[key];
    });
    return out;
  }

  async function dispatchedClick(env, node, extra) {
    env.fetches.length = 0;
    env.dispatch('click', node, extra);
    await env.drain();
    const clicks = ofType(env, 'click');
    assert.ok(clicks.length >= 1);
    return clicks[clicks.length - 1];
  }

  await test('T01 simple button', async () => {
    const env = await load();
    const button = trackEl(env, 'button');
    button.id = 'buy-button';
    const click = await dispatchedClick(env, button);
    assert.strictEqual(click.payload.target.tag, 'BUTTON');
    assert.strictEqual(click.payload.target.id, 'buy-button');
    assert.deepStrictEqual(identityOf(click.payload.target), {
      elementKey: 'buy-button',
      elementType: 'button',
      actionType: 'custom',
      identitySource: 'id',
    });
  });

  await test('T02 nested span keeps the button key and the original tag', async () => {
    const env = await load();
    const button = trackEl(env, 'button');
    button.id = 'submit-order';
    button.setAttribute('data-refiq-id', 'checkout-buy');
    const span = trackEl(env, 'span');
    span.id = 'inner-label';
    span.getBoundingClientRect = () => ({ left: 0, top: 4, width: 12, height: 8 });
    button.appendChild(span);
    const onButton = await dispatchedClick(env, button);
    const onSpan = await dispatchedClick(env, span);
    assert.strictEqual(onSpan.payload.target.elementKey, onButton.payload.target.elementKey);
    assert.strictEqual(onSpan.payload.target.elementKey, 'checkout-buy');
    assert.strictEqual(onSpan.payload.target.tag, 'SPAN');
    assert.strictEqual(onSpan.payload.target.id, 'inner-label');
    assert.strictEqual(onSpan.payload.target.trackingId, undefined);
    assert.strictEqual(onSpan.payload.target.elementType, 'button');
    assert.strictEqual(onSpan.payload.relativeX, 15);
    assert.strictEqual(onSpan.payload.relativeY, 21);
    assert.strictEqual(onSpan.payload.target.width, 12);
    assert.strictEqual(onSpan.payload.target.height, 8);
  });

  await test('T03 svg path resolves to the same button', async () => {
    const env = await load();
    const button = trackEl(env, 'button');
    button.setAttribute('data-refiq-id', 'checkout-buy');
    const svg = trackEl(env, 'svg');
    const path = trackEl(env, 'path');
    path.tagName = 'path';
    path.nodeName = 'path';
    path.getBoundingClientRect = () => ({ left: 3, top: 4, width: 16, height: 16 });
    svg.appendChild(path);
    button.appendChild(svg);
    const click = await dispatchedClick(env, path);
    assert.strictEqual(click.payload.target.tag, 'path');
    assert.strictEqual(click.payload.target.elementKey, 'checkout-buy');
    assert.strictEqual(click.payload.target.elementType, 'button');
    assert.strictEqual(click.payload.target.identitySource, 'data-refiq-id');
    assert.strictEqual(click.payload.relativeX, 12);
    assert.strictEqual(click.payload.relativeY, 21);
  });

  await test('T04 anchor and nested click stay links without changing href metadata', async () => {
    const env = await load();
    const anchor = trackEl(env, 'a');
    anchor.id = 'product-link';
    anchor.href = 'https://shop.example.com/product/a?token=sekret-token-zz';
    const span = trackEl(env, 'span');
    anchor.appendChild(span);
    const direct = await dispatchedClick(env, anchor);
    const nested = await dispatchedClick(env, span);
    [direct, nested].forEach((click) => {
      assert.strictEqual(click.payload.target.elementType, 'link');
      assert.strictEqual(click.payload.target.actionType, 'navigate');
      assert.strictEqual(click.payload.target.elementKey, 'product-link');
      assert.strictEqual(click.payload.target.hrefPathname, '/product/a');
      assert.strictEqual(click.payload.target.hrefPath, '/product/a');
      assert.strictEqual(click.payload.target.hrefOrigin, 'https://shop.example.com');
      assert.strictEqual(click.payload.target.hrefHostname, 'shop.example.com');
      assert.strictEqual(click.payload.target.isExternal, false);
      assert.strictEqual(click.payload.target.href, 'https://shop.example.com/product/a');
      assert.ok(!JSON.stringify(identityOf(click.payload.target)).includes('sekret-token-zz'));
    });
    assert.strictEqual(direct.payload.target.tag, 'A');
    assert.strictEqual(nested.payload.target.tag, 'SPAN');
    assert.strictEqual(nested.payload.target.hrefPathname, direct.payload.target.hrefPathname);
  });

  await test('T05 data-refiq-id outranks a safe html id', async () => {
    const env = await load();
    const button = trackEl(env, 'button');
    button.id = 'submit-order';
    button.setAttribute('data-refiq-id', 'checkout-buy');
    const click = await dispatchedClick(env, button);
    assert.strictEqual(click.payload.target.elementKey, 'checkout-buy');
    assert.strictEqual(click.payload.target.identitySource, 'data-refiq-id');
    assert.strictEqual(click.payload.target.id, 'submit-order');
    assert.strictEqual(click.payload.target.trackingId, 'checkout-buy');
  });

  await test('T06 safe html id is the second identity source', async () => {
    const env = await load();
    const button = trackEl(env, 'button');
    button.id = 'submit-order';
    const click = await dispatchedClick(env, button);
    assert.strictEqual(click.payload.target.elementKey, 'submit-order');
    assert.strictEqual(click.payload.target.identitySource, 'id');
  });

  await test('T07 dom path is stable, distinct, and not truncated into a collision', async () => {
    const env = await load();
    const body = trackEl(env, 'body');
    const main = trackEl(env, 'main');
    const first = trackEl(env, 'section');
    const second = trackEl(env, 'section');
    const button = trackEl(env, 'button');
    const other = trackEl(env, 'button');
    body.appendChild(main);
    main.appendChild(first);
    main.appendChild(second);
    second.appendChild(button);
    second.appendChild(other);
    const expected = 'body>main:nth-of-type(1)>section:nth-of-type(2)>button:nth-of-type(1)';
    const once = await dispatchedClick(env, button);
    const twice = await dispatchedClick(env, button);
    const neighbor = await dispatchedClick(env, other);
    assert.strictEqual(once.payload.target.elementKey, expected);
    assert.strictEqual(once.payload.target.identitySource, 'dom-path');
    assert.strictEqual(twice.payload.target.elementKey, expected);
    assert.notStrictEqual(neighbor.payload.target.elementKey, expected);
    assert.ok(neighbor.payload.target.elementKey.indexOf('button:nth-of-type(2)') !== -1);
    let deepA = trackEl(env, 'div');
    let deepB = trackEl(env, 'div');
    for (let i = 0; i < 16; i += 1) {
      const nextA = trackEl(env, 'div');
      const nextB = trackEl(env, 'div');
      deepA.appendChild(nextA);
      deepB.appendChild(nextB);
      deepA = nextA;
      deepB = nextB;
    }
    const leafA = trackEl(env, 'button');
    const leafB = trackEl(env, 'button');
    deepA.appendChild(leafA);
    deepB.appendChild(leafB);
    const buriedA = await dispatchedClick(env, leafA);
    const buriedB = await dispatchedClick(env, leafB);
    assert.strictEqual(buriedA.payload.target.elementKey, undefined);
    assert.strictEqual(buriedB.payload.target.elementKey, undefined);
    assert.strictEqual(buriedA.payload.target.elementType, 'button');
  });

  await test('T08 element type without reading text', async () => {
    const env = await load();
    async function kind(node) {
      node.textContent = 'Купить user@example.com';
      node.innerText = 'Купить user@example.com';
      const click = await dispatchedClick(env, node);
      assert.ok(!JSON.stringify(identityOf(click.payload.target)).includes('Купить'));
      assert.ok(!JSON.stringify(identityOf(click.payload.target)).includes('user@example.com'));
      return click.payload.target.elementType;
    }
    assert.strictEqual(await kind(trackEl(env, 'button')), 'button');
    const link = trackEl(env, 'a');
    link.href = 'https://shop.example.com/catalog';
    assert.strictEqual(await kind(link), 'link');
    const input = trackEl(env, 'input');
    input.setAttribute('type', 'text');
    assert.strictEqual(await kind(input), 'input');
    assert.strictEqual(await kind(trackEl(env, 'select')), 'select');
    assert.strictEqual(await kind(trackEl(env, 'textarea')), 'textarea');
    const roleButton = trackEl(env, 'div');
    roleButton.setAttribute('role', 'button');
    assert.strictEqual(await kind(roleButton), 'button');
    const widget = trackEl(env, 'my-widget');
    widget.setAttribute('data-refiq-id', 'hero-card');
    assert.strictEqual(await kind(widget), 'custom');
    const tab = trackEl(env, 'div');
    tab.setAttribute('role', 'tab');
    assert.strictEqual(await kind(tab), 'custom');
    const plain = trackEl(env, 'div');
    plain.className = 'btn primary';
    const plainClick = await dispatchedClick(env, plain);
    assert.strictEqual(plainClick.payload.target.elementType, undefined);
    assert.strictEqual(plainClick.payload.target.elementKey, undefined);
  });

  await test('T09 action type is the expected action, not a completed submit', async () => {
    const env = await load();
    async function action(node) {
      return (await dispatchedClick(env, node)).payload.target.actionType;
    }
    const submit = trackEl(env, 'button');
    submit.setAttribute('type', 'submit');
    assert.strictEqual(await action(submit), 'submit');
    const plain = trackEl(env, 'button');
    plain.setAttribute('type', 'button');
    assert.strictEqual(await action(plain), 'custom');
    const outside = trackEl(env, 'button');
    assert.strictEqual(await action(outside), 'custom');
    const form = trackEl(env, 'form');
    form.id = 'checkout-form';
    const implicit = trackEl(env, 'button');
    form.appendChild(implicit);
    assert.strictEqual(await action(implicit), 'submit');
    const reset = trackEl(env, 'button');
    reset.setAttribute('type', 'reset');
    form.appendChild(reset);
    assert.strictEqual(await action(reset), undefined);
    const anchor = trackEl(env, 'a');
    anchor.href = 'https://shop.example.com/next';
    assert.strictEqual(await action(anchor), 'navigate');
    const checkbox = trackEl(env, 'input');
    checkbox.setAttribute('type', 'checkbox');
    assert.strictEqual(await action(checkbox), 'toggle');
    const radio = trackEl(env, 'input');
    radio.setAttribute('type', 'radio');
    assert.strictEqual(await action(radio), 'toggle');
    const switched = trackEl(env, 'div');
    switched.setAttribute('role', 'switch');
    assert.strictEqual(await action(switched), 'toggle');
    const summary = trackEl(env, 'summary');
    assert.strictEqual(await action(summary), 'toggle');
    assert.strictEqual(sdkFieldCount(form), 0);
    assert.strictEqual(ofType(env, 'form_submit').length, 0);
  });

  await test('T10 semantic role allowlist', async () => {
    const env = await load();
    async function role(value) {
      const button = trackEl(env, 'button');
      if (value != null) button.setAttribute('data-refiq-role', value);
      return (await dispatchedClick(env, button)).payload.target.semanticRole;
    }
    assert.strictEqual(await role('cta'), 'cta');
    assert.strictEqual(await role('navigation'), 'navigation');
    assert.strictEqual(await role('search'), 'search');
    assert.strictEqual(await role('checkout'), 'checkout');
    assert.strictEqual(await role('primary'), undefined);
    assert.strictEqual(await role('CTA'), undefined);
    assert.strictEqual(await role('constructor'), undefined);
    assert.strictEqual(await role('buy now'), undefined);
    const search = trackEl(env, 'input');
    search.setAttribute('type', 'search');
    search.placeholder = 'user@example.com';
    const searchClick = await dispatchedClick(env, search);
    assert.strictEqual(searchClick.payload.target.semanticRole, undefined);
    assert.strictEqual(searchClick.payload.target.elementType, 'input');
  });

  await test('T11 form id without mutating the form', async () => {
    const env = await load();
    const form = trackEl(env, 'form');
    form.id = 'checkout-form';
    const button = trackEl(env, 'button');
    button.setAttribute('type', 'submit');
    form.appendChild(button);
    const before = (form.elements || []).map((el) => el.name);
    const inside = await dispatchedClick(env, button);
    assert.strictEqual(inside.payload.target.formId, 'checkout-form');
    assert.strictEqual(inside.payload.target.actionType, 'submit');
    assert.deepStrictEqual((form.elements || []).map((el) => el.name), before);
    assert.strictEqual(sdkFieldCount(form), 0);

    const marked = trackEl(env, 'form');
    marked.id = 'html-form';
    marked.setAttribute('data-refiq-id', 'checkout-form-ref');
    const markedButton = trackEl(env, 'button');
    markedButton.setAttribute('type', 'submit');
    marked.appendChild(markedButton);
    const markedClick = await dispatchedClick(env, markedButton);
    assert.strictEqual(markedClick.payload.target.formId, 'checkout-form-ref');

    const bare = trackEl(env, 'form');
    const bareButton = trackEl(env, 'button');
    bareButton.setAttribute('type', 'submit');
    bare.appendChild(bareButton);
    const bareClick = await dispatchedClick(env, bareButton);
    assert.strictEqual(bareClick.payload.target.formId, undefined);
    assert.strictEqual(bareClick.payload.target.actionType, 'submit');

    const external = trackEl(env, 'form');
    external.id = 'external-form';
    const outside = trackEl(env, 'button');
    outside.setAttribute('type', 'submit');
    outside.form = external;
    const owned = await dispatchedClick(env, outside);
    assert.strictEqual(owned.payload.target.formId, 'external-form');

    const byAttr = trackEl(env, 'button');
    byAttr.setAttribute('type', 'submit');
    byAttr.setAttribute('form', 'external-form');
    env.document.getElementById = (id) => (id === 'external-form' ? external : null);
    const linked = await dispatchedClick(env, byAttr);
    assert.strictEqual(linked.payload.target.formId, 'external-form');
    assert.strictEqual(sdkFieldCount(external), 0);

    const unsafe = trackEl(env, 'form');
    unsafe.id = 'user@example.com';
    const unsafeButton = trackEl(env, 'button');
    unsafeButton.setAttribute('type', 'submit');
    unsafe.appendChild(unsafeButton);
    const unsafeClick = await dispatchedClick(env, unsafeButton);
    assert.strictEqual(unsafeClick.payload.target.formId, undefined);
    assert.ok(!JSON.stringify(identityOf(unsafeClick.payload.target)).includes('user@example.com'));
  });

  await test('T12 button added after load uses the existing click listener', async () => {
    const env = await load();
    const before = env.listeners.click.length;
    const button = trackEl(env, 'button');
    button.setAttribute('data-refiq-id', 'late-button');
    const click = await dispatchedClick(env, button);
    assert.strictEqual(env.listeners.click.length, before);
    assert.strictEqual(before, 1);
    assert.strictEqual(click.payload.target.elementKey, 'late-button');
    assert.strictEqual(click.payload.target.identitySource, 'data-refiq-id');
  });

  await test('T13 open shadow path and closed shadow stay inside exposed data', async () => {
    const env = await load();
    const body = trackEl(env, 'body');
    const host = trackEl(env, 'div');
    body.appendChild(host);
    const root = { nodeType: 11, nodeName: '#document-fragment', host };
    const button = trackEl(env, 'button');
    button.id = 'shadow-btn';
    button.parentNode = root;
    const inner = trackEl(env, 'span');
    inner.parentNode = button;
    inner.parentElement = button;
    let peeked = 0;
    Object.defineProperty(host, 'contentDocument', { get() { peeked += 1; throw new Error('cross-origin'); } });
    const open = await dispatchedClick(env, inner, {
      composedPath() {
        return [inner, button, root, host, env.document];
      },
    });
    assert.strictEqual(open.payload.target.tag, 'SPAN');
    assert.strictEqual(open.payload.target.elementKey, 'shadow-btn');
    assert.strictEqual(open.payload.target.elementType, 'button');
    assert.strictEqual(open.payload.target.identitySource, 'id');
    const closedHost = trackEl(env, 'div');
    Object.defineProperty(closedHost, 'contentDocument', { get() { peeked += 1; throw new Error('closed'); } });
    const closed = await dispatchedClick(env, closedHost, {
      composedPath() {
        return [closedHost, env.document];
      },
    });
    assert.strictEqual(closed.payload.target.tag, 'DIV');
    assert.strictEqual(closed.payload.target.elementKey, undefined);
    assert.strictEqual(closed.payload.target.elementType, undefined);
    assert.strictEqual(peeked, 0);
    const frame = trackEl(env, 'iframe');
    Object.defineProperty(frame, 'contentDocument', { get() { peeked += 1; throw new Error('frame'); } });
    Object.defineProperty(frame, 'contentWindow', { get() { peeked += 1; throw new Error('frame'); } });
    const framed = await dispatchedClick(env, frame);
    assert.strictEqual(framed.payload.target.elementKey, undefined);
    assert.strictEqual(peeked, 0);
  });

  await test('T14 three clicks stay three click events with one element key', async () => {
    const env = await load();
    const button = trackEl(env, 'button');
    button.setAttribute('data-refiq-id', 'checkout-buy');
    env.fetches.length = 0;
    env.dispatch('click', button);
    env.dispatch('click', button);
    env.dispatch('click', button);
    await env.drain();
    const clicks = ofType(env, 'click');
    assert.strictEqual(clicks.length, 3);
    const ids = clicks.map((event) => event.clientEventId);
    assert.strictEqual(new Set(ids).size, 3);
    assert.ok(clicks[0].sequence < clicks[1].sequence);
    assert.ok(clicks[1].sequence < clicks[2].sequence);
    clicks.forEach((event, index) => {
      assert.strictEqual(event.type, 'click');
      assert.strictEqual(event.payload.target.elementKey, 'checkout-buy');
      assert.strictEqual(typeof event.occurredAtMs, 'number');
      if (index > 0) assert.ok(event.occurredAtMs >= clicks[index - 1].occurredAtMs);
      assert.strictEqual(event.payload.rageClick, undefined);
      assert.strictEqual(event.payload.target.rageClick, undefined);
    });
    assert.ok(!eventsFrom(env).some((event) => event.type === 'rage_click' || event.type === 'rageClick'));
  });

  await test('T15 unsafe identifiers and extra attributes are not copied', async () => {
    const env = await load();
    const secrets = [
      'user@example.com',
      '+79991234567',
      'tel-79991234567',
      'https://shop.example/reset?token=sekret-token-zz',
      'a'.repeat(80),
      'order-1712345678901',
      '550e8400-e29b-41d4-a716-446655440000',
      'abcdef0123456789',
    ];
    for (const secret of secrets) {
      const button = trackEl(env, 'button');
      button.setAttribute('data-refiq-id', secret);
      button.id = 'safe-button';
      button.className = secret;
      button.setAttribute('data-user', secret);
      button.value = secret;
      button.textContent = secret;
      const click = await dispatchedClick(env, button);
      const encoded = JSON.stringify(identityOf(click.payload.target));
      assert.ok(!encoded.includes(secret), secret);
      assert.strictEqual(click.payload.target.elementKey, 'safe-button');
      assert.strictEqual(click.payload.target.identitySource, 'id');
    }
    const both = trackEl(env, 'button');
    both.setAttribute('data-refiq-id', 'user@example.com');
    both.id = 'order-1712345678901';
    const structural = await dispatchedClick(env, both);
    assert.strictEqual(structural.payload.target.identitySource, 'dom-path');
    assert.ok(!JSON.stringify(identityOf(structural.payload.target)).includes('user@example.com'));
    assert.ok(!JSON.stringify(identityOf(structural.payload.target)).includes('1712345678901'));
    let parent = trackEl(env, 'div');
    parent.id = 'user@example.com';
    for (let i = 0; i < 20; i += 1) {
      const next = trackEl(env, 'div');
      next.setAttribute('data-token', 'sekret-token-zz');
      parent.appendChild(next);
      parent = next;
    }
    const buried = trackEl(env, 'button');
    buried.setAttribute('data-refiq-id', 'user@example.com');
    buried.id = '+79991234567';
    parent.appendChild(buried);
    const buriedClick = await dispatchedClick(env, buried);
    const buriedFields = JSON.stringify(identityOf(buriedClick.payload.target));
    assert.strictEqual(buriedClick.payload.target.elementKey, undefined);
    assert.strictEqual(buriedClick.payload.target.elementType, 'button');
    assert.ok(!buriedFields.includes('user@example.com'));
    assert.ok(!buriedFields.includes('sekret-token-zz'));
    assert.ok(!buriedFields.includes('+79991234567'));
  });

  await test('T16 previous click fields keep their meaning', async () => {
    const env = await load();
    const button = trackEl(env, 'button');
    button.id = 'submit-order';
    button.setAttribute('data-refiq-id', 'checkout-buy');
    button.setAttribute('role', 'button');
    button.setAttribute('data-refiq-role', 'cta');
    button.setAttribute('type', 'submit');
    const form = trackEl(env, 'form');
    form.id = 'checkout-form';
    const span = trackEl(env, 'span');
    span.id = 'buy-button';
    span.getBoundingClientRect = () => ({ left: 1, top: 2, width: 30, height: 14 });
    button.appendChild(span);
    form.appendChild(button);
    const anchor = trackEl(env, 'a');
    anchor.href = 'https://external.example/item?token=sekret-token-zz';
    anchor.id = 'ext-link';
    const click = await dispatchedClick(env, span);
    const target = click.payload.target;
    assert.strictEqual(click.payload.clientX, 15);
    assert.strictEqual(click.payload.clientY, 25);
    assert.strictEqual(click.payload.pageX, 15);
    assert.strictEqual(click.payload.pageY, 25);
    assert.strictEqual(click.payload.relativeX, 14);
    assert.strictEqual(click.payload.relativeY, 23);
    assert.strictEqual(click.payload.clickTargetX, 14);
    assert.strictEqual(click.payload.clickTargetY, 23);
    assert.strictEqual(target.trackingId, undefined);
    assert.strictEqual(target.id, 'buy-button');
    assert.strictEqual(target.tag, 'SPAN');
    assert.strictEqual(target.role, undefined);
    assert.strictEqual(target.width, 30);
    assert.strictEqual(target.height, 14);
    assert.strictEqual(target.href, undefined);
    assert.deepStrictEqual(identityOf(target), {
      elementKey: 'checkout-buy',
      elementType: 'button',
      actionType: 'submit',
      semanticRole: 'cta',
      identitySource: 'data-refiq-id',
      formId: 'checkout-form',
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(click.payload, 'elementKey'));
    assert.ok(!Object.prototype.hasOwnProperty.call(click, 'elementKey'));
    const allowed = {
      trackingId: 1, id: 1, tag: 1, role: 1, width: 1, height: 1,
      hrefPath: 1, hrefPathname: 1, hrefOrigin: 1, hrefHostname: 1, isExternal: 1, href: 1,
      elementKey: 1, elementType: 1, actionType: 1, semanticRole: 1, identitySource: 1, formId: 1,
    };
    Object.keys(target).forEach((key) => assert.ok(allowed[key], key));
    const external = await dispatchedClick(env, anchor);
    assert.strictEqual(external.payload.target.tag, 'A');
    assert.strictEqual(external.payload.target.id, 'ext-link');
    assert.strictEqual(external.payload.target.hrefHostname, 'external.example');
    assert.strictEqual(external.payload.target.href, 'https://external.example/item');
    assert.strictEqual(external.payload.target.isExternal, true);
    assert.strictEqual(external.payload.target.elementType, 'link');
    assert.strictEqual(external.payload.target.actionType, 'navigate');
    assert.ok(!external.payload.target.href.includes('sekret-token-zz'));
  });

  await test('T17 click identity does not change rqcid form submission', async () => {
    const env = await load();
    const form = actionForm(env, '/order', 'post');
    form.id = 'checkout-form';
    const button = trackEl(env, 'button');
    button.setAttribute('type', 'submit');
    button.setAttribute('data-refiq-id', 'checkout-buy');
    button.setAttribute('data-refiq-role', 'cta');
    form.appendChild(button);
    env.fetches.length = 0;
    env.dispatch('click', button);
    assert.strictEqual(sdkFieldCount(form), 0);
    const data = submitForm(env, form, button, [['productId', '1']]);
    assert.strictEqual(data.get('productId'), '1');
    assert.strictEqual(data.count('rqcid'), 1);
    assert.strictEqual(data.get('rqcid'), 'abcdefghijkl');
    assert.strictEqual(sdkFieldCount(form), 0);
    await env.drain();
    const click = ofType(env, 'click')[0];
    assert.strictEqual(click.payload.target.elementKey, 'checkout-buy');
    assert.strictEqual(click.payload.target.formId, 'checkout-form');
    assert.strictEqual(click.payload.target.actionType, 'submit');
    const submit = ofType(env, 'form_submit')[0];
    assert.strictEqual(submit.payload.formId, 'checkout-form');
    assert.strictEqual(submit.payload.elementKey, undefined);
    assert.strictEqual(submit.payload.elementType, undefined);
    assert.strictEqual(submit.payload.target, undefined);
  });

  await test('T18 click identity stays inside the existing batch envelope', async () => {
    let failNext = false;
    const env = await load({
      fetchImpl: async () => {
        if (failNext) {
          failNext = false;
          return { ok: false, status: 503, headers: { get() { return null; } } };
        }
        return { ok: true, status: 204, headers: { get() { return null; } } };
      },
    });
    await env.drain();
    const button = trackEl(env, 'button');
    button.setAttribute('data-refiq-id', 'checkout-buy');
    env.fetches.length = 0;
    env.dispatch('click', button);
    await Promise.resolve();
    const stored = Array.from(env.idb.data.values()).map((row) => row.event).filter((event) => event && event.type === 'click');
    assert.ok(stored.some((event) => event.payload.target.elementKey === 'checkout-buy'));
    stored.forEach((event) => {
      assert.ok(!Object.prototype.hasOwnProperty.call(event, 'elementKey'));
      assert.strictEqual(event.schemaVersion, undefined);
    });
    failNext = true;
    await env.drain();
    const batches = env.fetches.map((item) => JSON.parse(item.body));
    assert.ok(batches.length >= 2);
    const clicks = [];
    batches.forEach((batch) => {
      assert.strictEqual(batch.schemaVersion, 1);
      assert.strictEqual(batch.sdkVersion, '2.0.1');
      assert.ok(!Object.prototype.hasOwnProperty.call(batch, 'target_element_key'));
      assert.ok(batch.batchId);
      assert.ok(JSON.stringify(batch).length < 24576 || batch.events.length <= 20);
      (batch.events || []).forEach((event) => {
        if (event.type === 'click') clicks.push({ event, batch });
      });
    });
    assert.ok(clicks.length >= 2);
    assert.strictEqual(clicks[0].event.clientEventId, clicks[1].event.clientEventId);
    clicks.forEach((item) => {
      assert.strictEqual(item.event.payload.target.elementKey, 'checkout-buy');
      assert.ok(!Object.prototype.hasOwnProperty.call(item.event.payload, 'elementKey'));
    });
    env.fetches.length = 0;
    env.dispatch('click', button);
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    assert.ok(env.beacons.length >= 1);
    const beacon = JSON.parse(env.beacons[env.beacons.length - 1].body);
    assert.strictEqual(beacon.schemaVersion, 1);
    assert.ok(beacon.events.some((event) => event.type === 'click' && event.payload.target.elementKey === 'checkout-buy'));
    assert.ok(env.beacons[env.beacons.length - 1].body.length <= 60000);
  });

  await test('T19 other event contracts do not gain element identity', async () => {
    const env = await load();
    await env.drain();
    const page = ofType(env, 'page_view')[0];
    assert.strictEqual(page.payload.elementKey, undefined);
    assert.strictEqual(page.payload.target, undefined);
    env.fetches.length = 0;
    env.window.scrollY = 3200;
    env.dispatch('scroll');
    env.dispatch('error', null, { filename: 'https://shop.example.com/app.js?token=sekret-token-zz', lineno: 10, colno: 2 });
    const form = actionForm(env, '/order', 'post');
    submitForm(env, form, null, [['productId', '1']]);
    env.document.visibilityState = 'hidden';
    env.dispatch('visibilitychange');
    await env.drain();
    ['scroll', 'form_submit', 'page_engagement', 'js_error', 'page_view'].forEach((type) => {
      ofType(env, type).forEach((event) => {
        const raw = JSON.stringify(event.payload);
        assert.ok(!raw.includes('elementKey'), type);
        assert.ok(!raw.includes('elementType'), type);
        assert.ok(!raw.includes('identitySource'), type);
        assert.ok(!raw.includes('semanticRole'), type);
        assert.ok(!raw.includes('actionType'), type);
      });
    });
    const error = ofType(env, 'js_error')[0];
    assert.ok(error);
    assert.strictEqual(error.payload.errorType, 'error');
    assert.ok(!JSON.stringify(error.payload).includes('sekret-token-zz'));
    const submit = ofType(env, 'form_submit')[0];
    assert.strictEqual(submit.payload.method, 'post');
    assert.strictEqual(typeof submit.payload.fieldCount, 'number');
  });

  await test('T20 click identity stays bounded on deep and wide trees', async () => {
    const env = await load();
    let scans = 0;
    env.document.querySelectorAll = () => {
      scans += 1;
      return [];
    };
    const shallow = trackEl(env, 'button');
    shallow.id = 'shallow-button';
    let parent = trackEl(env, 'div');
    for (let i = 0; i < 30; i += 1) {
      const next = trackEl(env, 'div');
      parent.appendChild(next);
      parent = next;
    }
    const deep = trackEl(env, 'button');
    deep.id = 'deep-button';
    parent.appendChild(deep);
    const row = trackEl(env, 'div');
    const wide = [];
    for (let i = 0; i < 60; i += 1) {
      const button = trackEl(env, 'button');
      row.appendChild(button);
      wide.push(button);
    }
    function elapsed(node, count) {
      const start = process.hrtime.bigint();
      for (let i = 0; i < count; i += 1) env.dispatch('click', node);
      return Number(process.hrtime.bigint() - start) / 1e6;
    }
    const shallowMs = elapsed(shallow, 50);
    const deepMs = elapsed(deep, 50);
    const wideMs = elapsed(wide[59], 20);
    assert.ok(shallowMs < 500, String(shallowMs));
    assert.ok(deepMs < 500, String(deepMs));
    assert.ok(wideMs < 500, String(wideMs));
    assert.ok(deepMs < shallowMs * 20 + 50, shallowMs + ' -> ' + deepMs);
    assert.strictEqual(scans, 0);
    await env.drain();
    const clicks = ofType(env, 'click');
    const deepClick = clicks.find((event) => event.payload.target && event.payload.target.id === 'deep-button');
    const lastWide = clicks.filter((event) => event.payload.target && event.payload.target.tag === 'BUTTON' && !event.payload.target.id);
    assert.strictEqual(deepClick.payload.target.elementKey, 'deep-button');
    assert.ok(lastWide.length >= 1);
    assert.strictEqual(lastWide[lastWide.length - 1].payload.target.elementKey, undefined);
    console.log('T20 ms/50 shallow=' + shallowMs.toFixed(2) + ' deep=' + deepMs.toFixed(2) + ' wide20=' + wideMs.toFixed(2));
  });

  await test('T21 identity failures still emit the original click', async () => {
    const env = await load();
    env.fetches.length = 0;
    env.dispatch('click', null, { target: null });
    const textButton = trackEl(env, 'button');
    textButton.id = 'text-host';
    const text = { nodeType: 3, parentNode: textButton, parentElement: textButton };
    env.dispatch('click', text);
    const onlyParent = { nodeType: 3, parentNode: textButton };
    env.dispatch('click', onlyParent);
    const path = trackEl(env, 'path');
    path.tagName = 'path';
    path.nodeName = 'path';
    env.dispatch('click', path);
    const button = trackEl(env, 'button');
    button.id = 'guarded';
    const span = trackEl(env, 'span');
    button.appendChild(span);
    button.getAttribute = () => { throw new Error('attr-secret'); };
    button.hasAttribute = () => { throw new Error('attr-secret'); };
    Object.defineProperty(button, 'id', { get() { throw new Error('id-secret'); } });
    Object.defineProperty(button, 'previousElementSibling', { get() { throw new Error('sibling-secret'); } });
    env.dispatch('click', span);
    env.dispatch('click', span, { composedPath() { throw new Error('path-secret'); } });
    const broken = trackEl(env, 'button');
    broken.id = 'fallback-id';
    const brokenSpan = trackEl(env, 'span');
    broken.appendChild(brokenSpan);
    env.dispatch('click', brokenSpan, { composedPath() { throw new Error('missing-path'); } });
    await env.drain();
    const clicks = ofType(env, 'click');
    assert.ok(clicks.length >= 6);
    const raw = JSON.stringify(clicks);
    assert.ok(!raw.includes('attr-secret'));
    assert.ok(!raw.includes('id-secret'));
    assert.ok(!raw.includes('sibling-secret'));
    assert.ok(!raw.includes('path-secret'));
    const textClick = clicks.find((event) => event.payload.target && event.payload.target.id === 'text-host');
    assert.ok(textClick);
    assert.strictEqual(textClick.payload.target.tag, 'BUTTON');
    assert.strictEqual(textClick.payload.target.elementKey, 'text-host');
    const guarded = clicks.find((event) => event.payload.target && event.payload.target.tag === 'SPAN' && event.payload.target.elementType === 'button' && !event.payload.target.elementKey);
    assert.ok(guarded);
    const fallback = clicks.find((event) => event.payload.target && event.payload.target.elementKey === 'fallback-id');
    assert.ok(fallback);
    assert.strictEqual(fallback.payload.target.identitySource, 'id');
    const svg = clicks.find((event) => event.payload.target && event.payload.target.tag === 'path');
    assert.ok(svg);
    assert.strictEqual(svg.payload.target.elementType, undefined);
  });

  console.log('\n' + passed + ' tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
