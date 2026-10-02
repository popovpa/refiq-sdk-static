/**
 * RefIQ JS SDK
 *
 * Подключение — в <head>, как можно выше. ID скрипта из кабинета.
 *
 * <script>
 *   (function (window) {
 *     var match = location.href.match(/[?&#]rqcid=([a-z0-9]{12})/);
 *     if (match) {
 *       document.cookie = "rqcid=" + match[1] + ";path=/;max-age=31536000;SameSite=Lax";
 *     }
 *     var queue = (window.RefIQ = window.RefIQ || []);
 *     queue.event = function (name, data) {
 *       queue.push(["event", name, data]);
 *     };
 *   })(window);
 * </script>
 * <script async src="https://refiq.ru/sdk.js" data-site-id="SITE_KEY"></script>
 *
 * До загрузки sdk.js: RefIQ.event("form_submit") ставится в очередь и уходит после load.
 */
(function (window, document) {
  'use strict';

  try {
    boot();
  } catch (e) {}

  function boot() {
    if (window.RefIQ && typeof window.RefIQ.getRqcid === 'function') {
      return;
    }

    var RQCID_RE = /^[a-z0-9]{12}$/;
    var RQCID_IN_HREF = /[?&#]rqcid=([a-z0-9]{12})(?=&|#|$)/;
    var KEY = 'rqcid';
    var EVENTS_URL = '__REFIQ_CS_BACKEND_URL__';
    var COOKIE_MAX_AGE = 31536000;
    var SDK_VERSION = '2.0.0';
    var SCHEMA_VERSION = 1;
    var FLUSH_INTERVAL_MS = 5000;
    var MAX_EVENTS_PER_BATCH = 20;
    var MAX_BATCH_BYTES = 24576;
    var MAX_BEACON_BYTES = 60000;
    var MAX_QUEUE_SIZE = 500;
    var MAX_RETENTION_MS = 604800000;
    var SESSION_TIMEOUT_MS = 1800000;
    var MAX_RETRY = 8;
    var BASE_BACKOFF_MS = 1000;
    var MAX_BACKOFF_MS = 16000;
    var QUERY_ALLOWLIST = {
      rqcid: 1,
      utm_source: 1,
      utm_medium: 1,
      utm_campaign: 1,
      utm_content: 1,
      utm_term: 1,
      yclid: 1,
      gclid: 1,
      fbclid: 1,
      ttclid: 1,
      vkclid: 1,
      vk_click_id: 1,
    };
    function isBlockedKey(key) {
      return key === '__proto__' || key === 'constructor' || key === 'prototype';
    }
    var VID_KEY = '_refiq_vid';
    var SID_KEY = '_refiq_sid';
    var SEQ_KEY = '_refiq_seq';
    var SACT_KEY = '_refiq_sact';
    var ATTR_KEY = '_refiq_attr';
    var CONSENT_KEY = '_refiq_consent';
    var IDB_NAME = 'refiq_cs';
    var IDB_STORE = 'q';
    var IDB_VERSION = 1;
    var SCROLL_MILESTONES = [25, 50, 75, 90, 100];
    var MEDIA_MILESTONES = [25, 50, 75, 100];

    var queued = window.RefIQ;
    var commands = [];
    var stubRqcid = '';
    var siteKey = '';
    var stored = '';
    var bound = false;
    var lastPageViewUrl = '';
    var pendingEvents = [];
    var visitorId = '';
    var sessionId = '';
    var sequence = 0;
    var pageViewId = '';
    var rqcidCapturedAtMs = 0;
    var memoryQueue = [];
    var inflight = false;
    var flushTimer = 0;
    var retryAttempt = 0;
    var retryTimer = 0;
    var idbAvailable = !!(window.indexedDB);
    var consentState = { analytics: 'unknown', updatedAtMs: 0, policyVersion: '' };
    var landingPath = '';
    var landingReferrer = '';
    var firstUtm = null;
    var pageStartedAt = 0;
    var visibleAccum = 0;
    var activeAccum = 0;
    var visibleOn = 0;
    var activeOn = 0;
    var firstInteractionMs = 0;
    var clickCount = 0;
    var scrollCount = 0;
    var maxScrollDepth = 0;
    var scrollMilestones = {};
    var scrollTimes = {};
    var lastScrollY = 0;
    var scrollRaf = 0;
    var engagementSentFor = '';
    var mediaSeen = {};
    var vitals = {};
    var observers = [];

    if (isArray(queued)) {
      commands = queued.slice(0);
      stubRqcid = queued.r || '';
    }

    function isolate(fn) {
      return function () {
        try {
          return fn.apply(this, arguments);
        } catch (e) {}
      };
    }

    function isArray(value) {
      return Object.prototype.toString.call(value) === '[object Array]';
    }

    function now() {
      return Date.now();
    }

    function perfNow() {
      try {
        if (window.performance && typeof window.performance.now === 'function') {
          return window.performance.now();
        }
      } catch (e) {}
      return now();
    }

    function round(value) {
      return Math.round(value);
    }

    function whenIdle(fn, timeout) {
      try {
        if (typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(isolate(fn), { timeout: timeout || 2000 });
          return;
        }
      } catch (e) {}
      setTimeout(isolate(fn), 1);
    }

    function randomId(len) {
      var alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      var out = '';
      var i;
      try {
        if (window.crypto && window.crypto.getRandomValues) {
          var bytes = new Uint8Array(len);
          window.crypto.getRandomValues(bytes);
          for (i = 0; i < len; i++) {
            out += alphabet[bytes[i] % 36];
          }
          return out;
        }
      } catch (e) {}
      for (i = 0; i < len; i++) {
        out += alphabet[Math.floor(Math.random() * 36)];
      }
      return out;
    }

    function readCookieNamed(name) {
      var parts = ('' + document.cookie).split(';');
      var i;
      var part;
      for (i = 0; i < parts.length; i++) {
        part = parts[i].replace(/^\s+/, '');
        if (part.indexOf(name + '=') === 0) {
          return part.substring(name.length + 1);
        }
      }
      return '';
    }

    function writeCookie(name, value, maxAge) {
      var cookie = name + '=' + value + ';path=/;max-age=' + maxAge + ';SameSite=Lax';
      if (window.location.protocol === 'https:') {
        cookie += ';Secure';
      }
      document.cookie = cookie;
    }

    function readStorage(storage, name) {
      try {
        return storage.getItem(name || KEY) || '';
      } catch (e) {
        return '';
      }
    }

    function writeStorage(storage, value, name) {
      try {
        storage.setItem(name || KEY, value);
      } catch (e) {}
    }

    function isRqcid(value) {
      return typeof value === 'string' && RQCID_RE.test(value);
    }

    function readHrefRqcid() {
      var match = ('' + window.location.href).match(RQCID_IN_HREF);
      return match ? match[1] : '';
    }

    function persist(rqcid) {
      if (!isRqcid(rqcid)) {
        return;
      }
      if (stored !== rqcid) {
        rqcidCapturedAtMs = now();
      }
      stored = rqcid;
      writeStorage(window.localStorage, rqcid);
      writeStorage(window.sessionStorage, rqcid);
      var cookie = KEY + '=' + rqcid + ';path=/;max-age=' + COOKIE_MAX_AGE + ';SameSite=Lax';
      if (window.location.protocol === 'https:') {
        cookie += ';Secure';
      }
      document.cookie = cookie;
    }

    function capture() {
      var fromUrl = readHrefRqcid();
      if (isRqcid(fromUrl)) {
        persist(fromUrl);
        return stored;
      }
      if (isRqcid(stubRqcid)) {
        persist(stubRqcid);
        stubRqcid = '';
        return stored;
      }
      if (isRqcid(stored)) {
        persist(stored);
        return stored;
      }
      persist(readCookieNamed(KEY));
      if (stored) {
        return stored;
      }
      persist(readStorage(window.sessionStorage));
      if (stored) {
        return stored;
      }
      persist(readStorage(window.localStorage));
      return stored;
    }

    function findNamedInput(form, name) {
      var inputs = form.getElementsByTagName('input');
      var i;
      for (i = 0; i < inputs.length; i++) {
        if (inputs[i].name === name) {
          return inputs[i];
        }
      }
      return null;
    }

    function ensureFormField(form) {
      if (!stored || !form || !form.appendChild) {
        return;
      }
      var input = findNamedInput(form, KEY);
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = KEY;
        form.appendChild(input);
      }
      input.value = stored;
    }

    function syncForms() {
      if (!stored) {
        return;
      }
      var forms = document.getElementsByTagName('form');
      var i;
      for (i = 0; i < forms.length; i++) {
        ensureFormField(forms[i]);
      }
    }

    function decorateUrl(href) {
      if (!stored || !href) {
        return href;
      }
      try {
        var url = new URL(href, window.location.href);
        if (url.origin !== window.location.origin) {
          return href;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return href;
        }
        if (!isRqcid(url.searchParams.get(KEY))) {
          url.searchParams.set(KEY, stored);
        }
        return url.toString();
      } catch (e) {
        return href;
      }
    }

    function hashRoute() {
      var hash = '';
      try {
        hash = window.location.hash || '';
      } catch (e) {
        return '';
      }
      var q = hash.indexOf('?');
      return q === -1 ? hash : hash.substring(0, q);
    }

    function pageIdentity() {
      return (window.location.pathname || '') + '|' + hashRoute();
    }

    function allowedQuery() {
      var out = {};
      try {
        var params = new URL(window.location.href).searchParams;
        var key;
        for (key in QUERY_ALLOWLIST) {
          if (QUERY_ALLOWLIST[key] && params.get(key)) {
            out[key] = params.get(key);
          }
        }
      } catch (e) {}
      return out;
    }

    function sanitizeReferrer(raw) {
      if (!raw) {
        return null;
      }
      try {
        var url = new URL(raw, window.location.href);
        return {
          origin: url.origin,
          hostname: url.hostname,
          pathname: url.pathname,
        };
      } catch (e) {
        return null;
      }
    }

    function loadJson(storage, name) {
      try {
        var raw = storage.getItem(name);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }

    function saveJson(storage, name, value) {
      try {
        storage.setItem(name, JSON.stringify(value));
      } catch (e) {}
    }

    function ensureVisitor() {
      if (visitorId) {
        return visitorId;
      }
      visitorId = readStorage(window.localStorage, VID_KEY) || readCookieNamed(VID_KEY);
      if (!visitorId) {
        visitorId = randomId(16);
      }
      writeStorage(window.localStorage, visitorId, VID_KEY);
      writeCookie(VID_KEY, visitorId, COOKIE_MAX_AGE);
      return visitorId;
    }

    function ensureSession() {
      var t = now();
      var storedSid = readStorage(window.sessionStorage, SID_KEY);
      var storedSeq = parseInt(readStorage(window.sessionStorage, SEQ_KEY), 10) || 0;
      var lastAct = parseInt(readStorage(window.sessionStorage, SACT_KEY), 10) || 0;
      if (!sessionId) {
        sessionId = storedSid;
        sequence = storedSeq;
      }
      if (!sessionId || (lastAct && t - lastAct > SESSION_TIMEOUT_MS)) {
        sessionId = randomId(16);
        sequence = 0;
        writeStorage(window.sessionStorage, sessionId, SID_KEY);
        writeStorage(window.sessionStorage, '0', SEQ_KEY);
      }
      writeStorage(window.sessionStorage, String(t), SACT_KEY);
      return sessionId;
    }

    function nextSequence() {
      sequence += 1;
      writeStorage(window.sessionStorage, String(sequence), SEQ_KEY);
      return sequence;
    }

    function captureAttribution() {
      capture();
      var query = allowedQuery();
      var attr = loadJson(window.sessionStorage, ATTR_KEY) || {};
      if (!attr.landingPath) {
        attr.landingPath = window.location.pathname || '';
        attr.landingReferrer = sanitizeReferrer(document.referrer);
        landingPath = attr.landingPath;
        landingReferrer = attr.landingReferrer;
      } else {
        landingPath = attr.landingPath;
        landingReferrer = attr.landingReferrer;
      }
      if (!attr.utm) {
        attr.utm = {
          utmSource: query.utm_source || '',
          utmMedium: query.utm_medium || '',
          utmCampaign: query.utm_campaign || '',
          utmContent: query.utm_content || '',
          utmTerm: query.utm_term || '',
          yclid: query.yclid || '',
          gclid: query.gclid || '',
          fbclid: query.fbclid || '',
          ttclid: query.ttclid || '',
          vkClickId: query.vkclid || query.vk_click_id || '',
        };
      }
      firstUtm = attr.utm;
      saveJson(window.sessionStorage, ATTR_KEY, attr);
    }

    function mq(query) {
      try {
        var media = window.matchMedia && window.matchMedia(query);
        if (media && typeof media.matches === 'boolean') {
          return media.matches;
        }
      } catch (e) {}
      return null;
    }

    function collectBrowser() {
      var nav = window.navigator || {};
      var out = {};
      if (nav.userAgent) out.userAgent = nav.userAgent;
      if (nav.language) out.language = nav.language;
      if (nav.languages) out.languages = nav.languages;
      if (nav.platform) out.platform = nav.platform;
      if (nav.vendor) out.vendor = nav.vendor;
      if (typeof nav.cookieEnabled === 'boolean') out.cookieEnabled = nav.cookieEnabled;
      if (typeof nav.webdriver === 'boolean') out.webdriver = nav.webdriver;
      if (typeof nav.pdfViewerEnabled === 'boolean') out.pdfViewerEnabled = nav.pdfViewerEnabled;
      if (nav.hardwareConcurrency) out.hardwareConcurrency = nav.hardwareConcurrency;
      if (nav.deviceMemory) out.deviceMemory = nav.deviceMemory;
      if (typeof nav.maxTouchPoints === 'number') out.maxTouchPoints = nav.maxTouchPoints;
      try {
        if (nav.userAgentData) {
          out.uaBrands = nav.userAgentData.brands;
          out.uaMobile = nav.userAgentData.mobile;
          out.uaPlatform = nav.userAgentData.platform;
        }
      } catch (e) {}
      out.pointer = mq('(pointer: fine)') ? 'fine' : mq('(pointer: coarse)') ? 'coarse' : mq('(pointer: none)') ? 'none' : null;
      out.anyPointer = mq('(any-pointer: fine)') ? 'fine' : mq('(any-pointer: coarse)') ? 'coarse' : mq('(any-pointer: none)') ? 'none' : null;
      out.hover = mq('(hover: hover)') ? 'hover' : mq('(hover: none)') ? 'none' : null;
      out.anyHover = mq('(any-hover: hover)') ? 'hover' : mq('(any-hover: none)') ? 'none' : null;
      out.prefersColorScheme = mq('(prefers-color-scheme: dark)') ? 'dark' : mq('(prefers-color-scheme: light)') ? 'light' : null;
      out.prefersReducedMotion = mq('(prefers-reduced-motion: reduce)');
      out.prefersContrast = mq('(prefers-contrast: more)') ? 'more' : mq('(prefers-contrast: less)') ? 'less' : null;
      out.displayMode = mq('(display-mode: standalone)') ? 'standalone' : mq('(display-mode: fullscreen)') ? 'fullscreen' : mq('(display-mode: minimal-ui)') ? 'minimal-ui' : 'browser';
      return out;
    }

    function collectDevice() {
      var s = window.screen || {};
      var out = {
        screenWidth: s.width,
        screenHeight: s.height,
        availWidth: s.availWidth,
        availHeight: s.availHeight,
        colorDepth: s.colorDepth,
        pixelDepth: s.pixelDepth,
        devicePixelRatio: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
      };
      try {
        if (s.orientation) {
          out.orientationType = s.orientation.type;
          out.orientationAngle = s.orientation.angle;
        }
      } catch (e) {}
      try {
        var vv = window.visualViewport;
        if (vv) {
          out.visualViewport = {
            width: vv.width,
            height: vv.height,
            scale: vv.scale,
            offsetLeft: vv.offsetLeft,
            offsetTop: vv.offsetTop,
          };
        }
      } catch (e) {}
      return out;
    }

    function collectLocale() {
      var nav = window.navigator || {};
      var out = {
        language: nav.language,
        languages: nav.languages,
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      };
      try {
        var opts = Intl.DateTimeFormat().resolvedOptions();
        out.timeZone = opts.timeZone;
        out.calendar = opts.calendar;
        out.numberingSystem = opts.numberingSystem;
        out.locale = opts.locale;
      } catch (e) {}
      return out;
    }

    function collectNetwork() {
      var nav = window.navigator || {};
      var out = {};
      if (typeof nav.onLine === 'boolean') {
        out.onLine = nav.onLine;
      }
      try {
        var c = nav.connection || nav.mozConnection || nav.webkitConnection;
        if (c) {
          if (c.type) out.type = c.type;
          if (c.effectiveType) out.effectiveType = c.effectiveType;
          if (typeof c.downlink === 'number') out.downlink = c.downlink;
          if (typeof c.rtt === 'number') out.rtt = c.rtt;
          if (typeof c.saveData === 'boolean') out.saveData = c.saveData;
        }
      } catch (e) {}
      return out;
    }

    function collectPrivacy() {
      var nav = window.navigator || {};
      return {
        globalPrivacyControl: nav.globalPrivacyControl,
        doNotTrack: nav.doNotTrack,
        consent: consentState.analytics,
        consentUpdatedAtMs: consentState.updatedAtMs || undefined,
        policyVersion: consentState.policyVersion || undefined,
      };
    }

    function collectPage() {
      var loc = window.location;
      var navType = '';
      try {
        var entries = window.performance && window.performance.getEntriesByType && window.performance.getEntriesByType('navigation');
        if (entries && entries[0] && entries[0].type) {
          navType = entries[0].type;
        } else if (window.performance && window.performance.navigation) {
          navType = ['navigate', 'reload', 'back_forward'][window.performance.navigation.type] || '';
        }
      } catch (e) {}
      return {
        origin: loc.origin,
        hostname: loc.hostname,
        pathname: loc.pathname,
        hashRoute: hashRoute(),
        title: document.title || '',
        contentType: document.contentType || '',
        charset: document.characterSet || document.charset || '',
        navigationType: navType,
        historyLength: window.history ? window.history.length : undefined,
        isTopFrame: window.top === window,
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        documentWidth: document.documentElement ? document.documentElement.scrollWidth : undefined,
        documentHeight: document.documentElement ? document.documentElement.scrollHeight : undefined,
      };
    }

    function attributionPayload() {
      var utm = firstUtm || {};
      return {
        rqcid: stored || undefined,
        rqcidCapturedAtMs: stored ? rqcidCapturedAtMs || undefined : undefined,
        utmSource: utm.utmSource || undefined,
        utmMedium: utm.utmMedium || undefined,
        utmCampaign: utm.utmCampaign || undefined,
        utmContent: utm.utmContent || undefined,
        utmTerm: utm.utmTerm || undefined,
        yclid: utm.yclid || undefined,
        gclid: utm.gclid || undefined,
        fbclid: utm.fbclid || undefined,
        ttclid: utm.ttclid || undefined,
        vkClickId: utm.vkClickId || undefined,
        landingPath: landingPath || undefined,
        landingReferrer: landingReferrer || undefined,
      };
    }

    function sanitizeCustomData(value, depth, seen) {
      depth = depth || 0;
      seen = seen || [];
      if (depth > 3) {
        return undefined;
      }
      if (value == null) {
        return value;
      }
      var type = typeof value;
      if (type === 'string') {
        return value.length > 200 ? value.substring(0, 200) : value;
      }
      if (type === 'number' || type === 'boolean') {
        return type === 'number' && !isFinite(value) ? undefined : value;
      }
      if (type === 'function') {
        return undefined;
      }
      if (value.nodeType) {
        return undefined;
      }
      var i;
      for (i = 0; i < seen.length; i++) {
        if (seen[i] === value) {
          return undefined;
        }
      }
      if (isArray(value)) {
        seen.push(value);
        var list = [];
        for (i = 0; i < value.length && i < 20; i++) {
          var item = sanitizeCustomData(value[i], depth + 1, seen);
          if (item !== undefined) {
            list.push(item);
          }
        }
        return list;
      }
      if (type === 'object') {
        seen.push(value);
        var out = {};
        var count = 0;
        var key;
        for (key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) {
            continue;
          }
          if (isBlockedKey(key)) {
            continue;
          }
          if (count >= 20) {
            break;
          }
          var next = sanitizeCustomData(value[key], depth + 1, seen);
          if (next !== undefined) {
            out[key] = next;
            count += 1;
          }
        }
        return out;
      }
      return undefined;
    }

    function analyticsAllowed() {
      return consentState.analytics !== 'denied';
    }

    function createEvent(type, payload) {
      ensureVisitor();
      ensureSession();
      return {
        clientEventId: randomId(20),
        sequence: nextSequence(),
        pageViewId: pageViewId,
        type: type,
        occurredAtMs: now(),
        payload: payload || {},
      };
    }

    function estimateSize(item) {
      try {
        return JSON.stringify(item).length;
      } catch (e) {
        return 0;
      }
    }

    function trimQueue() {
      var cutoff = now() - MAX_RETENTION_MS;
      memoryQueue = memoryQueue.filter(function (item) {
        return item && item.occurredAtMs >= cutoff;
      });
      while (memoryQueue.length > MAX_QUEUE_SIZE) {
        var dropped = memoryQueue.shift();
        idbDelete([dropped.clientEventId]);
      }
    }

    function idbPut(event) {
      if (!idbAvailable) {
        return;
      }
      try {
        var req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'clientEventId' });
          }
        };
        req.onsuccess = function (e) {
          try {
            var db = e.target.result;
            var tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put({
              clientEventId: event.clientEventId,
              occurredAtMs: event.occurredAtMs,
              event: event,
            });
          } catch (err) {}
        };
        req.onerror = function () {
          idbAvailable = false;
        };
      } catch (e) {
        idbAvailable = false;
      }
    }

    function idbDelete(ids) {
      if (!idbAvailable || !ids || !ids.length) {
        return;
      }
      try {
        var req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onsuccess = function (e) {
          try {
            var db = e.target.result;
            var tx = db.transaction(IDB_STORE, 'readwrite');
            var store = tx.objectStore(IDB_STORE);
            var i;
            for (i = 0; i < ids.length; i++) {
              store.delete(ids[i]);
            }
          } catch (err) {}
        };
      } catch (e) {}
    }

    function idbRestore(done) {
      if (!idbAvailable) {
        done();
        return;
      }
      try {
        var req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'clientEventId' });
          }
        };
        req.onsuccess = function (e) {
          try {
            var db = e.target.result;
            var tx = db.transaction(IDB_STORE, 'readonly');
            var getAll = tx.objectStore(IDB_STORE).getAll();
            getAll.onsuccess = function () {
              var rows = getAll.result || [];
              var seen = {};
              var i;
              for (i = 0; i < memoryQueue.length; i++) {
                seen[memoryQueue[i].clientEventId] = 1;
              }
              for (i = 0; i < rows.length; i++) {
                if (rows[i] && rows[i].event && !seen[rows[i].clientEventId]) {
                  memoryQueue.push(rows[i].event);
                }
              }
              trimQueue();
              done();
            };
            getAll.onerror = done;
          } catch (err) {
            done();
          }
        };
        req.onerror = function () {
          idbAvailable = false;
          done();
        };
      } catch (e) {
        idbAvailable = false;
        done();
      }
    }

    function enqueue(event) {
      if (!event || !analyticsAllowed()) {
        return;
      }
      memoryQueue.push(event);
      idbPut(event);
      trimQueue();
      if (memoryQueue.length >= MAX_EVENTS_PER_BATCH || queueBytes() >= MAX_BATCH_BYTES) {
        flush(false);
      } else {
        scheduleFlush();
      }
    }

    function queueBytes() {
      var i;
      var size = 0;
      for (i = 0; i < memoryQueue.length && i < MAX_EVENTS_PER_BATCH; i++) {
        size += estimateSize(memoryQueue[i]);
      }
      return size;
    }

    function scheduleFlush() {
      if (flushTimer || inflight) {
        return;
      }
      var delay = FLUSH_INTERVAL_MS;
      try {
        var conn = window.navigator && (window.navigator.connection || {});
        if (conn.saveData || conn.effectiveType === '2g' || conn.effectiveType === 'slow-2g') {
          delay = FLUSH_INTERVAL_MS * 2;
        }
      } catch (e) {}
      if (document.visibilityState === 'hidden') {
        delay = 0;
      }
      flushTimer = setTimeout(function () {
        flushTimer = 0;
        flush(false);
      }, delay);
    }

    function buildBatch(events) {
      ensureVisitor();
      ensureSession();
      return {
        schemaVersion: SCHEMA_VERSION,
        sdkVersion: SDK_VERSION,
        siteKey: siteKey,
        script_id: siteKey,
        site_id: siteKey,
        visitorId: visitorId,
        sessionId: sessionId,
        sentAtMs: now(),
        context: {
          browser: collectBrowser(),
          device: collectDevice(),
          screen: collectDevice(),
          locale: collectLocale(),
          network: collectNetwork(),
          privacy: collectPrivacy(),
        },
        events: events,
      };
    }

    function takeBatch() {
      var events = [];
      var size = 256;
      while (memoryQueue.length && events.length < MAX_EVENTS_PER_BATCH) {
        var next = memoryQueue[0];
        var nextSize = estimateSize(next);
        if (events.length && size + nextSize > MAX_BATCH_BYTES) {
          break;
        }
        events.push(memoryQueue.shift());
        size += nextSize;
      }
      return events;
    }

    function restoreBatch(events) {
      memoryQueue = events.concat(memoryQueue);
    }

    function backoffMs(attempt) {
      var exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempt - 1)));
      return round(exp / 2 + Math.random() * exp / 2);
    }

    function postJson(body, onDone) {
      if (typeof window.fetch === 'function') {
        window
          .fetch(EVENTS_URL, {
            method: 'POST',
            body: body,
            credentials: 'omit',
            mode: 'cors',
          })
          .then(function (res) {
            onDone(null, res);
          })
          .catch(function (err) {
            onDone(err);
          });
        return;
      }
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', EVENTS_URL, true);
        xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        xhr.onload = function () {
          onDone(null, { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, headers: { get: function () { return xhr.getResponseHeader('Retry-After'); } } });
        };
        xhr.onerror = function () {
          onDone(new Error('network'));
        };
        xhr.send(body);
      } catch (e) {
        onDone(e);
      }
    }

    function flush(useBeacon) {
      if (inflight || !siteKey || !memoryQueue.length || !analyticsAllowed()) {
        return;
      }
      var events = takeBatch();
      if (!events.length) {
        return;
      }
      var batch = buildBatch(events);
      var body;
      try {
        body = JSON.stringify(batch);
      } catch (e) {
        restoreBatch(events);
        return;
      }
      if (useBeacon) {
        try {
          if (navigator.sendBeacon && body.length <= MAX_BEACON_BYTES) {
            navigator.sendBeacon(EVENTS_URL, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
          }
        } catch (e) {}
        restoreBatch(events);
        scheduleFlush();
        return;
      }
      inflight = true;
      postJson(body, isolate(function (err, res) {
        inflight = false;
        if (!err && res && res.ok) {
          retryAttempt = 0;
          var ids = [];
          var i;
          for (i = 0; i < events.length; i++) {
            ids.push(events[i].clientEventId);
          }
          idbDelete(ids);
          if (memoryQueue.length) {
            scheduleFlush();
          }
          return;
        }
        var status = res && res.status;
        if (status && status >= 400 && status < 500 && status !== 429) {
          var drop = [];
          var d;
          for (d = 0; d < events.length; d++) {
            drop.push(events[d].clientEventId);
          }
          idbDelete(drop);
          return;
        }
        restoreBatch(events);
        retryAttempt += 1;
        var wait = backoffMs(Math.min(retryAttempt, 5));
        if (status === 429 && res && res.headers && res.headers.get) {
          var after = parseInt(res.headers.get('Retry-After'), 10);
          if (after > 0) {
            wait = after * 1000;
          }
        }
        if (retryAttempt > MAX_RETRY) {
          wait = MAX_BACKOFF_MS * 4;
        }
        retryTimer = setTimeout(function () {
          retryTimer = 0;
          flush(false);
        }, wait);
      }));
    }

    function emit(type, payload) {
      if (!siteKey) {
        pendingEvents.push([type, payload]);
        return;
      }
      enqueue(createEvent(type, payload));
    }

    function flushPendingEvents() {
      var queuedEvents = pendingEvents;
      var i;
      pendingEvents = [];
      for (i = 0; i < queuedEvents.length; i++) {
        emit(queuedEvents[i][0], queuedEvents[i][1]);
      }
    }

    function resetPageState() {
      pageStartedAt = perfNow();
      visibleAccum = 0;
      activeAccum = 0;
      visibleOn = document.visibilityState !== 'hidden' ? pageStartedAt : 0;
      activeOn = isActive() ? pageStartedAt : 0;
      firstInteractionMs = 0;
      clickCount = 0;
      scrollCount = 0;
      maxScrollDepth = 0;
      scrollMilestones = {};
      scrollTimes = {};
      lastScrollY = window.scrollY || 0;
      engagementSentFor = '';
      vitals = {};
    }

    function isActive() {
      try {
        return document.visibilityState !== 'hidden' && (!document.hasFocus || document.hasFocus());
      } catch (e) {
        return document.visibilityState !== 'hidden';
      }
    }

    function tickEngagement() {
      var t = perfNow();
      if (visibleOn) {
        visibleAccum += t - visibleOn;
        visibleOn = document.visibilityState !== 'hidden' ? t : 0;
      } else if (document.visibilityState !== 'hidden') {
        visibleOn = t;
      }
      if (activeOn) {
        activeAccum += t - activeOn;
        activeOn = isActive() ? t : 0;
      } else if (isActive()) {
        activeOn = t;
      }
    }

    function markInteraction() {
      if (!firstInteractionMs) {
        firstInteractionMs = round(perfNow() - pageStartedAt);
      }
    }

    function engagementPayload() {
      tickEngagement();
      return {
        totalDurationMs: round(perfNow() - pageStartedAt),
        visibleDurationMs: round(visibleAccum),
        activeDurationMs: round(activeAccum),
        timeToFirstInteractionMs: firstInteractionMs || undefined,
        clickCount: clickCount,
        scrollCount: scrollCount,
        maxScrollDepth: maxScrollDepth,
      };
    }

    function finalizePage() {
      if (!pageViewId || engagementSentFor === pageViewId) {
        return;
      }
      engagementSentFor = pageViewId;
      emit('page_engagement', engagementPayload());
      emitPagePerformance();
      emitResourceSummary();
    }

    function sendPageView() {
      if (!siteKey) {
        return;
      }
      var key = pageIdentity();
      if (key === lastPageViewUrl) {
        return;
      }
      if (lastPageViewUrl) {
        finalizePage();
      }
      lastPageViewUrl = key;
      pageViewId = randomId(16);
      resetPageState();
      captureAttribution();
      emit('page_view', {
        page: collectPage(),
        query: allowedQuery(),
        attribution: attributionPayload(),
      });
      whenIdle(function () {
        emitPagePerformance();
        emitResourceSummary();
      }, 3000);
    }

    function navTiming() {
      try {
        var perf = window.performance;
        if (!perf) {
          return null;
        }
        var nav = perf.getEntriesByType && perf.getEntriesByType('navigation');
        var n = nav && nav[0];
        if (n) {
          return {
            navigationType: n.type,
            redirectCount: n.redirectCount,
            redirectMs: round(n.redirectEnd - n.redirectStart),
            dnsMs: round(n.domainLookupEnd - n.domainLookupStart),
            tcpMs: round(n.connectEnd - n.connectStart),
            tlsMs: n.secureConnectionStart ? round(n.connectEnd - n.secureConnectionStart) : 0,
            ttfbMs: round(n.responseStart - n.requestStart),
            responseMs: round(n.responseEnd - n.responseStart),
            domInteractiveMs: round(n.domInteractive),
            domContentLoadedMs: round(n.domContentLoadedEventEnd),
            loadMs: round(n.loadEventEnd),
            nextHopProtocol: n.nextHopProtocol,
            transferSize: n.transferSize,
            encodedBodySize: n.encodedBodySize,
            decodedBodySize: n.decodedBodySize,
          };
        }
        var t = perf.timing;
        if (!t || !t.navigationStart) {
          return null;
        }
        var start = t.navigationStart;
        return {
          navigationType: perf.navigation ? ['navigate', 'reload', 'back_forward'][perf.navigation.type] : undefined,
          redirectCount: perf.navigation ? perf.navigation.redirectCount : undefined,
          redirectMs: t.redirectEnd - t.redirectStart,
          dnsMs: t.domainLookupEnd - t.domainLookupStart,
          tcpMs: t.connectEnd - t.connectStart,
          tlsMs: t.secureConnectionStart ? t.connectEnd - t.secureConnectionStart : 0,
          ttfbMs: t.responseStart - t.requestStart,
          responseMs: t.responseEnd - t.responseStart,
          domInteractiveMs: t.domInteractive - start,
          domContentLoadedMs: t.domContentLoadedEventEnd - start,
          loadMs: t.loadEventEnd - start,
        };
      } catch (e) {
        return null;
      }
    }

    function emitPagePerformance() {
      var timing = navTiming();
      emit('page_performance', {
        navigation: timing || undefined,
        webVitals: vitals,
      });
    }

    function emitResourceSummary() {
      try {
        var perf = window.performance;
        if (!perf || !perf.getEntriesByType) {
          return;
        }
        var list = perf.getEntriesByType('resource') || [];
        var i;
        var summary = {
          resourceCount: list.length,
          scriptCount: 0,
          imageCount: 0,
          xhrFetchCount: 0,
          stylesheetCount: 0,
          fontCount: 0,
          mediaCount: 0,
          transferBytes: 0,
          slowestResourceMs: 0,
        };
        for (i = 0; i < list.length; i++) {
          var item = list[i];
          var type = item.initiatorType;
          if (type === 'script') summary.scriptCount += 1;
          else if (type === 'img' || type === 'image' || type === 'css') {
            if (type === 'css') summary.stylesheetCount += 1;
            else summary.imageCount += 1;
          } else if (type === 'xmlhttprequest' || type === 'fetch') summary.xhrFetchCount += 1;
          else if (type === 'link' || type === 'css') summary.stylesheetCount += 1;
          else if (type === 'font') summary.fontCount += 1;
          else if (type === 'video' || type === 'audio') summary.mediaCount += 1;
          if (item.transferSize) summary.transferBytes += item.transferSize;
          if (item.duration > summary.slowestResourceMs) summary.slowestResourceMs = round(item.duration);
        }
        emit('resource_summary', summary);
      } catch (e) {}
    }

    function observeVitals() {
      if (!window.PerformanceObserver) {
        return;
      }
      function observe(type, fn) {
        try {
          var obs = new window.PerformanceObserver(isolate(function (list) {
            var entries = list.getEntries();
            var i;
            for (i = 0; i < entries.length; i++) {
              fn(entries[i]);
            }
          }));
          obs.observe({ type: type, buffered: true });
          observers.push(obs);
        } catch (e) {}
      }
      observe('paint', function (entry) {
        if (entry.name === 'first-paint') vitals.fp = round(entry.startTime);
        if (entry.name === 'first-contentful-paint') vitals.fcp = round(entry.startTime);
      });
      observe('largest-contentful-paint', function (entry) {
        vitals.lcp = round(entry.startTime);
      });
      observe('layout-shift', function (entry) {
        if (!entry.hadRecentInput) {
          vitals.cls = round(((vitals.cls || 0) + entry.value) * 1000) / 1000;
        }
      });
      observe('event', function (entry) {
        var delay = (entry.processingStart && entry.startTime != null) ? entry.duration : entry.duration;
        if (typeof delay === 'number') {
          if (vitals.inp == null || delay > vitals.inp) {
            vitals.inp = round(delay);
          }
        }
      });
      observe('first-input', function (entry) {
        if (vitals.inp == null) {
          vitals.inp = round(entry.processingStart - entry.startTime);
        }
      });
    }

    function targetMeta(node) {
      if (!node || !node.getAttribute) {
        return null;
      }
      var hrefPath;
      try {
        if (node.href) {
          hrefPath = new URL(node.href, window.location.href).pathname;
        }
      } catch (e) {}
      var rect = null;
      try {
        if (node.getBoundingClientRect) {
          rect = node.getBoundingClientRect();
        }
      } catch (e) {}
      return {
        trackingId: node.getAttribute('data-refiq-id') || undefined,
        id: node.id || undefined,
        tag: node.tagName || undefined,
        role: node.getAttribute('role') || undefined,
        hrefPath: hrefPath,
        width: rect ? round(rect.width) : undefined,
        height: rect ? round(rect.height) : undefined,
      };
    }

    function onClick(event) {
      var node = event.target;
      var link = node;
      while (link && link.nodeName !== 'A') {
        link = link.parentNode;
      }
      capture();
      if (link && link.href && !link.getAttribute('download') && stored) {
        link.href = decorateUrl(link.href);
      }
      markInteraction();
      clickCount += 1;
      var rect = null;
      try {
        if (node && node.getBoundingClientRect) {
          rect = node.getBoundingClientRect();
        }
      } catch (e) {}
      var payload = {
        clientX: event.clientX,
        clientY: event.clientY,
        pageX: event.pageX,
        pageY: event.pageY,
        relativeX: rect ? event.clientX - rect.left : undefined,
        relativeY: rect ? event.clientY - rect.top : undefined,
        button: event.button,
        pointerType: event.pointerType,
        ctrlKey: !!event.ctrlKey,
        shiftKey: !!event.shiftKey,
        altKey: !!event.altKey,
        metaKey: !!event.metaKey,
        target: targetMeta(node && (node.nodeType === 1 || node.tagName) ? node : node && node.parentElement),
      };
      if (typeof event.pressure === 'number') payload.pressure = event.pressure;
      if (typeof event.width === 'number') payload.width = event.width;
      if (typeof event.height === 'number') payload.height = event.height;
      if (typeof event.isPrimary === 'boolean') payload.isPrimary = event.isPrimary;
      emit('click', payload);
    }

    function onSubmit(event) {
      var form = event.target;
      if (!form || form.nodeName !== 'FORM') {
        return;
      }
      capture();
      ensureFormField(form);
      markInteraction();
      var fields = 0;
      try {
        fields = form.elements ? form.elements.length : 0;
      } catch (e) {}
      emit('form_submit', {
        formId: (form.getAttribute && (form.getAttribute('data-refiq-id') || form.id)) || undefined,
        fieldCount: fields,
        valid: form.checkValidity ? !!form.checkValidity() : undefined,
        method: (form.method || 'get').toLowerCase(),
      });
    }

    function measureScroll() {
      var el = document.documentElement;
      var body = document.body;
      var scrollY = window.scrollY || (el && el.scrollTop) || 0;
      var scrollX = window.scrollX || (el && el.scrollLeft) || 0;
      var viewportHeight = window.innerHeight || (el && el.clientHeight) || 0;
      var documentHeight = Math.max(
        el ? el.scrollHeight : 0,
        body ? body.scrollHeight : 0,
        el ? el.offsetHeight : 0
      );
      var depth = documentHeight ? Math.min(100, round(((scrollY + viewportHeight) / documentHeight) * 100)) : 0;
      if (depth > maxScrollDepth) {
        maxScrollDepth = depth;
      }
      var direction = scrollY > lastScrollY ? 'down' : scrollY < lastScrollY ? 'up' : 'none';
      lastScrollY = scrollY;
      scrollCount += 1;
      var i;
      for (i = 0; i < SCROLL_MILESTONES.length; i++) {
        var mark = SCROLL_MILESTONES[i];
        if (depth >= mark && !scrollMilestones[mark]) {
          scrollMilestones[mark] = 1;
          scrollTimes['timeTo' + mark + 'Ms'] = round(perfNow() - pageStartedAt);
          var payload = {
            scrollX: scrollX,
            scrollY: scrollY,
            documentHeight: documentHeight,
            viewportHeight: viewportHeight,
            depth: depth,
            maxDepth: maxScrollDepth,
            direction: direction,
            milestone: mark,
            timeTo25Ms: scrollTimes.timeTo25Ms,
            timeTo50Ms: scrollTimes.timeTo50Ms,
            timeTo75Ms: scrollTimes.timeTo75Ms,
            timeTo90Ms: scrollTimes.timeTo90Ms,
          };
          emit('scroll', payload);
        }
      }
    }

    function onScroll() {
      if (scrollRaf) {
        return;
      }
      scrollRaf = (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(
        isolate(function () {
          scrollRaf = 0;
          measureScroll();
        })
      );
    }

    function mediaId(el) {
      return (el.getAttribute && (el.getAttribute('data-refiq-id') || el.id)) || undefined;
    }

    function mediaPosition(el) {
      var duration = el.duration;
      var current = el.currentTime;
      var percent = duration && isFinite(duration) ? round((current / duration) * 100) : undefined;
      return {
        mediaId: mediaId(el),
        positionSeconds: isFinite(current) ? round(current * 1000) / 1000 : undefined,
        durationSeconds: duration && isFinite(duration) ? round(duration * 1000) / 1000 : undefined,
        percent: percent,
      };
    }

    function onMedia(event) {
      var el = event.target;
      if (!el || !el.tagName || (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO')) {
        return;
      }
      var action = event.type;
      var data = mediaPosition(el);
      data.action = action;
      emit('media', data);
      if (action === 'timeupdate' && data.percent != null) {
        var key = (data.mediaId || 'anon') + ':' + pageViewId;
        var seen = mediaSeen[key] || {};
        var i;
        for (i = 0; i < MEDIA_MILESTONES.length; i++) {
          var mark = MEDIA_MILESTONES[i];
          if (data.percent >= mark && !seen[mark]) {
            seen[mark] = 1;
            emit('media', {
              mediaId: data.mediaId,
              action: 'progress',
              positionSeconds: data.positionSeconds,
              durationSeconds: data.durationSeconds,
              percent: mark,
            });
          }
        }
        mediaSeen[key] = seen;
      }
    }

    function normalizeScriptPath(filename) {
      if (!filename) {
        return '';
      }
      try {
        return new URL(filename, window.location.href).pathname;
      } catch (e) {
        return String(filename).split('?')[0];
      }
    }

    function errorFingerprint(type, path, line, column) {
      return [type || 'error', path || '', line || 0, column || 0].join(':');
    }

    function onWindowError(event) {
      var path = normalizeScriptPath(event.filename || (event.error && event.error.fileName));
      emit('js_error', {
        errorType: 'error',
        errorFingerprint: errorFingerprint('error', path, event.lineno, event.colno),
        scriptPath: path || undefined,
        line: event.lineno,
        column: event.colno,
      });
    }

    function onUnhandled(event) {
      emit('js_error', {
        errorType: 'unhandledrejection',
        errorFingerprint: errorFingerprint('unhandledrejection', '', 0, 0),
      });
    }

    function onVisibility() {
      tickEngagement();
      if (document.visibilityState === 'hidden') {
        finalizePage();
        flush(true);
      } else {
        visibleOn = perfNow();
        if (isActive()) {
          activeOn = visibleOn;
        }
        engagementSentFor = '';
      }
    }

    function onPageHide() {
      tickEngagement();
      finalizePage();
      flush(true);
    }

    function wrapHistory(method) {
      var original = window.history && window.history[method];
      if (typeof original !== 'function') {
        return;
      }
      window.history[method] = function () {
        var result = original.apply(this, arguments);
        capture();
        syncForms();
        sendPageView();
        return result;
      };
    }

    function observeForms() {
      if (!window.MutationObserver) {
        return;
      }
      try {
        var obs = new window.MutationObserver(isolate(function (mutations) {
          var i;
          var j;
          for (i = 0; i < mutations.length; i++) {
            var added = mutations[i].addedNodes || [];
            for (j = 0; j < added.length; j++) {
              var node = added[j];
              if (!node) continue;
              if (node.nodeName === 'FORM') {
                ensureFormField(node);
              } else if (node.getElementsByTagName) {
                var forms = node.getElementsByTagName('form');
                var k;
                for (k = 0; k < forms.length; k++) {
                  ensureFormField(forms[k]);
                }
              }
            }
          }
        }));
        obs.observe(document.documentElement || document, { childList: true, subtree: true });
        observers.push(obs);
      } catch (e) {}
    }

    function paramFromSrc(src, name) {
      var query = (src.split('?')[1] || '').split('#')[0];
      var pairs = query.split('&');
      var i;
      var pair;
      for (i = 0; i < pairs.length; i++) {
        pair = pairs[i].split('=');
        if (decodeURIComponent(pair[0] || '') === name) {
          try {
            return decodeURIComponent(pair[1] || '');
          } catch (e) {
            return pair[1] || '';
          }
        }
      }
      return '';
    }

    function readScriptIdFromTag() {
      var el = document.currentScript;
      var list;
      var i;
      var src;
      if (!el) {
        list = document.getElementsByTagName('script');
        for (i = list.length - 1; i >= 0; i--) {
          src = list[i].getAttribute('src') || '';
          if (src.indexOf('sdk.js') !== -1) {
            el = list[i];
            break;
          }
        }
      }
      if (!el) {
        return '';
      }
      return (
        el.getAttribute('data-site-id') ||
        el.getAttribute('data-id') ||
        el.getAttribute('data-refiq-id') ||
        paramFromSrc(el.getAttribute('src') || '', 'site-id') ||
        paramFromSrc(el.getAttribute('src') || '', 'id') ||
        ''
      );
    }

    function setSiteKey(value) {
      if (value) {
        siteKey = String(value);
      }
    }

    function init(options) {
      options = options || {};
      setSiteKey(options.siteKey || options.id || options.siteId || options.site_id);
      capture();
      captureAttribution();
      ensureVisitor();
      ensureSession();
      bind();
      syncForms();
      flushPendingEvents();
      sendPageView();
    }

    function bind() {
      if (bound) {
        return;
      }
      bound = true;
      document.addEventListener('click', isolate(onClick), true);
      document.addEventListener('submit', isolate(onSubmit), true);
      document.addEventListener('scroll', isolate(onScroll), { capture: true, passive: true });
      document.addEventListener('play', isolate(onMedia), true);
      document.addEventListener('pause', isolate(onMedia), true);
      document.addEventListener('ended', isolate(onMedia), true);
      document.addEventListener('seeked', isolate(onMedia), true);
      document.addEventListener('timeupdate', isolate(onMedia), true);
      window.addEventListener('popstate', isolate(function () {
        capture();
        syncForms();
        sendPageView();
      }));
      window.addEventListener('hashchange', isolate(function () {
        capture();
        syncForms();
        sendPageView();
      }));
      window.addEventListener('pageshow', isolate(function () {
        capture();
        syncForms();
        tickEngagement();
      }));
      window.addEventListener('pagehide', isolate(onPageHide));
      document.addEventListener('visibilitychange', isolate(onVisibility));
      window.addEventListener('focus', isolate(tickEngagement));
      window.addEventListener('blur', isolate(tickEngagement));
      window.addEventListener('error', isolate(onWindowError));
      window.addEventListener('unhandledrejection', isolate(onUnhandled));
      wrapHistory('pushState');
      wrapHistory('replaceState');
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', isolate(syncForms));
      }
      observeForms();
      observeVitals();
    }

    function getRqcid() {
      capture();
      return stored || null;
    }

    function event(name, extra) {
      if (!name) {
        return;
      }
      var custom = extra && typeof extra === 'object' ? sanitizeCustomData(extra) : undefined;
      if (custom) {
        try {
          var serialized = JSON.stringify(custom);
          if (serialized && serialized.length > 2048) {
            custom = { truncated: true };
          }
        } catch (e) {
          custom = undefined;
        }
      }
      emit(String(name), { custom: custom });
    }

    function consent(options) {
      options = options || {};
      if (options.analytics === 'granted' || options.analytics === 'denied' || options.analytics === 'unknown') {
        consentState.analytics = options.analytics;
      }
      consentState.updatedAtMs = now();
      if (options.policyVersion) {
        consentState.policyVersion = String(options.policyVersion);
      }
      saveJson(window.localStorage, CONSENT_KEY, consentState);
    }

    function push(command) {
      var name;
      var args;
      if (!command) {
        return;
      }
      if (typeof command === 'function') {
        command(api);
        return;
      }
      if (!isArray(command)) {
        return;
      }
      name = command[0];
      args = command.slice(1);
      if (name === 'init') {
        init(args[0] || {});
        return;
      }
      if (typeof api[name] === 'function') {
        api[name].apply(api, args);
      }
    }

    var savedConsent = loadJson(window.localStorage, CONSENT_KEY);
    if (savedConsent && savedConsent.analytics) {
      consentState = savedConsent;
    }

    var api = {
      init: init,
      getRqcid: getRqcid,
      event: event,
      consent: consent,
      push: push,
      l: 1,
    };

    capture();
    window.RefIQ = api;

    var i;
    var command;
    for (i = 0; i < commands.length; i++) {
      command = commands[i];
      if (isArray(command) && command[0] === 'init') {
        push(command);
      }
    }

    if (!siteKey) {
      siteKey = readScriptIdFromTag();
    }

    bind();
    syncForms();
    captureAttribution();
    ensureVisitor();
    ensureSession();

    for (i = 0; i < commands.length; i++) {
      command = commands[i];
      if (!(isArray(command) && command[0] === 'init')) {
        push(command);
      }
    }

    flushPendingEvents();
    if (siteKey) {
      sendPageView();
    }

    idbRestore(function () {
      if (siteKey && memoryQueue.length) {
        scheduleFlush();
      }
    });
  }
})(window, document);
