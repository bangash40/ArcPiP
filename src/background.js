/*
 * ArcPiP service worker.
 *
 * - First-install onboarding and settings initialisation
 * - Injects the content scripts into tabs that were already open at install
 * - Tracks per-frame video state reported by the content scripts and shows a
 *   toolbar badge when auto-PiP is armed on a tab
 * - Handles the "toggle-pip" keyboard command (default Alt+P)
 */
'use strict';

importScripts('shared/settings.js', 'shared/pip-toggle.js');

const S = globalThis.ArcPiPSettings;
const T = globalThis.ArcPiPToggle;

const BADGE_TEXT = 'PiP';
const BADGE_COLOR = '#7c5cff';
const SESSION_KEY = 'tabFrames';

/** Settings cache, so the command handler can stay synchronous. */
let settings = S.migrate(null);

/**
 * tabId -> Map(frameId -> {top, hasVideo, playing, armed, inPip, score, documentId})
 * Mirrored to chrome.storage.session so it survives service-worker restarts.
 */
const tabFrames = new Map();
let persistTimer = 0;

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const plain = {};
    for (const [tabId, frames] of tabFrames) plain[tabId] = Object.fromEntries(frames);
    chrome.storage.session.set({ [SESSION_KEY]: plain }).catch(() => {});
  }, 250);
}

const restored = (async () => {
  try {
    const data = await chrome.storage.session.get(SESSION_KEY);
    const plain = (data && data[SESSION_KEY]) || {};
    for (const [tabId, frames] of Object.entries(plain)) {
      const map = new Map();
      for (const [frameId, state] of Object.entries(frames)) map.set(Number(frameId), state);
      if (!tabFrames.has(Number(tabId))) tabFrames.set(Number(tabId), map);
    }
  } catch { /* ignore */ }
  try { settings = await S.load(); } catch { /* keep defaults */ }
})();

S.onChange((next) => {
  settings = next;
  for (const tabId of tabFrames.keys()) updateBadge(tabId);
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function summarizeTab(tabId) {
  const frames = tabFrames.get(tabId);
  const out = { armed: false, playing: false, muted: false, topPlaying: false, hasVideo: false, inPip: false, frames: 0 };
  if (!frames) return out;
  for (const [frameId, s] of frames) {
    out.frames++;
    if (frameId === 0) {
      // Chrome only auto-PiPs media in the top frame.
      if (s.armed) out.armed = true;
      if (s.playing) out.topPlaying = true;
      if (s.muted) out.muted = true;
    }
    if (s.playing) out.playing = true;
    if (s.hasVideo) out.hasVideo = true;
    if (s.inPip) out.inPip = true;
  }
  return out;
}

function updateBadge(tabId) {
  const { armed, inPip } = summarizeTab(tabId);
  const on = settings.enabled && (armed || inPip);
  chrome.action.setBadgeText({ tabId, text: on ? BADGE_TEXT : '' }).catch(() => {});
  chrome.action.setTitle({
    tabId,
    title: on
      ? (inPip ? 'ArcPiP — video is in Picture-in-Picture' : 'ArcPiP — armed: switch tabs to pop the video out')
      : 'ArcPiP',
  }).catch(() => {});
}

function initBadgeStyle() {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Frame selection for the manual toggle
// ---------------------------------------------------------------------------

/**
 * Picks which frame(s) the manual toggle should target, from known state:
 * a frame already in PiP (to exit), else the best frame with a video
 * (playing first, then score). Unknown state -> broadcast to all frames.
 */
function chooseTarget(tabId) {
  const frames = tabFrames.get(tabId);
  const base = { frameIds: null, mode: 'broadcast', forcePip: settings.forcePip };
  if (!frames || frames.size === 0) return base;

  const inPip = [];
  let best = null;
  let bestRank = -1;
  for (const [frameId, s] of frames) {
    if (s.inPip) inPip.push(frameId);
    if (!s.hasVideo) continue;
    const rank = (s.playing ? 1e12 : 0) + (s.score || 0) + (frameId === 0 ? 1 : 0);
    if (rank > bestRank) { bestRank = rank; best = frameId; }
  }
  if (inPip.length) return { ...base, frameIds: inPip, mode: 'targeted' };
  if (best !== null) return { ...base, frameIds: [best], mode: 'targeted' };
  return base;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  initBadgeStyle();
  // Write a complete, migrated settings object (keeps user values on update).
  try { settings = await S.save(await S.load()); } catch { /* ignore */ }

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html?welcome=1') }).catch(() => {});
  }
  if (details.reason === 'install' || details.reason === 'update') {
    injectIntoOpenTabs();
  }
});

chrome.runtime.onStartup.addListener(initBadgeStyle);

/** Content scripts only load on navigation; cover tabs that were already open. */
async function injectIntoOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  for (const tab of tabs) {
    if (!tab.id || tab.discarded) continue;
    const target = { tabId: tab.id, allFrames: true };
    try {
      await chrome.scripting.executeScript({ target, files: ['src/shared/settings.js', 'src/content-bridge.js'], world: 'ISOLATED' });
      await chrome.scripting.executeScript({ target, files: ['src/content-main.js'], world: 'MAIN' });
    } catch {
      // chrome://, Web Store, or no host access: the tab picks scripts up on next load.
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'arcpip:frame-state' && sender.tab && typeof sender.frameId === 'number') {
    const s = message.state || {};
    const tabId = sender.tab.id;
    let frames = tabFrames.get(tabId);
    if (!frames) tabFrames.set(tabId, (frames = new Map()));
    if (!s.hasVideo && !s.inPip) {
      frames.delete(sender.frameId);
    } else {
      frames.set(sender.frameId, {
        top: s.top === true,
        hasVideo: s.hasVideo === true,
        playing: s.playing === true,
        muted: s.muted === true,
        armed: s.armed === true,
        inPip: s.inPip === true,
        score: Number(s.score) || 0,
        documentId: sender.documentId || null,
      });
    }
    persistSoon();
    updateBadge(tabId);
    return false;
  }

  // From the popup (extension pages only).
  if (message.type === 'arcpip:get-tab-info' && sender.id === chrome.runtime.id && !sender.tab) {
    restored.then(() => {
      sendResponse({ ...summarizeTab(message.tabId), target: chooseTarget(message.tabId) });
    });
    return true; // async response
  }
  return false;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-pip' || !tab || typeof tab.id !== 'number') return;
  // Must stay synchronous up to executeScript to keep the keyboard gesture.
  T.run(tab.id, chooseTarget(tab.id)).then((result) => {
    if (settings.debug) console.debug('[ArcPiP] toggle result', result);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabFrames.delete(tabId)) persistSoon();
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (tabFrames.delete(removedTabId)) persistSoon();
});

initBadgeStyle();
