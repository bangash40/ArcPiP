/*
 * ArcPiP — ISOLATED world content script (settings bridge).
 *
 * The MAIN-world script can't use chrome.* APIs, so this script:
 *   1. reads settings from chrome.storage.sync, resolves the per-site rule for
 *      the tab's top-level hostname, and pushes a small, flat config object to
 *      the MAIN world (and again whenever settings change);
 *   2. forwards the MAIN world's per-frame state (armed / playing / in PiP) to
 *      the service worker, which drives the toolbar badge and decides which
 *      frame the manual "Pop out" shortcut should target.
 *
 * Messages travel as CustomEvents on `document` with a JSON string `detail`.
 * The host page can see and forge these events; everything received is
 * shape-checked, and the worst a page can do is mislead ArcPiP about itself.
 */
(() => {
  'use strict';

  if (globalThis.__arcpipBridgeLoaded) return;
  globalThis.__arcpipBridgeLoaded = true;

  const S = globalThis.ArcPiPSettings;
  if (!S) return;

  const EVT_TO_MAIN = 'arcpip:to-main';
  const EVT_TO_ISOLATED = 'arcpip:to-isolated';

  let settings = null;
  let lastStateKey = '';

  function extensionAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
  }

  /** Hostname of the top-level page, so embedded players follow the host site's rule. */
  function topHostname() {
    try {
      if (window.top === window) return location.hostname;
    } catch {}
    try {
      const origins = location.ancestorOrigins;
      if (origins && origins.length) return new URL(origins[origins.length - 1]).hostname;
    } catch {}
    try { return window.top.location.hostname; } catch {}
    return location.hostname;
  }

  function sendToMain(message) {
    try {
      document.dispatchEvent(new CustomEvent(EVT_TO_MAIN, { detail: JSON.stringify(message) }));
    } catch {}
  }

  function pushSettings() {
    if (!settings) return;
    sendToMain({
      type: 'settings',
      settings: {
        active: S.isActiveFor(settings, topHostname()),
        skipBack: settings.skipBack,
        skipForward: settings.skipForward,
        forcePip: settings.forcePip,
        skipAds: settings.skipAds,
        closeOnReturn: settings.closeOnReturn,
        debug: settings.debug,
      },
    });
  }

  function forwardState(state) {
    const key = JSON.stringify(state);
    if (key === lastStateKey || !extensionAlive()) return;
    lastStateKey = key;
    try {
      chrome.runtime.sendMessage({ type: 'arcpip:frame-state', state }).catch(() => {});
    } catch {}
  }

  function readState(msg) {
    const b = (x) => x === true;
    return {
      top: b(msg.top),
      hasVideo: b(msg.hasVideo),
      playing: b(msg.playing),
      armed: b(msg.armed),
      inPip: b(msg.inPip),
      score: Number.isFinite(msg.score) && msg.score >= 0 ? Math.min(msg.score, 1e9) : 0,
    };
  }

  document.addEventListener(EVT_TO_ISOLATED, (e) => {
    try {
      if (typeof e.detail !== 'string' || e.detail.length > 2048) return;
      const msg = JSON.parse(e.detail);
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello') pushSettings();
      else if (msg.type === 'state') forwardState(readState(msg));
      // 'toggle-result' is consumed by the injected toggle function, not here.
    } catch {}
  });

  // When the frame goes away, tell the service worker so it stops targeting it.
  window.addEventListener('pagehide', () => {
    forwardState({ top: window.top === window, hasVideo: false, playing: false, armed: false, inPip: false, score: 0 });
    lastStateKey = '';
  });

  S.load().then((loaded) => {
    settings = loaded;
    pushSettings();
  });

  try {
    S.onChange((next) => {
      settings = next;
      pushSettings();
    });
  } catch {}
})();
