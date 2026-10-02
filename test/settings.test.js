// Unit tests for src/shared/settings.js. Run with: node test/settings.test.js
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

require(path.join(__dirname, '..', 'src', 'shared', 'settings.js'));
const S = globalThis.ArcPiPSettings;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}\n`, err);
    process.exitCode = 1;
  }
}

test('migrate fills defaults from nothing', () => {
  const s = S.migrate(undefined);
  assert.equal(s.version, S.CURRENT_VERSION);
  assert.equal(s.enabled, true);
  assert.equal(s.skipBack, 10);
  assert.equal(s.skipForward, 30);
  assert.equal(s.closeOnReturn, true);
  assert.equal(s.forcePip, false);
  assert.deepEqual(s.siteRules, {});
});

test('migrate clamps and rejects garbage', () => {
  const s = S.migrate({ enabled: 'yes', skipBack: '-5', skipForward: 99999, defaultSitePolicy: 'weird', siteRules: { 'WWW.YouTube.com': 'block', 'bad host!': 'allow', 'vimeo.com': 'maybe' } });
  assert.equal(s.enabled, true);
  assert.equal(s.skipBack, S.SKIP_MIN);
  assert.equal(s.skipForward, S.SKIP_MAX);
  assert.equal(s.defaultSitePolicy, 'allow');
  assert.deepEqual(s.siteRules, { 'youtube.com': 'block' });
});

test('normalizeHost handles URLs, www, ports and wildcards', () => {
  assert.equal(S.normalizeHost('https://www.Vimeo.com/123?x=1'), 'vimeo.com');
  assert.equal(S.normalizeHost('*.twitch.tv'), 'twitch.tv');
  assert.equal(S.normalizeHost('localhost:8080'), 'localhost');
  assert.equal(S.normalizeHost('example.com/path'), 'example.com');
  assert.equal(S.normalizeHost('not a host'), '');
  assert.equal(S.normalizeHost(42), '');
});

test('most specific rule wins', () => {
  const s = S.migrate({ siteRules: { 'youtube.com': 'block', 'music.youtube.com': 'allow' } });
  assert.equal(S.isSiteEnabled(s, 'www.youtube.com'), false);
  assert.equal(S.isSiteEnabled(s, 'm.youtube.com'), false);
  assert.equal(S.isSiteEnabled(s, 'music.youtube.com'), true);
  assert.equal(S.isSiteEnabled(s, 'vimeo.com'), true);
  assert.equal(S.isSiteEnabled(s, 'notyoutube.com'), true);
});

test('allowlist mode only enables allowed sites', () => {
  const s = S.migrate({ defaultSitePolicy: 'block', siteRules: { 'youtube.com': 'allow' } });
  assert.equal(S.isSiteEnabled(s, 'youtube.com'), true);
  assert.equal(S.isSiteEnabled(s, 'vimeo.com'), false);
});

test('global switch overrides site rules', () => {
  const s = S.migrate({ enabled: false, siteRules: { 'youtube.com': 'allow' } });
  assert.equal(S.isActiveFor(s, 'youtube.com'), false);
});

test('withSiteEnabled stores only rules that differ from inherited state', () => {
  let s = S.migrate({});
  s = S.withSiteEnabled(s, 'www.youtube.com', false);
  assert.deepEqual(s.siteRules, { 'youtube.com': 'block' });
  s = S.withSiteEnabled(s, 'youtube.com', true);
  assert.deepEqual(s.siteRules, {});
  s = S.withSiteEnabled(S.migrate({ siteRules: { 'youtube.com': 'block' } }), 'music.youtube.com', true);
  assert.deepEqual(s.siteRules, { 'youtube.com': 'block', 'music.youtube.com': 'allow' });
});

test('defaults object is frozen', () => {
  assert.throws(() => { 'use strict'; S.DEFAULTS.enabled = false; });
});

console.log(`${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
