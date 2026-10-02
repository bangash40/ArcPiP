/*
 * ArcPiP shared settings: defaults, migration and per-site rule helpers.
 *
 * Classic script (not an ES module) so the same file can be loaded by the
 * service worker (importScripts), the popup/options pages (<script>) and the
 * ISOLATED-world content script (manifest "js" list). It exposes a single
 * global, `ArcPiPSettings`, in whichever context loads it. In a content
 * script that global lives in the extension's isolated world and is never
 * visible to the host page.
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'settings';
  const CURRENT_VERSION = 1;

  const SKIP_MIN = 1;
  const SKIP_MAX = 300;

  /** @type {Readonly<ArcPiPSettingsObject>} */
  const DEFAULTS = Object.freeze({
    version: CURRENT_VERSION,
    enabled: true,
    skipBack: 10,
    skipForward: 30,
    // 'allow': every site is enabled unless blocked (blocklist mode).
    // 'block': only explicitly allowed sites are enabled (allowlist mode).
    defaultSitePolicy: 'allow',
    // { [hostname]: 'allow' | 'block' }
    siteRules: Object.freeze({}),
    forcePip: false,
    skipAds: true,
    closeOnReturn: true,
    debug: false,
  });

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function bool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  /**
   * Lower-cases a hostname and strips a leading "www." so that rules for
   * "youtube.com" and "www.youtube.com" are the same rule.
   * Returns '' for anything that is not a plausible hostname.
   */
  function normalizeHost(host) {
    if (typeof host !== 'string') return '';
    let h = host.trim().toLowerCase();
    // Accept pasted URLs as well as bare hostnames.
    if (h.includes('://')) {
      try { h = new URL(h).hostname; } catch { return ''; }
    }
    h = h.replace(/^\*\./, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
    if (h.startsWith('www.')) h = h.slice(4);
    if (!/^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/.test(h) || h.length > 253) return '';
    return h;
  }

  function sanitizeRules(rules) {
    const out = {};
    if (!rules || typeof rules !== 'object') return out;
    for (const [rawHost, rule] of Object.entries(rules)) {
      const host = normalizeHost(rawHost);
      if (host && (rule === 'allow' || rule === 'block')) out[host] = rule;
    }
    return out;
  }

  /**
   * Turns whatever is in storage (missing, partial, older version, garbage)
   * into a complete, valid settings object. Never throws.
   */
  function migrate(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    // Version-specific upgrades go here, e.g.:
    // if ((src.version | 0) < 2) { ...rename fields... }
    return {
      version: CURRENT_VERSION,
      enabled: bool(src.enabled, DEFAULTS.enabled),
      skipBack: clampInt(src.skipBack, SKIP_MIN, SKIP_MAX, DEFAULTS.skipBack),
      skipForward: clampInt(src.skipForward, SKIP_MIN, SKIP_MAX, DEFAULTS.skipForward),
      defaultSitePolicy: src.defaultSitePolicy === 'block' ? 'block' : 'allow',
      siteRules: sanitizeRules(src.siteRules),
      forcePip: bool(src.forcePip, DEFAULTS.forcePip),
      skipAds: bool(src.skipAds, DEFAULTS.skipAds),
      closeOnReturn: bool(src.closeOnReturn, DEFAULTS.closeOnReturn),
      debug: bool(src.debug, DEFAULTS.debug),
    };
  }

  /**
   * Finds the most specific rule for a host: "music.youtube.com" checks
   * "music.youtube.com", then "youtube.com". Returns {host, rule} or null.
   */
  function findRule(settings, host) {
    const h = normalizeHost(host);
    if (!h) return null;
    const rules = settings.siteRules || {};
    const parts = h.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join('.');
      if (Object.prototype.hasOwnProperty.call(rules, candidate)) {
        return { host: candidate, rule: rules[candidate] };
      }
    }
    if (Object.prototype.hasOwnProperty.call(rules, h)) return { host: h, rule: rules[h] };
    return null;
  }

  /** Is ArcPiP active on this site (ignores the global switch)? */
  function isSiteEnabled(settings, host) {
    const match = findRule(settings, host);
    if (match) return match.rule === 'allow';
    return settings.defaultSitePolicy !== 'block';
  }

  /** Is ArcPiP active on this site, taking the global switch into account? */
  function isActiveFor(settings, host) {
    return !!settings.enabled && isSiteEnabled(settings, host);
  }

  /**
   * Returns a new settings object where `host` is enabled/disabled.
   * If the desired state equals the default policy, the explicit rule is
   * removed instead of stored, which keeps the sync payload small.
   */
  function withSiteEnabled(settings, host, enabled) {
    const h = normalizeHost(host);
    const next = migrate(settings);
    if (!h) return next;
    const rules = { ...next.siteRules };
    delete rules[h];
    const inherited = isSiteEnabled({ ...next, siteRules: rules }, h);
    if (inherited !== enabled) rules[h] = enabled ? 'allow' : 'block';
    next.siteRules = rules;
    return next;
  }

  // ---- chrome.storage helpers (only usable where chrome.storage exists) ----

  async function load() {
    try {
      const data = await chrome.storage.sync.get(STORAGE_KEY);
      return migrate(data && data[STORAGE_KEY]);
    } catch {
      return migrate(null);
    }
  }

  async function save(settings) {
    const clean = migrate(settings);
    await chrome.storage.sync.set({ [STORAGE_KEY]: clean });
    return clean;
  }

  async function update(patch) {
    const current = await load();
    const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
    return save(next);
  }

  /** Calls `callback(settings)` whenever the stored settings change. */
  function onChange(callback) {
    const listener = (changes, area) => {
      if (area === 'sync' && changes[STORAGE_KEY]) {
        callback(migrate(changes[STORAGE_KEY].newValue));
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  root.ArcPiPSettings = Object.freeze({
    STORAGE_KEY,
    CURRENT_VERSION,
    DEFAULTS,
    SKIP_MIN,
    SKIP_MAX,
    normalizeHost,
    migrate,
    findRule,
    isSiteEnabled,
    isActiveFor,
    withSiteEnabled,
    load,
    save,
    update,
    onChange,
  });
})(globalThis);
