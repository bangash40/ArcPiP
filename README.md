# ArcPiP

Arc browser's automatic mini player, for Google Chrome.

Play a video, switch tabs, and the video pops out into a floating Picture-in-Picture window that stays on top of
every app, even with Chrome minimized. Go back to the tab and the window closes while the video keeps playing in the
page. A paused video stays where it is.

- Manifest V3, plain JavaScript, no build step, no libraries, no remote code, no analytics
- PiP window controls: play/pause, skip back/forward (configurable, 10 s / 30 s by default), next track where the
  site provides it (YouTube playlists and autoplay), and Chrome's built-in "Back to tab"
- Works with single-page apps (YouTube, Twitch, …), shadow-DOM players and embedded players (manual pop-out only for embeds, see [limitations](#known-limitations))
- Per-site rules (allowlist or blocklist), ad awareness, optional "force PiP"
- `Alt+P` shortcut and a "Pop out now" button for manual pop-out on any page

## Requirements

| | |
|---|---|
| **Chrome 134 or newer** | Needed for *automatic picture-in-picture for media playback*. The extension installs on Chrome 111+, but on 111–133 only the manual shortcut and button work. The options page checks your version. |
| **"Automatic picture-in-picture" allowed per site** | A Chrome site permission. See below. |

## Installation (unpacked)

1. Download or clone this folder.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. The setup page opens automatically. Pin ArcPiP from the puzzle-piece menu so you can see its badge.
6. Reload any tabs that were already open. ArcPiP tries to inject into open tabs on install, but a reload is the reliable way.

## Required Chrome settings

### 1. Allow "Automatic picture-in-picture" for each video site

Chrome only lets a site pop a video out on its own if you allow it:

1. Open the site (for example `youtube.com`).
2. Click the **site information** icon at the left end of the address bar (the "tune" icon with two sliders).
3. Set **Automatic picture-in-picture** to **Allow**. If it isn't in that menu, open **Site settings** from the same
   menu and change it there.

The first time a video pops out automatically, Chrome may instead show a prompt asking whether to allow it. Choose to
allow it on every visit. To review all sites, go to **Settings → Privacy and security → Site settings → Additional
permissions → Automatic picture-in-picture**.

Without an explicit Allow, Chrome only auto-pops videos on sites you use often (its *Media Engagement Index*), so
allowing the permission is the dependable route.

### 2. Flags (normally not needed)

On Chrome 134+ the feature is enabled by default. The Chrome team's own article names this flag for testing, or for
browsers where the rollout hasn't reached you yet:

- `chrome://flags/#auto-picture-in-picture-for-video-playback`: set it to *Enabled* and relaunch.

Chrome 142+ also has `chrome://flags/#browser-initiated-automatic-picture-in-picture` (*browser-initiated* auto-PiP for
sites that don't register a handler). ArcPiP doesn't need it. Per Chrome's docs, a site-registered
`enterpictureinpicture` handler (which ArcPiP provides) takes precedence over the browser-initiated behavior.

Those are the only two flags I could confirm in Chrome's official documentation. Flag names change between versions,
so if neither is listed in your build, rely on the defaults. I couldn't verify a direct `chrome://settings/content/…`
URL for the permission page, so the docs give the menu path instead.

## How it works

```
            chrome.storage.sync
                    │
┌───────────────────┴──────────────────┐    CustomEvent (JSON string)    ┌───────────────────────────────┐
│ content-bridge.js  (ISOLATED world)  │ ─────── settings ─────────────▶ │ content-main.js  (MAIN world) │
│ resolves per-site rule for the tab   │ ◀────── frame state ─────────── │ media session + PiP engine    │
└───────────────────┬──────────────────┘                                 └───────────────────────────────┘
          runtime.sendMessage (state)                                          ▲
                    ▼                                                          │ executeScript (Alt+P / popup)
┌──────────────────────────────────────┐                                        │
│ background.js (service worker)       │ ───────────────────────────────────────┘
│ badge · frame targeting · Alt+P      │
└──────────────────────────────────────┘
```

1. **Auto pop-out.** Chrome 134 added [automatic picture-in-picture for media playback](https://developer.chrome.com/blog/automatic-picture-in-picture-media-playback).
   When a page has registered a Media Session `enterpictureinpicture` action handler, Chrome calls it as you switch
   away from a tab whose top-frame media is playing and was audible in the last two seconds. That call counts as
   permission to call `video.requestPictureInPicture()`, which a page normally can't do without a click.
   `content-main.js` runs in the page's MAIN world (`"world": "MAIN"`) because the handler must belong to the page's
   own `navigator.mediaSession`.
2. **Choosing the video.** Each frame scores its videos: playing and audible first, then largest visible area. It
   skips videos under 200 px wide, hidden ones, audio-only elements, muted looping background videos and
   `disablePictureInPicture` videos (unless "Force PiP" is on). Paused videos never pop out.
3. **PiP controls.** ArcPiP also registers `seekbackward`/`seekforward` (your skip seconds) and keeps
   `setPositionState` current. It never touches the site's `play`, `pause`, `nexttrack`, `previoustrack` or `seekto`
   handlers, so YouTube's next-video button keeps working.
4. **Coexisting with the site.** The site's own `setActionHandler` calls for the three actions ArcPiP manages are
   intercepted and remembered. While ArcPiP is active its handlers stay installed. When ArcPiP is off (globally or for
   the site), the site's handlers are restored. If Chrome fires the handler while the chosen video is muted (for
   example during a video call on Meet), ArcPiP hands the call to the site's own handler. Handlers are also
   re-applied every few seconds while a video plays, in case a site bypasses the wrapper.
5. **Coming back.** Chrome usually closes an auto-opened PiP window itself when you return to the tab. ArcPiP waits
   about 350 ms rather than racing it, then calls `document.exitPictureInPicture()` only if the window is still open,
   and resumes playback if the exit paused the video. PiP windows you opened yourself are left alone. Once the window
   closes, ArcPiP checks with `requestVideoFrameCallback` that the inline video is drawing frames again. If it's
   playing but blank (audio only), ArcPiP re-seeks in place to force a fresh frame, which restores the picture
   without a reload.
6. **Dynamic pages.** It re-detects videos on `yt-navigate-finish`, `history.pushState`/`replaceState`, `popstate`,
   `hashchange`, bfcache `pageshow`, a debounced `MutationObserver`, `play`/`loadedmetadata` capture listeners and a
   throttled scan of open shadow roots.
7. **Settings bridge.** MAIN-world scripts can't use `chrome.*`, so `content-bridge.js` (ISOLATED world) reads
   `chrome.storage.sync`, resolves the site rule for the **top-level** hostname (embedded players follow the host
   site's rule) and sends a flat config object as a `CustomEvent` whose `detail` is a JSON string. Updates are pushed
   live. Both sides validate the shape of every message. The host page can see and forge these events, but the most
   it can do is mislead ArcPiP about its own page.
8. **Manual toggle.** `Alt+P` (`chrome.commands`) and the popup button call `chrome.scripting.executeScript`
   **synchronously** in the command or click handler, so Chrome passes the user gesture to the injected script. The
   service worker knows which frame is playing or in PiP, from state reports, and targets that frame. If it doesn't
   know, the script goes to every frame and only a frame with a playing video (or the top frame) acts. The injected
   script asks the MAIN-world engine to toggle (ack + result over DOM events), and falls back to its own picker if
   the engine isn't present.
9. **Badge.** The toolbar icon shows **PiP** when auto pop-out is armed in the tab's top frame (playing, audible, not
   an ad), or while the tab's video is in PiP.

### Does the shortcut need a click on the page first?

It shouldn't. Chrome treats extension keyboard commands and action/popup clicks as user gestures and forwards them to
`chrome.scripting.executeScript` injections. Google's own
[Picture-in-Picture extension](https://github.com/GoogleChromeLabs/picture-in-picture-chrome-extension) relies on the
same mechanism. If Chrome ever rejects the request (`NotAllowedError`), the popup says "Chrome blocked it — click the
page once, then try again", and one click on the page fixes it. This couldn't be verified in an automated
environment, so it's on the checklist below.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves your settings (`chrome.storage.sync`) and the per-tab frame state the service worker needs after a restart (`chrome.storage.session`). |
| `scripting` | Runs the manual toggle (`Alt+P` / "Pop out now") in the right frame, and injects the content scripts into tabs that were open before install. |
| `activeTab` | Lets the popup read the current tab's URL to show and change its per-site rule, and grants access to the tab when you use the shortcut or popup. |
| Host access: `http://*/*`, `https://*/*`, `file:///*` (via `content_scripts.matches`) | The auto pop-out has to be registered in the page **before** you switch tabs, so the content scripts must run on every site you might watch video on. `file:///*` only applies if you enable "Allow access to file URLs" (useful for local videos and the test page). |

No `tabs`, `webNavigation`, `<all_urls>` host permission, network access or remote code.

## Settings

| Setting | Default | Notes |
|---|---|---|
| ArcPiP enabled | on | Master switch. |
| Per-site rules | none | `allow`/`block` keyed by hostname (`www.` stripped). The most specific rule wins: `music.youtube.com` overrides `youtube.com`. |
| Default site policy | All sites | Or *Only sites you allow* (allowlist mode). |
| Skip back / forward | 10 s / 30 s | 1–300. |
| Close PiP when returning | on | Chrome may also close auto-opened PiP windows itself when you return, regardless of this setting. |
| Don't pop out during ads | on | YouTube / YouTube Music (`.ad-showing`) and Twitch (ad label). Best effort. |
| Force PiP on sites that block it | off | Removes `disablePictureInPicture`. Can break players that rely on it. |
| Debug logging | off | Logs `[ArcPiP]` decisions to the page console. Otherwise ArcPiP never logs. |

Everything is one object under `settings` in `chrome.storage.sync`, with a `version` field. `migrate()` in
[`src/shared/settings.js`](src/shared/settings.js) fills in defaults and clamps values on every read.

## Project structure

```
manifest.json
src/background.js          service worker: onboarding, Alt+P, badge, frame tracking
src/content-main.js        MAIN world: media session + PiP engine
src/content-bridge.js      ISOLATED world: settings in, frame state out
src/shared/settings.js     defaults, migration, per-site rule helpers
src/shared/pip-toggle.js   manual toggle (executeScript), shared by worker and popup
src/popup/                 popup.html / popup.css / popup.js
src/options/               options.html / options.css / options.js (onboarding + settings)
icons/                     icon.svg source + 16/32/48/128 PNGs
test/video-test.html       local test bench
test/settings.test.js      unit tests for settings.js (node test/settings.test.js)
```

## Testing

### Automated

```bash
node test/settings.test.js
```

### Local test bench

Serve the repo and open the bench (or enable *Allow access to file URLs* for ArcPiP and open the file directly):

```bash
python -m http.server 8765
```

Then open `http://localhost:8765/test/video-test.html`. It includes an audible generated video (canvas plus a quiet
tone, no network needed), a seekable CC0 sample, a muted background loop, a tiny video, a `disablePictureInPicture`
video, an SPA "swap video + pushState" button, a simulated YouTube ad class, buttons that register site
`nexttrack`/`enterpictureinpicture` handlers, and an iframe embed of itself.

### Manual checklist

Before each site, allow *Automatic picture-in-picture* for it (see above). "Switch away" means clicking another tab
in the same window.

**Plain HTML5 test page** (`test/video-test.html`)
- [ ] Press Play on the main player. The badge shows **PiP**. Switch away and the PiP window opens. Switch back and it closes, still playing.
- [ ] Pause, then switch away. Nothing pops out.
- [ ] Mute the main player. The badge clears and switching away does nothing.
- [ ] In the PiP window, skip back/forward jump by your configured seconds (use the seekable sample source).
- [ ] "Simulate ad: on", switch away: nothing pops out. Turn it off and it works again.
- [ ] "Swap video + pushState", play the new video, switch away: it pops out.
- [ ] "Register site nexttrack handler": the PiP window shows a Next button and clicking it swaps the video.
- [ ] The background, tiny and blocked videos never pop out. With "Force PiP" on, `Alt+P` while the blocked video plays pops it out.
- [ ] Iframe embed: play it, switch away. Nothing happens (Chrome limitation). `Alt+P` pops it out.
- [ ] Minimize Chrome while in PiP: the window stays on top and keeps playing.

**YouTube** (`youtube.com/watch?...`)
- [ ] Normal video: auto pop-out on switch, pop-in on return.
- [ ] After returning, the **picture** is back in the page, not just the audio. Repeat 5 times, including staying away for 30+ seconds.
- [ ] Next video: the PiP Next button works (with autoplay on, or in a playlist).
- [ ] Playlist: Next goes to the next playlist item. Pop-out still works after the page navigates.
- [ ] Theater mode and fullscreen: pop-out works. Fullscreen exits first, which is Chrome behavior.
- [ ] Click from one video to another without reloading (SPA navigation): pop-out still works.
- [ ] During a pre-roll ad, with "Don't pop out during ads" on: nothing pops out. After the ad it does.
- [ ] Hovering home-page thumbnails (muted previews) never arms the badge.
- [ ] Shorts: playing a Short pops out. Scrolling to the next Short still works.

**YouTube Music** (`music.youtube.com`)
- [ ] With video mode on (Song/Video toggle), switch away: it pops out, and the PiP Next skips tracks.
- [ ] In audio-only "Song" mode there's no visible video, so nothing pops out (expected).

**Vimeo** (`vimeo.com/<id>`)
- [ ] Pop-out on switch and pop-in on return. Skip buttons work.

**Twitch** (`twitch.tv/<channel>`)
- [ ] Live stream pops out. The skip buttons do nothing on live streams (no seekable range), which is expected.
- [ ] VOD: skip works.
- [ ] Navigating between channels (SPA) keeps working.
- [ ] A mid-roll ad with "Don't pop out during ads" on: nothing pops out (best effort).

**Dailymotion** (`dailymotion.com/video/<id>`)
- [ ] Pop-out and pop-in work. Dailymotion's player may be an iframe on some pages, in which case use `Alt+P`.

**Embedded YouTube iframe on another site** (any blog or article with a YouTube embed, or the test page's iframe)
- [ ] Auto pop-out does **not** happen. Chrome only auto-PiPs top-frame media.
- [ ] `Alt+P` and "Pop out now" pop the embedded video out, and pressing them again brings it back.

**General**
- [ ] `Alt+P` works without clicking the page first. If it doesn't, record it; the popup will say "click the page once".
- [ ] Popup: the global switch, per-site switch and skip seconds save and apply immediately (no reload).
- [ ] Options page: adding `youtube.com` as Block disables it, and `music.youtube.com` as Allow overrides that.
- [ ] Allowlist mode: only allowed sites arm.
- [ ] With "Close PiP when returning" off: an auto-opened window stays open on return. Chrome may close it anyway.
- [ ] Debug logging on: `[ArcPiP]` lines appear in the page console. Off: nothing is logged.
- [ ] Google Meet / video calls: ArcPiP doesn't hijack the site's own picture-in-picture.

## Known limitations

- **Top frame only.** Chrome's automatic PiP ignores media inside iframes, so embedded players (YouTube embeds on
  other sites, some Dailymotion/Vimeo embeds) can only be popped out with `Alt+P` or the popup button.
- **Audible media only.** Chrome only auto-pops media that played sound in the last two seconds. Muted videos don't
  pop out.
- **Permission or engagement required.** Without an explicit *Allow*, Chrome only auto-pops on sites you use often.
- **Chrome decides when to fire.** ArcPiP can only provide the handler. Chrome also requires a Safe Browsing check of
  the page and audio focus. If another tab took audio focus, nothing pops out.
- **Tab switches are the documented trigger.** Switching to another window or app may not pop the video out,
  depending on Chrome version. Whatever triggers Chrome adds later call the same handler, so ArcPiP serves them too.
- **Ad detection is heuristic** (YouTube/YouTube Music class names, Twitch ad labels) and may break when sites
  change their markup.
- **Next track** only appears when the site registers a `nexttrack` handler. ArcPiP doesn't invent one.
- **DRM and sites that disable PiP** (`disablePictureInPicture`) are skipped unless *Force PiP* is on, and some DRM
  players may still refuse.
- **Pages that block extensions** (`chrome://` pages, the Chrome Web Store) can't be used.
- **MAIN-world caveat.** The engine shares the page's JavaScript world. It captures native APIs at `document_start`
  and never throws into the page, but a hostile page could still interfere with it on that page.
- **Keyboard shortcut conflicts.** If another extension already uses `Alt+P`, Chrome leaves ArcPiP's shortcut
  unassigned. Set one at `chrome://extensions/shortcuts`.
- **The mini player is its own window.** Chrome opens Picture-in-Picture as a separate small window, so Windows shows
  it in the taskbar preview and Alt+Tab as "Picture-in-picture", next to your main Chrome window. Chrome owns that
  window and doesn't let extensions change how it appears there (YouTube's own PiP button looks the same). It goes
  away when you return to the tab or close the player.
- **Other Chromium browsers** (Edge, Brave, …) may ship automatic PiP differently or not at all.

## Packaging for the Chrome Web Store

The store wants a `.zip` with `manifest.json` at its root. From a clean checkout:

```bash
git archive --format=zip -o arcpip-1.0.1.zip HEAD manifest.json src icons
```

Or in PowerShell:

```powershell
Compress-Archive -Path manifest.json, src, icons -DestinationPath arcpip-1.0.1.zip -Force
```

Then:

1. Bump `version` in `manifest.json` for each upload.
2. Upload the zip in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
3. In **Privacy practices**, give a single purpose ("Automatically shows playing videos in Picture-in-Picture when
   you switch tabs"), use the permission justifications above, and declare that no user data is collected.
4. Provide 128×128 and screenshot assets. `icons/icon-128.png` works as the store icon.
