# Guy Code Bridge — Chrome extension

This is the Chrome-side half of Guy Code's browser connector. It lets
the desktop app drive your Chrome tabs (read Gmail, click Send in
Slack, etc.) **without** requiring `--remote-debugging-port` on your
main Chrome profile. The desktop app runs a tiny WebSocket server on
`127.0.0.1:9223`; this extension is the client.

## Why an extension instead of CDP-over-TCP?

Chrome 136+ silently refuses `--remote-debugging-port` when
`--user-data-dir` resolves to your default profile (anti-cookie-theft
measure — see https://issues.chromium.org/issues/41486862). The
extension bypasses this restriction because it uses the
`chrome.tabs` and `chrome.scripting` extension APIs from inside the
browser process, not an externally-launched debugger.

## One-time install

1. Open Chrome and go to `chrome://extensions/`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Pick the `chrome-extension/` directory from this repo (the one
   containing `manifest.json`).
5. The extension's icon (a small puzzle-piece by default since we
   ship no PNG icons) appears in the Chrome toolbar. Pin it if you
   like — clicking it shows the connection status.

That's it. The extension's service worker tries to connect to the
Guy Code app on extension load and on every browser-startup event. If
the app isn't running yet, it retries with exponential backoff
(500ms → 1s → 2s → 5s → 10s, then steady).

## Verifying the install

After loading the extension AND launching Guy Code:

- Open the Guy Code desktop app and navigate to
  Settings → Chrome connector. The status pill should turn green
  ("Connected · N tabs"). N is the number of tabs the extension can
  see across all your Chrome windows.
- Click the puzzle-piece icon → Guy Code Bridge in Chrome's toolbar.
  The popup should say "Connected to Guy Code".

If either says disconnected:

- Make sure the desktop app is running (you should see a Guy Code
  window).
- Check `chrome://extensions/` for any errors against this extension
  (yellow exclamation icon — click it to see the message).
- Open the service worker's DevTools: on the extension's
  `chrome://extensions/` card, click **Service Worker** to see logs.
  Reconnection attempts will be visible there.

## What the extension can and can't do

**Can:**

- List, open, and close tabs (`chrome.tabs`).
- Read DOM text from any tab (`chrome.scripting.executeScript`).
- Click elements, type text, press keys via synthesized DOM events.
- Capture a screenshot of the current viewport
  (`chrome.tabs.captureVisibleTab`).
- Run small `eval`-style probes in page context.

**Can't (yet):**

- Capture a full-page screenshot beyond the viewport (would require
  `chrome.debugger`, which shows Chrome's yellow "is being debugged
  by extension" banner per tab — we deliberately avoid it).
- Drive Chrome's own UI (extensions, settings, etc.). Only regular
  web pages.
- Synthesize "real" OS-level input events that pass anti-bot fraud
  checks on hostile sites. For Gmail / Slack / Outlook / standard
  enterprise tools this is fine; for sites with hard automation
  detection, it isn't.

## Updating the extension

Edit any file in `chrome-extension/`, then on Chrome's
`chrome://extensions/` page click the **circular reload arrow** on
the Guy Code Bridge card. Chrome reloads the manifest, service
worker, and content scripts. The WebSocket will reconnect on its own.

## Uninstalling

`chrome://extensions/` → **Remove** on the Guy Code Bridge card. The
desktop app will see the connection drop and report "Disconnected"
in Settings.
