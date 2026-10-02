/*
 * ArcPiP manual toggle, shared by the service worker (Alt+P command) and the
 * popup ("Pop out now").
 *
 * requestPictureInPicture() needs user activation. Chrome grants it to
 * scripts injected by chrome.scripting.executeScript when the call is made
 * while the extension is handling a user gesture (keyboard command, popup
 * click). To keep that gesture, `run()` calls executeScript synchronously,
 * before any await.
 */
(function (root) {
  'use strict';

  /**
   * Injected into the page (ISOLATED world). Must be self-contained: it is
   * serialised by chrome.scripting and has no access to this file's scope.
   */
  function pageToggle(opts) {
    const TO_MAIN = 'arcpip:to-main';
    const TO_ISOLATED = 'arcpip:to-isolated';
    const mode = opts && opts.mode === 'targeted' ? 'targeted' : 'broadcast';
    const forcePip = !!(opts && opts.forcePip);

    function localToggle() {
      if (document.pictureInPictureElement) {
        return document.exitPictureInPicture().then(() => 'exited', () => 'error');
      }
      const vids = Array.from(document.querySelectorAll('video')).filter((v) => {
        const r = v.getBoundingClientRect();
        return v.readyState >= 1 && v.videoWidth > 0 && r.width >= 200 && r.height >= 80;
      });
      if (!vids.length) return Promise.resolve('none');
      const rank = (v) => {
        const r = v.getBoundingClientRect();
        return r.width * r.height * (v.paused ? 1 : 8) * (v.muted ? 1 : 3);
      };
      vids.sort((a, b) => rank(b) - rank(a));
      const v = vids[0];
      if (mode === 'broadcast' && v.paused && window.top !== window) return Promise.resolve('none');
      if (v.disablePictureInPicture) {
        if (!forcePip) return Promise.resolve('disabled');
        v.disablePictureInPicture = false;
        v.removeAttribute('disablepictureinpicture');
      }
      return v.requestPictureInPicture().then(
        () => 'entered',
        (err) => (err && err.name === 'NotAllowedError' ? 'blocked' : 'error'),
      );
    }

    return new Promise((resolve) => {
      const id = 'arcpip-' + Math.random().toString(36).slice(2);
      let acked = false;
      let settled = false;
      let timer = 0;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        document.removeEventListener(TO_ISOLATED, onMessage);
        resolve(result);
      };
      const onMessage = (e) => {
        try {
          if (typeof e.detail !== 'string') return;
          const msg = JSON.parse(e.detail);
          if (!msg || msg.id !== id) return;
          if (msg.type === 'toggle-ack') acked = true;
          else if (msg.type === 'toggle-result' && typeof msg.result === 'string') finish(msg.result);
        } catch { /* ignore */ }
      };
      document.addEventListener(TO_ISOLATED, onMessage);
      try {
        document.dispatchEvent(new CustomEvent(TO_MAIN, { detail: JSON.stringify({ type: 'toggle', id, mode }) }));
      } catch { /* ignore */ }

      if (!acked) {
        // MAIN-world engine isn't running in this frame (e.g. tab opened before
        // install, or a page that blocks it). Do it ourselves, synchronously.
        document.removeEventListener(TO_ISOLATED, onMessage);
        settled = true;
        localToggle().then(resolve, () => resolve('error'));
        return;
      }
      timer = setTimeout(() => finish('timeout'), 4000);
    });
  }

  const PRIORITY = ['entered', 'exited', 'blocked', 'disabled', 'error', 'timeout', 'none'];

  /** Collapses per-frame results into the single most meaningful one. */
  function summarize(results) {
    const values = (results || []).map((r) => r && r.result).filter((r) => typeof r === 'string');
    for (const p of PRIORITY) if (values.includes(p)) return p;
    return 'none';
  }

  /**
   * Toggles PiP in a tab.
   * @param {number} tabId
   * @param {{frameIds?: number[]|null, mode?: 'targeted'|'broadcast', forcePip?: boolean}} target
   * @returns {Promise<string>} 'entered' | 'exited' | 'blocked' | 'disabled' | 'error' | 'timeout' | 'none' | 'unavailable'
   */
  function run(tabId, target) {
    const frameIds = target && Array.isArray(target.frameIds) && target.frameIds.length ? target.frameIds : null;
    let pending;
    try {
      // Synchronous call: keeps the user gesture of the caller.
      pending = chrome.scripting.executeScript({
        target: frameIds ? { tabId, frameIds } : { tabId, allFrames: true },
        func: pageToggle,
        args: [{ mode: frameIds ? (target.mode || 'targeted') : 'broadcast', forcePip: !!(target && target.forcePip) }],
        world: 'ISOLATED',
        injectImmediately: true,
      });
    } catch {
      return Promise.resolve('unavailable');
    }
    return pending.then(summarize, () => 'unavailable');
  }

  const MESSAGES = {
    entered: 'Popped out',
    exited: 'Back in the tab',
    blocked: 'Chrome blocked it — click the page once, then try again',
    disabled: 'This site disables Picture-in-Picture (enable "Force PiP" in settings)',
    error: 'Picture-in-Picture failed on this video',
    timeout: 'No response from the page',
    none: 'No video found on this page',
    unavailable: 'ArcPiP can\'t run on this page',
  };

  root.ArcPiPToggle = Object.freeze({ run, summarize, pageToggle, MESSAGES });
})(globalThis);
