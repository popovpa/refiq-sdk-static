const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const JavaScriptObfuscator = require('javascript-obfuscator');

const PLACEHOLDER = '__REFIQ_CS_BACKEND_URL__';

const root = __dirname;
const sourcePath = path.join(root, 'sdk.js');
const outDir = path.join(root, 'dist');
const outPath = path.join(outDir, 'sdk.js');

function clickstreamUrl() {
  const raw = (process.env.REFIQ_CS_BACKEND_URL || '').trim();
  if (!raw) {
    throw new Error('REFIQ_CS_BACKEND_URL is required, e.g. REFIQ_CS_BACKEND_URL=https://events.refiq.ru/event npm run build');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    throw new Error('REFIQ_CS_BACKEND_URL must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('REFIQ_CS_BACKEND_URL must be an http(s) URL');
  }
  return raw.replace(/\/+$/, '') + (parsed.pathname === '/' ? '/event' : '');
}

const eventsUrl = clickstreamUrl();
let source = fs.readFileSync(sourcePath, 'utf8');
if (source.indexOf("'" + PLACEHOLDER + "'") === -1) {
  throw new Error('sdk.js is missing ' + PLACEHOLDER);
}
source = source.split("'" + PLACEHOLDER + "'").join(JSON.stringify(eventsUrl));

const minified = babel.transformSync(source, {
  comments: false,
  compact: true,
  presets: [
    [
      'minify',
      {
        builtIns: false,
        evaluate: true,
        mangle: true,
        simplify: true,
      },
    ],
  ],
}).code;

const obfuscated = JavaScriptObfuscator.obfuscate(minified, {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  reservedNames: ['^RefIQ$', '^getRqcid$', '^init$', '^push$', '^event$', '^consent$', '^l$'],
  reservedStrings: ['rqcid', 'RefIQ', 'getRqcid', 'page_view', 'event', 'consent', 'site_id', 'script_id', 'siteKey'],
  selfDefending: false,
  stringArray: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.75,
  target: 'browser',
}).getObfuscatedCode();

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, obfuscated);
console.log('built ' + path.relative(root, outPath) + ' (' + Buffer.byteLength(obfuscated) + ' bytes)');
console.log('clickstream ' + eventsUrl);
