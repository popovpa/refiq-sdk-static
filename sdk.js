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

  if (window.RefIQ && typeof window.RefIQ.getRqcid === 'function') {
    return;
  }

  var RQCID_RE = /^[a-z0-9]{12}$/;
  var RQCID_IN_HREF = /[?&#]rqcid=([a-z0-9]{12})(?=&|#|$)/;
  var KEY = 'rqcid';
  var EVENTS_URL = '__REFIQ_CS_BACKEND_URL__';
  var COOKIE_MAX_AGE = 31536000;

  var queued = window.RefIQ;
  var commands = [];
  var stubRqcid = '';
  var scriptId = '';
  var stored = '';
  var bound = false;
  var lastPageViewUrl = '';
  var pendingEvents = [];

  if (isArray(queued)) {
    commands = queued.slice(0);
    stubRqcid = queued.r || '';
  }

  function isArray(value) {
    return Object.prototype.toString.call(value) === '[object Array]';
  }

  function isRqcid(value) {
    return typeof value === 'string' && RQCID_RE.test(value);
  }

  function readHrefRqcid() {
    var match = ('' + window.location.href).match(RQCID_IN_HREF);
    return match ? match[1] : '';
  }

  function readCookie() {
    var parts = ('' + document.cookie).split(';');
    var i;
    var part;
    for (i = 0; i < parts.length; i++) {
      part = parts[i].replace(/^\s+/, '');
      if (part.indexOf(KEY + '=') === 0) {
        return part.substring(KEY.length + 1);
      }
    }
    return '';
  }

  function readStorage(storage) {
    try {
      return storage.getItem(KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function writeStorage(storage, value) {
    try {
      storage.setItem(KEY, value);
    } catch (e) {}
  }

  function persist(rqcid) {
    if (!isRqcid(rqcid)) {
      return;
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
    persist(readCookie());
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

  function onClick(event) {
    var node = event.target;
    while (node && node.nodeName !== 'A') {
      node = node.parentNode;
    }
    if (!node || !node.href || node.getAttribute('download')) {
      return;
    }
    capture();
    if (!stored) {
      return;
    }
    node.href = decorateUrl(node.href);
  }

  function onSubmit(event) {
    var form = event.target;
    if (!form || form.nodeName !== 'FORM') {
      return;
    }
    capture();
    ensureFormField(form);
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

  function send(payload) {
    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        if (navigator.sendBeacon(EVENTS_URL, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) {
          return;
        }
      }
    } catch (e) {}
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', EVENTS_URL, true);
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      xhr.send(body);
    } catch (e2) {}
  }

  function sendEvent(name, extra) {
    if (!name) {
      return;
    }
    if (!scriptId) {
      pendingEvents.push([name, extra]);
      return;
    }
    capture();
    var payload = {
      event: String(name),
      script_id: scriptId,
      site_id: scriptId,
      url: window.location.href,
      referrer: document.referrer || '',
    };
    if (stored) {
      payload.rqcid = stored;
    }
    if (extra && typeof extra === 'object') {
      var key;
      for (key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key) && payload[key] == null) {
          payload[key] = extra[key];
        }
      }
    }
    send(payload);
  }

  function flushPendingEvents() {
    var queuedEvents = pendingEvents;
    var i;
    pendingEvents = [];
    for (i = 0; i < queuedEvents.length; i++) {
      sendEvent(queuedEvents[i][0], queuedEvents[i][1]);
    }
  }

  function sendPageView() {
    var url = window.location.href;
    if (!scriptId || url === lastPageViewUrl) {
      return;
    }
    lastPageViewUrl = url;
    sendEvent('page_view');
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

  function init(options) {
    options = options || {};
    if (options.id || options.siteId || options.site_id) {
      scriptId = String(options.id || options.siteId || options.site_id);
    }
    capture();
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
    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    window.addEventListener('popstate', function () {
      capture();
      syncForms();
      sendPageView();
    });
    window.addEventListener('pageshow', function () {
      capture();
      syncForms();
    });
    wrapHistory('pushState');
    wrapHistory('replaceState');
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', syncForms);
    }
  }

  function getRqcid() {
    capture();
    return stored || null;
  }

  function event(name, extra) {
    sendEvent(name, extra);
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

  var api = {
    init: init,
    getRqcid: getRqcid,
    event: event,
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

  if (!scriptId) {
    scriptId = readScriptIdFromTag();
  }

  bind();
  syncForms();

  for (i = 0; i < commands.length; i++) {
    command = commands[i];
    if (!(isArray(command) && command[0] === 'init')) {
      push(command);
    }
  }

  flushPendingEvents();
  if (scriptId) {
    sendPageView();
  }
})(window, document);
