/*
 * ArcPiP — MAIN world content script.
 *
 * Runs in the page's own JavaScript world (manifest "world": "MAIN") because
 * Media Session action handlers must be registered from the page context for
 * Chrome's "automatic picture-in-picture for media playback" (Chrome 134+) to
 * call them when the user switches tabs.
 *
 * This script has no access to chrome.* APIs. Settings arrive from the
 * ISOLATED-world bridge (content-bridge.js) as CustomEvents on `document`
 * whose `detail` is a JSON string (objects do not cross worlds reliably).
 *
 * Rules: never throw into the host page, never log unless debug is on, and
 * never touch the site's play/pause/next/previous handlers.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Guard + native captures (taken at document_start, before page scripts run)
  // ---------------------------------------------------------------------------

  const GUARD = Symbol.for('arcpip.main.v1');
  if (window[GUARD]) return;
  try {
    Object.defineProperty(window, GUARD, { value: true });
  } catch {
    return;
  }

  const mediaSession = navigator.mediaSession;
  const MediaSessionProto = typeof MediaSession === 'function' ? MediaSession.prototype : null;
  if (!mediaSession || !MediaSessionProto || typeof HTMLVideoElement !== 'function') return;

  const nativeSetActionHandler = MediaSessionProto.setActionHandler;
  const nativeSetPositionState = MediaSessionProto.setPositionState;
  const nativeRequestPiP = HTMLVideoElement.prototype.requestPictureInPicture;
  const nativeExitPiP = Document.prototype.exitPictureInPicture;
  const pipElementGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'pictureInPictureElement')?.get;
  if (typeof nativeSetActionHandler !== 'function' || typeof nativeRequestPiP !== 'function') return;

  const reflectApply = Reflect.apply;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const CustomEventCtor = CustomEvent;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const addListener = EventTarget.prototype.addEventListener;

  const EVT_TO_MAIN = 'arcpip:to-main';
  const EVT_TO_ISOLATED = 'arcpip:to-isolated';

  const MIN_VIDEO_WIDTH = 200;
  const MIN_VIDEO_HEIGHT = 80;
  const HAVE_METADATA = 1;
  const REAPPLY_INTERVAL_MS = 4000;
  const POSITION_THROTTLE_MS = 1000;
  const SHADOW_SCAN_MIN_INTERVAL_MS = 2000;

  const IS_TOP = (() => {
    try { return window.top === window; } catch { return false; }
  })();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** Settings pushed by the bridge; null until the first message arrives. */
  let cfg = null;

  /** The video the auto-PiP handler will pop out. */
  let activeVideo = null;

  /** The video ArcPiP itself put into PiP (auto handler), so we know to close it. */
  let openedByUs = null;

  /** Whether our handlers are currently installed on navigator.mediaSession. */
  let registered = false;

  /** Handlers the site tried to register for the actions we manage. */
  const siteHandlers = new Map();
  const MANAGED_ACTIONS = ['enterpictureinpicture', 'seekbackward', 'seekforward'];
  /** Actions the browser rejected (unsupported); never retried. */
  const unsupported = new Set();

  const attached = new WeakSet();
  let lastPositionUpdate = 0;
  let lastShadowScan = 0;
  let lastReported = '';
  let refreshTimer = 0;
  let rescanTimer = 0;
  let knownVideoCount = -1;
  let pageHasShadowRoots = false;
  const shadowVideos = new Set();

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function log(...args) {
    if (cfg && cfg.debug) {
      try { console.debug('[ArcPiP]', IS_TOP ? 'top' : 'frame', ...args); } catch {}
    }
  }

  /** Wraps a callback so nothing it throws can ever reach the host page. */
  function safe(fn) {
    return function arcpipSafe(...args) {
      try {
        const result = reflectApply(fn, this, args);
        if (result && typeof result.then === 'function') {
          return result.then(undefined, (err) => { log('async error', err); });
        }
        return result;
      } catch (err) {
        log('error', err);
        return undefined;
      }
    };
  }

  function pipElement() {
    try { return pipElementGetter ? reflectApply(pipElementGetter, document, []) : null; } catch { return null; }
  }

  function sendToIsolated(message) {
    try {
      reflectApply(dispatch, document, [new CustomEventCtor(EVT_TO_ISOLATED, { detail: jsonStringify(message) })]);
    } catch {}
  }

  function isActive() {
    return !!(cfg && cfg.active);
  }

  // ---------------------------------------------------------------------------
  // Video discovery & selection
  // ---------------------------------------------------------------------------

  function collectVideos() {
    const list = [];
    const live = document.getElementsByTagName('video');
    for (let i = 0; i < live.length; i++) list.push(live[i]);
    for (const v of shadowVideos) {
      if (v.isConnected) list.push(v);
      else shadowVideos.delete(v);
    }
    return list;
  }

  /** Finds videos inside open shadow roots (e.g. web-component players). Throttled. */
  function scanShadowRoots(force) {
    const now = Date.now();
    if (!force && now - lastShadowScan < SHADOW_SCAN_MIN_INTERVAL_MS) return;
    lastShadowScan = now;
    const root = document.documentElement;
    if (!root) return;
    const stack = [root];
    let budget = 20000;
    while (stack.length && budget-- > 0) {
      const node = stack.pop();
      const sr = node.shadowRoot;
      if (sr) {
        pageHasShadowRoots = true;
        const vids = sr.querySelectorAll('video');
        for (let i = 0; i < vids.length; i++) shadowVideos.add(vids[i]);
        for (let c = sr.firstElementChild; c; c = c.nextElementSibling) stack.push(c);
      }
      for (let c = node.firstElementChild; c; c = c.nextElementSibling) stack.push(c);
    }
  }

  function isPlaying(v) {
    return !!v && !v.paused && !v.ended && v.readyState > HAVE_METADATA;
  }

  function isAudible(v) {
    return !v.muted && v.volume > 0;
  }

  /** Best-effort ad detection for YouTube / YouTube Music / Twitch. */
  function isAdPlaying(v) {
    try {
      const player = v.closest('.html5-video-player');
      if (player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))) {
        return true;
      }
      if (location.hostname.endsWith('twitch.tv')) {
        return !!document.querySelector('[data-a-target="video-ad-label"],[data-a-target="video-ad-countdown"]');
      }
    } catch {}
    return false;
  }

  /**
   * Scores a video; <= 0 means "not a candidate". Prefers playing, audible,
   * large, on-screen videos and heavily penalises muted looping background
   * videos (hero banners, hover previews).
   */
  function scoreVideo(v) {
    if (!v || !v.isConnected) return 0;
    if (v.readyState < HAVE_METADATA || !v.videoWidth || !v.videoHeight) return 0;
    if (v.disablePictureInPicture && !(cfg && cfg.forcePip)) return 0;

    const r = v.getBoundingClientRect();
    if (r.width < MIN_VIDEO_WIDTH || r.height < MIN_VIDEO_HEIGHT) return 0;

    let hidden = false;
    try {
      const cs = getComputedStyle(v);
      hidden = cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0;
    } catch {}
    if (hidden) return 0;

    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    let score = visW * visH + 0.1 * r.width * r.height;

    const playing = isPlaying(v);
    const audible = isAudible(v);
    if (playing) score *= 8;
    if (audible) score *= 3;
    if (!audible && (v.loop || v.autoplay) && !v.controls) score *= 0.05; // background/preview video
    if (v === activeVideo) score *= 1.25; // hysteresis: avoid flapping between similar videos
    return score;
  }

  function pickBestVideo() {
    let best = null;
    let bestScore = 0;
    for (const v of collectVideos()) {
      let s = 0;
      try { s = scoreVideo(v); } catch {}
      if (s > bestScore) {
        best = v;
        bestScore = s;
      }
    }
    return { video: best, score: bestScore };
  }

  // ---------------------------------------------------------------------------
  // Media Session handlers
  // ---------------------------------------------------------------------------

  function setNativeHandler(action, handler) {
    if (unsupported.has(action)) return false;
    try {
      reflectApply(nativeSetActionHandler, mediaSession, [action, handler]);
      return true;
    } catch {
      // Unsupported action (older Chrome) — remember and move on.
      if (handler) unsupported.add(action);
      return false;
    }
  }

  function delegateToSite(action, details) {
    const h = siteHandlers.get(action);
    if (typeof h === 'function') {
      try { return h.call(mediaSession, details); } catch {}
    }
    return undefined;
  }

  const onEnterPictureInPicture = safe(async function onEnterPictureInPicture(details) {
    log('enterpictureinpicture', details && details.reason);
    if (!isActive()) return delegateToSite('enterpictureinpicture', details);

    let video = activeVideo && activeVideo.isConnected ? activeVideo : null;
    if (!video || !isPlaying(video)) video = pickBestVideo().video;
    if (!video) return delegateToSite('enterpictureinpicture', details);

    // Arc behaviour: a paused video stays put.
    if (!isPlaying(video)) return undefined;
    // Chrome only auto-PiPs audible media for playback. A muted video here means
    // Chrome fired for another reason (e.g. a video call on Meet): let the site
    // handle it with its own handler instead of popping out a muted tile.
    if (!isAudible(video)) return delegateToSite('enterpictureinpicture', details);
    if (cfg.skipAds && isAdPlaying(video)) {
      log('ad playing; not popping out');
      return undefined;
    }
    if (pipElement() === video) return undefined;

    if (video.disablePictureInPicture && cfg.forcePip) {
      video.disablePictureInPicture = false;
      video.removeAttribute('disablepictureinpicture');
    }
    await reflectApply(nativeRequestPiP, video, []);
    openedByUs = video;
    log('entered PiP');
    return undefined;
  });

  function seekBy(deltaSeconds) {
    const v = activeVideo;
    if (!v || !v.isConnected) return false;
    const d = v.duration;
    let t = v.currentTime + deltaSeconds;
    if (Number.isFinite(d)) t = Math.min(t, Math.max(0, d - 0.25));
    v.currentTime = Math.max(0, t);
    updatePositionState(true);
    return true;
  }

  const onSeekBackward = safe(function onSeekBackward(details) {
    if (!isActive() || !seekBy(-cfg.skipBack)) delegateToSite('seekbackward', details);
  });

  const onSeekForward = safe(function onSeekForward(details) {
    if (!isActive() || !seekBy(cfg.skipForward)) delegateToSite('seekforward', details);
  });

  const OUR_HANDLERS = {
    enterpictureinpicture: onEnterPictureInPicture,
    seekbackward: onSeekBackward,
    seekforward: onSeekForward,
  };

  function installHandlers() {
    for (const action of MANAGED_ACTIONS) setNativeHandler(action, OUR_HANDLERS[action]);
    registered = true;
  }

  function uninstallHandlers() {
    if (!registered) return;
    registered = false;
    // Hand control back to whatever the site registered (or clear).
    for (const action of MANAGED_ACTIONS) setNativeHandler(action, siteHandlers.get(action) || null);
  }

  /**
   * Intercept the site's own setActionHandler calls for the three actions we
   * manage, so a site can't silently knock out auto-PiP, and so its handler
   * comes back when ArcPiP is off. All other actions (play, pause, nexttrack,
   * previoustrack, seekto, ...) pass straight through untouched.
   */
  function patchSetActionHandler() {
    const wrapper = {
      setActionHandler(action, handler) {
        if (this === mediaSession && MANAGED_ACTIONS.includes(action)) {
          siteHandlers.set(action, typeof handler === 'function' ? handler : null);
          if (registered && !unsupported.has(action)) return undefined;
        }
        return reflectApply(nativeSetActionHandler, this, arguments);
      },
    }.setActionHandler;
    try {
      Object.defineProperty(MediaSessionProto, 'setActionHandler', {
        value: wrapper,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch {}
  }

  function updatePositionState(force) {
    if (!registered || typeof nativeSetPositionState !== 'function') return;
    const v = activeVideo;
    if (!v) return;
    const now = Date.now();
    if (!force && now - lastPositionUpdate < POSITION_THROTTLE_MS) return;
    lastPositionUpdate = now;
    const duration = v.duration;
    if (!Number.isFinite(duration) || duration <= 0) return; // live streams: no position
    const position = Math.min(Math.max(0, v.currentTime || 0), duration);
    const playbackRate = v.playbackRate > 0 ? v.playbackRate : 1;
    try {
      reflectApply(nativeSetPositionState, mediaSession, [{ duration, playbackRate, position }]);
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Per-video listeners
  // ---------------------------------------------------------------------------

  const onStateEvent = safe(function onStateEvent() { scheduleRefresh(); });

  const onTimeEvent = safe(function onTimeEvent(e) {
    if (e.target === activeVideo) updatePositionState(e.type !== 'timeupdate');
  });

  const onLeavePiP = safe(function onLeavePiP(e) {
    if (e.target === openedByUs) openedByUs = null;
    scheduleRefresh();
  });

  function attach(v) {
    if (attached.has(v)) return;
    attached.add(v);
    const opts = { passive: true };
    for (const t of ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata', 'volumechange', 'enterpictureinpicture']) {
      reflectApply(addListener, v, [t, onStateEvent, opts]);
    }
    for (const t of ['timeupdate', 'durationchange', 'ratechange', 'seeked']) {
      reflectApply(addListener, v, [t, onTimeEvent, opts]);
    }
    reflectApply(addListener, v, ['leavepictureinpicture', onLeavePiP, opts]);
  }

  // ---------------------------------------------------------------------------
  // Refresh: pick the video, (un)register handlers, report state
  // ---------------------------------------------------------------------------

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(refresh, 120);
  }

  const refresh = safe(function refresh() {
    refreshTimer = 0;
    if (!cfg) return;

    const videos = collectVideos();
    for (const v of videos) attach(v);

    const { video, score } = isActive() ? pickBestVideo() : { video: null, score: 0 };
    if (video !== activeVideo) {
      activeVideo = video;
      log('active video ->', video);
    }

    if (isActive() && activeVideo) {
      if (!registered) installHandlers();
      updatePositionState(true);
    } else {
      uninstallHandlers();
    }

    const playing = isPlaying(activeVideo);
    const muted = playing && !isAudible(activeVideo);
    const state = {
      type: 'state',
      top: IS_TOP,
      hasVideo: !!activeVideo,
      playing,
      muted,
      armed: registered && playing && !muted && !unsupported.has('enterpictureinpicture') &&
        !(cfg.skipAds && activeVideo && isAdPlaying(activeVideo)),
      inPip: !!pipElement(),
      score: Math.round(score),
    };
    const key = jsonStringify(state);
    if (key !== lastReported) {
      lastReported = key;
      sendToIsolated(state);
    }
  });

  function scheduleRescan(fullShadowScan) {
    if (rescanTimer) return;
    rescanTimer = setTimeout(safe(() => {
      rescanTimer = 0;
      scanShadowRoots(fullShadowScan);
      refresh();
    }), 400);
  }

  /** Cheap: re-apply our handlers while a video plays, in case a site bypassed the wrapper. */
  const reapply = safe(function reapply() {
    if (registered && isPlaying(activeVideo)) {
      for (const action of MANAGED_ACTIONS) setNativeHandler(action, OUR_HANDLERS[action]);
    }
  });

  // ---------------------------------------------------------------------------
  // Manual toggle (from the toolbar popup / Alt+P via the isolated world)
  // ---------------------------------------------------------------------------

  /**
   * mode 'targeted': this frame was chosen by the extension; use the best video.
   * mode 'broadcast': every frame got the request; only act if this frame has a
   * playing video, or it is the top frame and has any usable video.
   */
  function manualToggle(id, mode) {
    const reply = (result) => sendToIsolated({ type: 'toggle-result', id, result });
    const current = pipElement();
    if (current) {
      if (current === openedByUs) openedByUs = null;
      reflectApply(nativeExitPiP, document, []).then(() => reply('exited'), () => reply('error'));
      return;
    }
    const target = pickBestVideo().video;
    if (!target) {
      reply(hasPipBlockedVideo() ? 'disabled' : 'none');
      return;
    }
    if (mode === 'broadcast' && !isPlaying(target) && !IS_TOP) {
      reply('none');
      return;
    }
    if (target.disablePictureInPicture) {
      // Only reachable when forcePip is on (scoreVideo filters otherwise).
      target.disablePictureInPicture = false;
      target.removeAttribute('disablepictureinpicture');
    }
    // Called synchronously so the user activation granted by the extension applies.
    reflectApply(nativeRequestPiP, target, []).then(
      () => reply('entered'),
      (err) => reply(err && err.name === 'NotAllowedError' ? 'blocked' : 'error'),
    );
  }

  function hasPipBlockedVideo() {
    for (const v of collectVideos()) {
      if (v.disablePictureInPicture && v.videoWidth) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Messages from the isolated-world bridge
  // ---------------------------------------------------------------------------

  function readSettings(s) {
    if (!s || typeof s !== 'object') return null;
    const num = (x, d) => (Number.isFinite(x) && x > 0 && x <= 3600 ? x : d);
    return {
      active: s.active === true,
      skipBack: num(s.skipBack, 10),
      skipForward: num(s.skipForward, 30),
      forcePip: s.forcePip === true,
      skipAds: s.skipAds !== false,
      closeOnReturn: s.closeOnReturn !== false,
      debug: s.debug === true,
    };
  }

  const onBridgeMessage = safe(function onBridgeMessage(e) {
    if (typeof e.detail !== 'string' || e.detail.length > 4096) return;
    let msg;
    try { msg = jsonParse(e.detail); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'settings') {
      const next = readSettings(msg.settings);
      if (!next) return;
      cfg = next;
      lastReported = ''; // a (possibly new) bridge is listening: re-report state
      log('settings', cfg);
      scheduleRescan(true);
      refresh();
    } else if (msg.type === 'toggle' && typeof msg.id === 'string' && msg.id.length < 64) {
      // Synchronous ack tells the injected caller that this engine is present.
      sendToIsolated({ type: 'toggle-ack', id: msg.id });
      manualToggle(msg.id, msg.mode === 'targeted' ? 'targeted' : 'broadcast');
    }
  });

  // ---------------------------------------------------------------------------
  // Return to tab: close the PiP window we opened, keep the video playing
  // ---------------------------------------------------------------------------

  const onVisibilityChange = safe(function onVisibilityChange() {
    scheduleRefresh();
    if (document.visibilityState !== 'visible' || !cfg || !cfg.closeOnReturn) return;
    const el = pipElement();
    if (!el || el !== openedByUs) return;
    const wasPlaying = !el.paused;
    openedByUs = null;
    reflectApply(nativeExitPiP, document, []).then(() => {
      if (wasPlaying && el.paused && el.isConnected) el.play().catch(() => {});
    }, () => {});
  });

  // ---------------------------------------------------------------------------
  // SPA navigation & dynamic content
  // ---------------------------------------------------------------------------

  function onNavigation() {
    activeVideo = null;
    scheduleRescan(true);
  }

  function patchHistory() {
    const proto = History.prototype;
    for (const name of ['pushState', 'replaceState']) {
      const original = proto[name];
      if (typeof original !== 'function') continue;
      const wrapped = {
        [name](...args) {
          const result = reflectApply(original, this, args);
          try { onNavigation(); } catch {}
          return result;
        },
      }[name];
      try {
        Object.defineProperty(proto, name, { value: wrapped, writable: true, configurable: true, enumerable: true });
      } catch {}
    }
  }

  function observeMutations() {
    // The callback does no per-node work: it just debounces a check of the
    // live <video> collection, which keeps it cheap on busy pages (YouTube).
    const observer = new MutationObserver(safe(() => {
      const count = document.getElementsByTagName('video').length;
      const shadowDue = pageHasShadowRoots && Date.now() - lastShadowScan >= SHADOW_SCAN_MIN_INTERVAL_MS;
      if (count !== knownVideoCount || (activeVideo && !activeVideo.isConnected) || shadowDue) {
        knownVideoCount = count;
        scheduleRescan(false);
      }
    }));
    const start = () => {
      try {
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
      } catch {}
    };
    if (document.documentElement) start();
    else reflectApply(addListener, document, ['readystatechange', start, { once: true }]);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  patchSetActionHandler();
  patchHistory();

  reflectApply(addListener, document, [EVT_TO_MAIN, onBridgeMessage]);
  reflectApply(addListener, document, ['visibilitychange', onVisibilityChange]);
  // Media events don't bubble, but capture-phase listeners on document still see
  // them for light-DOM videos, which is how we notice new players instantly.
  reflectApply(addListener, document, ['play', safe((e) => {
    if (e.target instanceof HTMLVideoElement) { attach(e.target); scheduleRefresh(); }
  }), { capture: true, passive: true }]);
  reflectApply(addListener, document, ['loadedmetadata', safe((e) => {
    if (e.target instanceof HTMLVideoElement) { attach(e.target); scheduleRefresh(); }
  }), { capture: true, passive: true }]);
  reflectApply(addListener, window, ['popstate', safe(onNavigation)]);
  reflectApply(addListener, window, ['hashchange', safe(onNavigation)]);
  reflectApply(addListener, document, ['yt-navigate-finish', safe(onNavigation)]);
  reflectApply(addListener, window, ['resize', safe(scheduleRefresh), { passive: true }]);
  reflectApply(addListener, window, ['pageshow', safe(() => {
    lastReported = ''; // the bridge forgot us on pagehide (bfcache); re-report
    scheduleRescan(true);
  })]);
  observeMutations();
  setInterval(reapply, REAPPLY_INTERVAL_MS);

  // Ask the bridge for settings (it may have loaded before or after us).
  sendToIsolated({ type: 'hello' });
})();
