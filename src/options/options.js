'use strict';

(async () => {
  const S = globalThis.ArcPiPSettings;
  const MIN_CHROME = 134;
  const $ = (id) => document.getElementById(id);

  let settings = await S.load();

  // ---------------------------------------------------------------------------
  // Onboarding + version check
  // ---------------------------------------------------------------------------

  if (new URLSearchParams(location.search).get('welcome') === '1') $('welcome').hidden = false;

  try { $('version').textContent = 'v' + chrome.runtime.getManifest().version; } catch { /* ignore */ }

  async function detectChrome() {
    let major = null;
    let full = null;
    let brand = null;
    const uad = navigator.userAgentData;
    if (uad && Array.isArray(uad.brands)) {
      const b = uad.brands.find((x) => x.brand === 'Google Chrome') || uad.brands.find((x) => x.brand === 'Chromium');
      if (b) {
        brand = b.brand;
        major = parseInt(b.version, 10);
      }
      try {
        const hi = await uad.getHighEntropyValues(['fullVersionList']);
        const fb = (hi.fullVersionList || []).find((x) => x.brand === brand);
        if (fb) full = fb.version;
      } catch { /* ignore */ }
    }
    if (!major) {
      const m = navigator.userAgent.match(/Chrome\/(\d+)/);
      if (m) {
        major = parseInt(m[1], 10);
        brand = 'Chrome';
      }
    }
    return { major, full, brand };
  }

  function setCheck(state, title, sub) {
    $('versionCheck').dataset.state = state;
    $('versionTitle').textContent = title;
    $('versionSub').textContent = sub || '';
  }

  detectChrome().then(({ major, full, brand }) => {
    const name = brand === 'Google Chrome' || brand === 'Chrome' ? 'Chrome' : 'Chromium-based browser';
    const shown = full || (major ? String(major) : '');
    if (!major) {
      setCheck('warn', 'Couldn\'t detect your browser version', `ArcPiP needs Chrome ${MIN_CHROME} or newer. Check chrome://settings/help.`);
    } else if (major < MIN_CHROME) {
      setCheck('bad', `${name} ${shown} is too old`,
        `Automatic picture-in-picture needs Chrome ${MIN_CHROME} or newer. Update via Settings → About Chrome. The keyboard shortcut still works.`);
    } else {
      setCheck('ok', `${name} ${shown}: supported`,
        name === 'Chrome' ? 'Automatic picture-in-picture is available in this version.'
          : 'Other Chromium browsers may ship the feature differently. If nothing pops out, use the shortcut.');
    }
  });

  // ---------------------------------------------------------------------------
  // Behavior
  // ---------------------------------------------------------------------------

  const TOGGLES = ['enabled', 'closeOnReturn', 'skipAds', 'forcePip', 'debug'];
  const NUMBERS = ['skipBack', 'skipForward'];

  for (const key of TOGGLES) {
    $(key).addEventListener('change', async (e) => {
      settings = await S.update({ [key]: e.target.checked });
    });
  }

  for (const key of NUMBERS) {
    $(key).addEventListener('change', async (e) => {
      settings = await S.update({ [key]: e.target.value });
      e.target.value = settings[key];
    });
  }

  for (const radio of document.querySelectorAll('input[name="policy"]')) {
    radio.addEventListener('change', async (e) => {
      if (e.target.checked) settings = await S.update({ defaultSitePolicy: e.target.value });
      renderRules();
    });
  }

  for (const btn of document.querySelectorAll('[data-open]')) {
    btn.addEventListener('click', () => chrome.tabs.create({ url: btn.dataset.open }));
  }

  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === 'toggle-pip');
    $('shortcut').textContent = (cmd && cmd.shortcut) || 'Not set';
  } catch { /* ignore */ }

  // ---------------------------------------------------------------------------
  // Site rules
  // ---------------------------------------------------------------------------

  function setRule(host, rule) {
    return S.update((s) => {
      const rules = { ...s.siteRules };
      if (rule) rules[host] = rule;
      else delete rules[host];
      return { ...s, siteRules: rules };
    });
  }

  function renderRules() {
    const list = $('rules');
    list.textContent = '';
    const hosts = Object.keys(settings.siteRules).sort();
    $('rulesEmpty').hidden = hosts.length > 0;
    for (const host of hosts) {
      const rule = settings.siteRules[host];
      const li = document.createElement('li');

      const name = document.createElement('span');
      name.className = 'host';
      name.textContent = host;
      name.title = host;

      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'pill ' + rule;
      pill.textContent = rule === 'allow' ? 'Allowed' : 'Blocked';
      pill.title = 'Click to ' + (rule === 'allow' ? 'block' : 'allow');
      pill.setAttribute('aria-label', `${host}: ${pill.textContent}. ${pill.title}`);
      pill.addEventListener('click', async () => {
        settings = await setRule(host, rule === 'allow' ? 'block' : 'allow');
        renderRules();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Remove rule for ' + host);
      remove.addEventListener('click', async () => {
        settings = await setRule(host, null);
        renderRules();
      });

      li.append(name, pill, remove);
      list.append(li);
    }
  }

  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const host = S.normalizeHost($('hostInput').value);
    if (!host) {
      $('formMsg').textContent = 'Enter a valid site, like youtube.com';
      return;
    }
    $('formMsg').textContent = '';
    settings = await setRule(host, $('ruleInput').value);
    $('hostInput').value = '';
    renderRules();
  });

  // ---------------------------------------------------------------------------
  // Render + live sync (popup changes show up here immediately)
  // ---------------------------------------------------------------------------

  function render() {
    for (const key of TOGGLES) $(key).checked = !!settings[key];
    for (const key of NUMBERS) if (document.activeElement !== $(key)) $(key).value = settings[key];
    for (const radio of document.querySelectorAll('input[name="policy"]')) {
      radio.checked = radio.value === settings.defaultSitePolicy;
    }
    renderRules();
  }

  try { S.onChange((next) => { settings = next; render(); }); } catch { /* ignore */ }
  render();
})();
