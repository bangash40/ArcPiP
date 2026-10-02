'use strict';

(async () => {
  const S = globalThis.ArcPiPSettings;
  const T = globalThis.ArcPiPToggle;
  const $ = (id) => document.getElementById(id);

  let settings = await S.load();
  let tab = null;
  let info = null;

  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch { /* ignore */ }

  // activeTab grants the URL of the current tab once the popup is opened.
  const url = (tab && tab.url) || '';
  let host = '';
  let scheme = '';
  try {
    const u = new URL(url);
    scheme = u.protocol;
    if (scheme === 'http:' || scheme === 'https:') host = S.normalizeHost(u.hostname);
  } catch { /* ignore */ }
  const scriptable = !url
    ? !!tab
    : /^(https?|file):$/.test(scheme) &&
      !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url);

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function setStatus(state, title, sub) {
    $('status').dataset.state = state;
    $('statusTitle').textContent = title;
    $('statusSub').textContent = sub || '';
  }

  function render() {
    $('enabled').checked = settings.enabled;
    document.body.classList.toggle('disabled', !settings.enabled);

    const siteLabel = $('siteLabel');
    siteLabel.textContent = '';
    if (host) {
      siteLabel.append('Enabled on ');
      const b = document.createElement('b');
      b.textContent = host;
      siteLabel.append(b);
      siteLabel.title = host;
    } else {
      siteLabel.textContent = 'Enabled on this site';
    }
    const siteOn = host ? S.isSiteEnabled(settings, host) : true;
    $('siteEnabled').checked = siteOn;
    $('siteEnabled').disabled = !host || !settings.enabled;

    if (document.activeElement !== $('skipBack')) $('skipBack').value = settings.skipBack;
    if (document.activeElement !== $('skipForward')) $('skipForward').value = settings.skipForward;

    $('popOut').disabled = !scriptable || !tab;

    if (!scriptable) {
      setStatus('warn', 'ArcPiP can\'t run on this page', 'Chrome doesn\'t allow extensions on browser and Web Store pages.');
    } else if (!settings.enabled) {
      setStatus('idle', 'ArcPiP is off', 'Turn it on to pop videos out when you switch tabs.');
    } else if (!siteOn) {
      setStatus('idle', `Off on ${host}`, 'Auto pop-out is disabled for this site. "Pop out now" still works.');
    } else if (!info) {
      setStatus('idle', 'Checking this tab…', '');
    } else if (info.inPip) {
      setStatus('pip', 'Playing in Picture-in-Picture', 'Come back to this tab and it pops back in.');
    } else if (info.armed) {
      setStatus('armed', 'Armed', 'Switch tabs and this video pops out.');
    } else if (info.playing) {
      setStatus('warn', 'Video playing in an embedded player', 'Chrome only auto-pops videos in the main page. Use "Pop out now".');
    } else if (info.hasVideo) {
      setStatus('idle', 'Video paused', 'Play it, then switch tabs to pop it out.');
    } else {
      setStatus('idle', 'No video detected', info.frames === 0 ? 'Start a video. Just installed ArcPiP? Reload this tab first.' : 'Start a video to arm auto pop-out.');
    }
  }

  async function refreshInfo() {
    if (!tab || !scriptable) return;
    try {
      info = await chrome.runtime.sendMessage({ type: 'arcpip:get-tab-info', tabId: tab.id });
    } catch {
      info = null;
    }
    render();
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  $('enabled').addEventListener('change', async (e) => {
    settings = await S.update({ enabled: e.target.checked });
    render();
  });

  $('siteEnabled').addEventListener('change', async (e) => {
    if (!host) return;
    const on = e.target.checked;
    settings = await S.update((s) => S.withSiteEnabled(s, host, on));
    render();
  });

  for (const id of ['skipBack', 'skipForward']) {
    $(id).addEventListener('change', async (e) => {
      settings = await S.update({ [id]: e.target.value });
      e.target.value = settings[id];
    });
  }

  $('popOut').addEventListener('click', () => {
    if (!tab) return;
    const target = { ...(info && info.target ? info.target : { frameIds: null, mode: 'broadcast' }), forcePip: settings.forcePip };
    // Called synchronously from the click so Chrome passes the user gesture on.
    const pending = T.run(tab.id, target);
    $('msg').textContent = 'Working…';
    pending.then((result) => {
      $('msg').textContent = T.MESSAGES[result] || '';
      refreshInfo();
      if (result === 'entered') setTimeout(() => window.close(), 600);
    });
  });

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
  });

  $('openShortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    window.close();
  });

  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === 'toggle-pip');
    $('shortcut').textContent = (cmd && cmd.shortcut) || '';
  } catch { /* ignore */ }

  S.onChange((next) => { settings = next; render(); });

  render();
  refreshInfo();
  setInterval(refreshInfo, 1000);
})();
