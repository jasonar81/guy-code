/**
 * Guy Code Bridge — Chrome extension service worker.
 *
 * Architecture
 * ============
 *
 * This extension is the Chrome-side half of Guy Code's browser
 * connector. The desktop app runs a small WebSocket SERVER on
 * 127.0.0.1:9223 (see `electron/chromeWsServer.ts`). This service
 * worker is the CLIENT — on every wake it tries to connect, then
 * handles JSON-RPC requests from the desktop. There's no Native
 * Messaging dance and no `--remote-debugging-port`; the bypass for
 * Chrome 136+'s anti-cookie-theft block is that we use the
 * `chrome.scripting` and `chrome.tabs` extension APIs, which run as
 * trusted in-browser code and aren't subject to the same block.
 *
 * Wire protocol (text JSON frames over WebSocket)
 * -----------------------------------------------
 *   client→server "hello":
 *     { "type": "hello", "version": "1", "ua": "..." }
 *
 *   server→client RPC request:
 *     { "id": "<string>", "method": "<name>", "params": {...} }
 *
 *   client→server RPC response:
 *     { "id": "<same id>", "result": <any> }            // success
 *     { "id": "<same id>", "error": "<message>" }       // failure
 *
 *   ping/pong: handled by the WS layer (the server sends pings; we
 *   reply with pongs automatically — no JSON involved).
 *
 * RPC methods implemented:
 *   listTabs()                                          → Tab[]
 *   openTab({ url })                                    → Tab
 *   extract({ tabId, selector? })                       → string
 *   screenshot({ tabId, area? })                        → { base64, bytes }
 *   waitFor({ tabId, selector?, text?, networkIdle?, timeoutMs? })
 *                                                       → void
 *   click({ tabId, selector?, text?, timeoutMs? })      → void
 *   type({ tabId, selector?, text, clearFirst?, timeoutMs? })
 *                                                       → void
 *   press({ tabId, key })                               → void
 *   scroll({ tabId, deltaY?, toY? })                    → void
 *   eval({ tabId, expression })                         → string
 *
 * Tab id format: tabs are exposed as the string `tab-<chrome tab id>`.
 * Chrome's numeric tab ids are stable for a browser session, so the
 * mapping is just sprintf — no separate counter needed.
 *
 * Service-worker keepalive
 * ------------------------
 * MV3 service workers shut down after ~30s of inactivity, which would
 * drop our WebSocket. We keep the worker alive in two ways:
 *   1. The WebSocket server pings every 25s; replying to a ping is
 *      an event that resets the SW idle timer.
 *   2. A `chrome.alarms` alarm fires every 25s as a belt-and-suspenders
 *      heartbeat; the alarm handler is enough activity to keep the
 *      worker alive even if the WS goes briefly silent.
 *
 * If the SW does die, on next wake (e.g. when the user clicks the
 * extension icon, or any chrome.* event fires) we'll reconnect to
 * the WS server and the next agent command will succeed after a
 * sub-second reconnection delay.
 */

const WS_URL = 'ws://127.0.0.1:9223';
// Behavioral BUILD number of this extension. Reported in the `hello`
// handshake so the Guy Code app can tell when the loaded (unpacked,
// non-auto-updating) extension is older than the one the app ships and warn
// the user to reload it. MUST stay in lockstep with EXTENSION_BUILD in
// electron/extVersion.ts (a test enforces this). Bump BOTH whenever this
// file's behavior changes. See electron/extVersion.ts for the history.
const EXT_BUILD = 2;
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000];
const KEEPALIVE_ALARM = 'guycode-keepalive';
const KEEPALIVE_PERIOD_MIN = 0.5; // chrome.alarms minimum

let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;

// Keep the SW alive periodically while we want a connection.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // No-op; just being called wakes the SW.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
    }
  }
});

// Reconnect on any meaningful Chrome event (extension install, browser
// startup, tab change…). This is the cheapest "always-on" we can get.
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

connect();

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.addEventListener('open', () => {
    reconnectAttempt = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws.send(
      JSON.stringify({
        type: 'hello',
        version: '1',
        extBuild: EXT_BUILD,
        ua: navigator.userAgent,
      })
    );
  });
  ws.addEventListener('message', async (ev) => {
    // Frame may be a string (text) — the server only sends text.
    let req;
    try {
      req = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    if (!req || typeof req !== 'object' || !req.id || !req.method) return;
    try {
      const result = await dispatch(req.method, req.params || {});
      send({ id: req.id, result });
    } catch (e) {
      send({ id: req.id, error: e && e.message ? e.message : String(e) });
    }
  });
  ws.addEventListener('close', () => {
    ws = null;
    scheduleReconnect();
  });
  ws.addEventListener('error', () => {
    // The close handler fires afterward; don't reconnect here too.
  });
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// ---- RPC dispatcher ----------------------------------------------------

async function dispatch(method, params) {
  switch (method) {
    case 'listTabs':
      return await rpcListTabs();
    case 'openTab':
      return await rpcOpenTab(params);
    case 'extract':
      return await rpcExtract(params);
    case 'screenshot':
      return await rpcScreenshot(params);
    case 'waitFor':
      return await rpcWaitFor(params);
    case 'click':
      return await rpcClick(params);
    case 'type':
      return await rpcType(params);
    case 'press':
      return await rpcPress(params);
    case 'scroll':
      return await rpcScroll(params);
    case 'eval':
      return await rpcEval(params);
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

// ---- Tab id helpers ---------------------------------------------------

function tabIdToString(id) {
  return `tab-${id}`;
}

function parseTabId(s) {
  if (typeof s !== 'string' || !s.startsWith('tab-')) {
    throw new Error(`invalid tab id "${s}" (expected "tab-<n>")`);
  }
  const n = Number(s.slice(4));
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid tab id "${s}"`);
  }
  return n;
}

async function tabExists(id) {
  try {
    await chrome.tabs.get(id);
    return true;
  } catch {
    return false;
  }
}

// ---- listTabs ---------------------------------------------------------

async function rpcListTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: tabIdToString(t.id),
    url: t.url || '',
    title: t.title || '',
  }));
}

// ---- openTab ----------------------------------------------------------

async function rpcOpenTab({ url }) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error(`openTab requires an absolute http(s) URL (got "${url}")`);
  }
  const tab = await chrome.tabs.create({ url, active: false });
  // Wait briefly for navigation to commit so we can return a real title.
  await waitForTabComplete(tab.id, 15000);
  const fresh = await chrome.tabs.get(tab.id);
  return {
    id: tabIdToString(fresh.id),
    url: fresh.url || url,
    title: fresh.title || '',
  };
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(updatedId, info) {
      if (updatedId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ---- extract ----------------------------------------------------------

async function rpcExtract({ tabId, selector }) {
  const id = parseTabId(tabId);
  if (!(await tabExists(id))) throw new Error(`tab id "${tabId}" not found`);
  const tab = await chrome.tabs.get(id);
  const out = await execInTab(id, extractInPage, [selector || null]);
  const header = `Title: ${tab.title || '(no title)'}\nURL: ${tab.url || '(no url)'}\n\n`;
  const MAX = 200_000;
  const body = String(out ?? '');
  if (body.length > MAX) {
    return (
      header +
      body.slice(0, MAX) +
      `\n\n[truncated: ${body.length.toLocaleString()} chars total, showing first ${MAX.toLocaleString()}]`
    );
  }
  return header + body;
}

// Executed in the page context.
function extractInPage(selector) {
  function isHidden(el) {
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0';
  }
  function textOf(el) {
    // innerText respects CSS visibility; textContent doesn't. We use
    // innerText so display:none nodes are skipped.
    return (el && el.innerText) || '';
  }
  if (selector) {
    const nodes = Array.from(document.querySelectorAll(selector));
    const visible = nodes.filter((n) => !isHidden(n));
    if (visible.length === 0) return `No matches for selector: ${selector}`;
    return visible.map(textOf).join('\n\n');
  }
  return textOf(document.body);
}

// ---- screenshot -------------------------------------------------------
//
// The screenshot RPC returns TWO images plus a label table:
//
//   • cleanBase64     — the page as the user sees it. The model reads
//                       text and content from this one.
//   • annotatedBase64 — the same page with numbered boxes drawn over
//                       every clickable / focusable element ("Set of
//                       Marks"). The model picks targets by referring
//                       to label numbers, then drives the page via
//                       the corresponding entry in `labels`.
//   • labels          — [{ label: 1, tag: 'button', text: 'Compose',
//                       selector: '#compose', bbox: { x, y, w, h }, ... }]
//
// Returning both is a deliberate design choice: overlay boxes occlude
// content on dense pages (Gmail label sidebars, file lists), so a
// single annotated image hurts the model's ability to READ; but the
// clean image alone forces the model to guess at selectors. Two
// images solves both problems at the cost of ~2x vision tokens per
// call, which is acceptable for the kind of pages this is used on.

async function rpcScreenshot({ tabId, area, annotate }) {
  const id = parseTabId(tabId);
  if (!(await tabExists(id))) throw new Error(`tab id "${tabId}" not found`);
  const tab = await chrome.tabs.get(id);
  if (area === 'fullPage') {
    // captureVisibleTab is viewport-only. For full-page we'd need
    // chrome.debugger (Page.captureScreenshot { captureBeyondViewport }),
    // which would trip the very banner this extension exists to avoid.
    // Steer the model to scroll-and-reshoot instead.
    throw new Error(
      'screenshot area=fullPage not supported by extension transport. ' +
        'Use viewport (the default) and call BrowserScroll between shots ' +
        'to page through a long page.'
    );
  }
  // chrome:// / chrome-extension:// / file:// / about:blank can't be
  // captured by extensions — captureVisibleTab silently fails or
  // throws cryptically. Detect early so the model gets a useful
  // error instead of "Cannot access contents of url" or worse a
  // hang waiting for an undefined dataUrl.
  const u = String(tab.url || '');
  if (
    u.startsWith('chrome://') ||
    u.startsWith('chrome-extension://') ||
    u.startsWith('edge://') ||
    u.startsWith('about:') ||
    u.startsWith('file://') ||
    u.startsWith('view-source:') ||
    u.startsWith('devtools://')
  ) {
    throw new Error(
      `screenshot not supported for privileged URL "${u}". Chrome blocks ` +
        'captureVisibleTab for chrome:// / extension / file / about pages. ' +
        'Navigate the tab to an http(s) URL first.'
    );
  }

  const previouslyActive = tab.active;
  const windowId = tab.windowId;
  // Pre-flight: un-minimize the window if needed.
  //
  // captureVisibleTab REQUIRES the window to be visible. When Chrome
  // is minimized the entire 5-attempt retry loop in
  // captureVisibleTabWithRetry burns its budget hitting the same
  // wall — minimization isn't a transient compositor glitch, it's a
  // persistent "no rendering happening" state.
  //
  // Restore the window to 'normal' state WITHOUT setting `focused:
  // true`. On Windows this means "show but don't activate" — Chrome
  // un-minimizes behind whatever has focus (Guy Code) so the user's
  // working context isn't disturbed. The 200 ms delay gives the
  // compositor time to wake up and start producing frames before we
  // try to capture.
  //
  // If un-minimize itself fails (rare; happens if the window was
  // closed mid-RPC) we let captureVisibleTab try anyway; its error
  // will be more useful than a generic "couldn't un-minimize."
  let wasMinimized = false;
  try {
    const win = await chrome.windows.get(windowId);
    if (win && win.state === 'minimized') {
      wasMinimized = true;
      await chrome.windows.update(windowId, { state: 'normal' });
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (e) {
    console.warn('[gc] window state check failed (continuing anyway):', e?.message);
  }
  // Remember WHICH tab was active before we hijacked the window so
  // we can restore it. We have to capture this BEFORE we activate
  // our target, because once we do, "active && not us" matches zero
  // tabs (Chrome guarantees one active tab per window).
  let previousActiveTabId = null;
  if (!previouslyActive) {
    const activeBefore = await chrome.tabs.query({ active: true, windowId });
    previousActiveTabId = activeBefore[0]?.id ?? null;
    await chrome.tabs.update(id, { active: true });
    // Give the renderer a paint cycle as the newly-active tab so
    // captureVisibleTab doesn't return the previous tab's content.
    // Earlier we tried `executeScript(() => requestAnimationFrame…)`
    // for accuracy, but that hangs forever on a CPU-pegged page
    // (Outlook with a busy worker), with NO bound on the executeScript
    // promise. A flat 150 ms beats the (rare) hang every time and is
    // imperceptible compared to the screenshot itself.
    await new Promise((r) => setTimeout(r, 150));
  }

  /** @type {string|undefined} */ let cleanDataUrl;
  /** @type {string|undefined} */ let annotatedDataUrl;
  /** @type {Array} */ let labels = [];
  /** @type {any} */ let pageInfo;

  try {
    // ---- 1. Page metadata + clean shot --------------------------------
    //
    // Race the executeScript with a short timeout so a wedged page
    // can't hang the entire screenshot RPC. If pageInfo collection
    // fails (timeout, CSP block, page navigated, …) we synthesize a
    // best-effort fallback from the chrome.tabs.Tab object — the
    // rest of the screenshot is still useful, and a screenshot with
    // no pageInfo at all would break the bridge's strict shape.
    try {
      pageInfo = await raceWithTimeout(
        execInTab(id, _gcPageInfoFn, []),
        3000,
        'pageInfo'
      );
    } catch (e) {
      console.warn('[gc] pageInfo failed:', e?.message);
    }
    if (!pageInfo) {
      pageInfo = {
        url: tab.url || '',
        title: tab.title || '',
        viewport: { width: 0, height: 0 },
        scroll: { x: 0, y: 0 },
        fullSize: { width: 0, height: 0 },
        devicePixelRatio: 1,
      };
    }
    cleanDataUrl = await captureWithCdpFallback(id, windowId);

    // ---- 2. (optional) Annotated shot via Set-of-Marks ----------------
    if (annotate !== false) {
      // Inject overlay in ISOLATED world so page scripts can't see
      // (or mess with) our boxes / badges. Both worlds share the
      // same DOM, so the overlay still renders in the screenshot.
      // Bounded by 8 s. Outlook on a CPU-pegged machine has been
      // observed to take ~6 s for the querySelectorAll-and-style
      // pass; a tighter timeout silently dropped labels there.
      // 8 s leaves headroom while still exiting fast enough to fit
      // inside the bridge's 70 s screenshot timeout (which has to
      // accommodate up to 32 s of capture-retry backoff on top).
      try {
        labels =
          (await raceWithTimeout(
            execInTabIsolated(id, _gcInjectSomOverlayFn, []),
            8000,
            'SoM inject'
          )) || [];
      } catch (e) {
        // Couldn't get labels — proceed with the clean image only.
        // This is a soft failure; the model still gets useful output.
        console.warn('[gc] SoM inject failed:', e?.message);
        labels = [];
      }
      // Only wait for the overlay to paint when there ARE overlays
      // to paint. If inject returned an empty list (or timed out),
      // 80 ms of dead time is just lag.
      if (labels.length > 0) {
        await new Promise((r) => setTimeout(r, 80));
      }
      annotatedDataUrl = await captureWithCdpFallback(id, windowId);
      // Always attempt to remove the overlay, even if anything below
      // throws — and even if `labels` ended up empty (the inject may
      // have partially rendered before timing out).
      try {
        await raceWithTimeout(
          execInTabIsolated(id, _gcRemoveSomOverlayFn, []),
          2000,
          'SoM remove'
        );
      } catch {
        // Worst case: a stale overlay container is left on the page.
        // It has pointer-events:none, so it won't block clicks; it'll
        // be cleaned up by the next screenshot or by reload.
      }
    }
    // When annotate is false we don't capture a second image — the
    // bridge layer detects the missing annotatedBase64 and shows
    // only the clean image to the model. This avoids paying double
    // the wire / PNG-decode / vision-token cost for nothing.
  } finally {
    if (!previouslyActive && previousActiveTabId !== null) {
      try {
        await chrome.tabs.update(previousActiveTabId, { active: true });
      } catch {
        // Tab may have been closed mid-screenshot; leave focus where it is.
      }
    }
  }

  if (!cleanDataUrl) {
    throw new Error(
      'screenshot failed: captureVisibleTab returned no data. ' +
        'The tab may have been closed or navigated mid-capture.'
    );
  }

  const cleanBase64 = stripDataUrl(cleanDataUrl);
  const annotatedBase64 = annotatedDataUrl ? stripDataUrl(annotatedDataUrl) : '';
  return {
    cleanBase64,
    // Empty string when there's no separate annotated image — the
    // bridge / tool layer treats falsy as "no SoM pass happened".
    annotatedBase64,
    bytesClean: approxBase64Bytes(cleanBase64),
    bytesAnnotated: annotatedBase64 ? approxBase64Bytes(annotatedBase64) : 0,
    labels,
    pageInfo,
  };
}

function stripDataUrl(dataUrl) {
  // Data URL is "data:image/png;base64,<...>"; strip the prefix.
  const comma = String(dataUrl).indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function approxBase64Bytes(b64) {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

// ---- screenshot helpers injected into the page -----------------------

/**
 * Collected page metadata. Runs in MAIN world so it can read
 * `document.title` / `location.href` even on strict-CSP pages.
 */
function _gcPageInfoFn() {
  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    fullSize: {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    },
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

/**
 * Set-of-Marks overlay injector. Walks the DOM for interactive
 * elements, filters to those visible in the viewport, sorts them
 * by reading order, and paints a numbered colored box over each.
 * Returns the label table. Stable across runs: same DOM produces
 * the same labels.
 *
 * Runs in ISOLATED world (separate JS heap from page scripts) but
 * still sees the same DOM, which is what we want.
 */
function _gcInjectSomOverlayFn() {
  const ROOT_ID = '__gc_som_root';
  const old = document.getElementById(ROOT_ID);
  if (old) old.remove();

  // Selector union for "things a user can interact with". Kept
  // conservative — divs with role="button" are included, generic
  // divs with onclick are not (too noisy on SPAs).
  const SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([type="hidden"]):not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[role="button"]:not([aria-disabled="true"])',
    '[role="link"]',
    '[role="textbox"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="option"]',
    '[role="searchbox"]',
    '[role="combobox"]',
    '[role="switch"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // ---- Two-phase candidate scan ------------------------------------
  //
  // Heavy SPAs like Outlook expose hundreds of focusable nodes in
  // their accessibility tree (every list-row, every label, every
  // hidden tab panel) so the unfiltered SELECTOR query can return
  // 300+ elements. Each `getComputedStyle` + `getBoundingClientRect`
  // is cheap on its own (~100 ns) but the original implementation
  // also called `document.elementFromPoint` per element to weed out
  // elements occluded by modals, and that DOES force layout/hit-test
  // — typically 1–5 ms each. On a busy Outlook page that compounded
  // into 500+ ms of forced layout work inside the SW's executeScript
  // call, occasionally pushing the whole screenshot RPC past the
  // 20-second WS timeout.
  //
  // We give that up: the occlusion check almost never catches
  // anything the cheap visibility filters miss (modals draw their
  // own labels which already pass), and the model can read the
  // clean image to figure out what's behind a popup. In exchange
  // we get a ~10x faster scan that doesn't stutter on heavy pages.
  //
  // We also hard-cap candidate count BEFORE expensive work so a
  // pathological page (a 5000-row table with role="cell" tabindex)
  // can't blow up our budget. Capping at 600 leaves headroom over
  // the typical 50–200 a normal page has, and we'll trim further
  // to MAX_LABELS=80 after sorting.
  const MAX_CANDIDATES = 600;
  let candidates = Array.from(document.querySelectorAll(SELECTOR));
  if (candidates.length > MAX_CANDIDATES) {
    candidates = candidates.slice(0, MAX_CANDIDATES);
  }
  const rows = [];
  const seenEls = new Set();
  for (const el of candidates) {
    if (seenEls.has(el)) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
    if (parseFloat(cs.opacity) === 0) continue;
    if (cs.pointerEvents === 'none') continue;
    const r = el.getBoundingClientRect();
    // Filter tiny elements (1px tracking pixels, hidden focus traps).
    if (r.width < 8 || r.height < 8) continue;
    // Must intersect the viewport.
    if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
    seenEls.add(el);
    rows.push({ el, rect: r });
  }

  // Sort by reading order: top → bottom, then left → right within a row.
  rows.sort((a, b) => {
    const dy = a.rect.top - b.rect.top;
    if (Math.abs(dy) > 12) return dy;
    return a.rect.left - b.rect.left;
  });

  // Cap at 80 labels — beyond that the overlay becomes unreadable
  // and the model picks worse targets anyway. Most useful pages
  // have well under 40 actionable elements in a viewport.
  const MAX_LABELS = 80;
  if (rows.length > MAX_LABELS) rows.length = MAX_LABELS;

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText =
    'all:initial!important;' +
    'position:fixed!important;' +
    'top:0!important;left:0!important;' +
    'width:100vw!important;height:100vh!important;' +
    'pointer-events:none!important;' +
    'z-index:2147483647!important;' +
    'contain:layout style size;';
  document.documentElement.appendChild(root);

  // Distinct colors cycling — 7 hues keeps adjacent labels
  // visually separable without ever feeling rainbow-y.
  const PALETTE = [
    '#FF3B30',
    '#34C759',
    '#007AFF',
    '#FF9500',
    '#AF52DE',
    '#5856D6',
    '#FF2D55',
  ];

  /** Build a stable-ish CSS selector. Bias toward id / testid / aria-label. */
  function buildSelector(el) {
    if (el.id && /^[a-zA-Z][\w-]{0,63}$/.test(el.id)) {
      return '#' + el.id;
    }
    const testid = el.getAttribute('data-testid');
    if (testid) return `[data-testid="${cssEsc(testid)}"]`;
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length > 0 && aria.length < 60) {
      return `${el.tagName.toLowerCase()}[aria-label="${cssEsc(aria)}"]`;
    }
    const name = el.getAttribute('name');
    if (name && /^[\w-]+$/.test(name)) {
      return `${el.tagName.toLowerCase()}[name="${name}"]`;
    }
    return undefined;
  }

  function cssEsc(s) {
    // Minimal escape for use inside a double-quoted attribute string.
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  const labels = [];
  rows.forEach((row, i) => {
    const num = i + 1;
    const color = PALETTE[i % PALETTE.length];
    const r = row.rect;
    const el = row.el;

    const box = document.createElement('div');
    box.style.cssText =
      'all:initial!important;' +
      'position:absolute!important;' +
      `left:${Math.round(r.left)}px!important;` +
      `top:${Math.round(r.top)}px!important;` +
      `width:${Math.round(r.width)}px!important;` +
      `height:${Math.round(r.height)}px!important;` +
      'box-sizing:border-box!important;' +
      `outline:2px solid ${color}!important;` +
      `outline-offset:-1px!important;` +
      'pointer-events:none!important;';
    root.appendChild(box);

    // Badge placement: prefer top-left OUTSIDE the box (so it doesn't
    // cover content); fall back to top-left INSIDE if outside would
    // be cut off by the viewport edge.
    const badge = document.createElement('div');
    badge.textContent = String(num);
    const badgeOutsideX = r.left - 1;
    const badgeOutsideY = r.top - 15;
    const useInside = badgeOutsideY < 0;
    badge.style.cssText =
      'all:initial!important;' +
      'position:absolute!important;' +
      `left:${Math.max(0, Math.round(useInside ? r.left + 1 : badgeOutsideX))}px!important;` +
      `top:${Math.max(0, Math.round(useInside ? r.top + 1 : badgeOutsideY))}px!important;` +
      'min-width:14px!important;' +
      'height:14px!important;' +
      'padding:0 3px!important;' +
      `background:${color}!important;` +
      'color:#fff!important;' +
      "font:bold 11px/14px ui-monospace,Menlo,Consolas,monospace!important;" +
      'text-align:center!important;' +
      'border-radius:2px!important;' +
      'pointer-events:none!important;' +
      'white-space:nowrap!important;' +
      'box-shadow:0 1px 2px rgba(0,0,0,0.4)!important;';
    root.appendChild(badge);

    let text = (el.innerText || el.textContent || '').trim();
    text = text.replace(/\s+/g, ' ');
    if (text.length > 80) text = text.slice(0, 77) + '…';

    const aria =
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      (el.tagName === 'INPUT' && typeof el.value === 'string' ? el.value : '') ||
      '';

    labels.push({
      label: num,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      text: text || undefined,
      aria: aria ? String(aria).slice(0, 80) : undefined,
      selector: buildSelector(el),
      bbox: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
    });
  });

  return labels;
}

/** Remove a previously-injected SoM overlay. Safe to call when no overlay exists. */
function _gcRemoveSomOverlayFn() {
  const root = document.getElementById('__gc_som_root');
  if (root) root.remove();
}

// ---- waitFor ----------------------------------------------------------

async function rpcWaitFor({ tabId, selector, text, networkIdle, timeoutMs }) {
  const id = parseTabId(tabId);
  if (!(await tabExists(id))) throw new Error(`tab id "${tabId}" not found`);
  const haveOne = !!selector || !!text || !!networkIdle;
  if (!haveOne) {
    throw new Error('waitFor needs at least one of selector / text / networkIdle');
  }
  const deadline = Date.now() + (typeof timeoutMs === 'number' ? timeoutMs : 15000);
  // Network-idle is approximated by polling navigator state via the page;
  // a precise version would attach chrome.debugger and listen for Network
  // events, which we avoid here to skip the debug banner.
  while (Date.now() < deadline) {
    if (selector) {
      const found = await execInTab(id, (s) => !!document.querySelector(s), [selector]);
      if (found) return;
    }
    if (text) {
      const found = await execInTab(
        id,
        (t) => (document.body.innerText || '').includes(t),
        [text]
      );
      if (found) return;
    }
    if (networkIdle) {
      const idle = await execInTab(
        id,
        () =>
          performance
            .getEntriesByType('resource')
            .every((r) => r.responseEnd > 0 && r.responseEnd < performance.now() - 500),
        []
      );
      if (idle) return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const what = selector || text || 'networkIdle';
  throw new Error(`waitFor: "${what}" did not appear within ${timeoutMs ?? 15000}ms`);
}

// ---- chrome.debugger escape hatch -------------------------------------
//
// Some web apps (Outlook search, certain banks, parts of Notion) are
// resistant to synthetic keyboard / mouse events: they wrap the real
// input in a Shadow DOM custom element, gate handlers on
// `event.isTrusted === true`, or capture clicks at the browser level
// in a way that synthetic dispatchEvent can't replicate.
//
// For those cases we expose a `useDebugger: true` opt-in on the
// click / press / type RPCs. When set, we attach the chrome.debugger
// API to the target tab and dispatch real OS-level events through
// the Chrome DevTools Protocol (`Input.dispatchKeyEvent` /
// `Input.dispatchMouseEvent`). Those events have `isTrusted=true`
// and travel through the same input pipeline as physical hardware,
// so they bypass every shadow-DOM and synthetic-event gate.
//
// Tradeoffs the user has accepted by setting the flag:
//   • Chrome shows a yellow infobar at the top of the tab —
//     "Guy Code Bridge started debugging this browser. Cancel."
//     while the debugger session is attached.
//   • The user can click Cancel to detach. We listen for that and
//     clean up state (debug session is then unusable for that tab
//     until next attach).
//   • If the user has DevTools open on that tab, attach FAILS with
//     "Another debugger is already attached".
//
// To minimize banner flicker on multi-step interactions (click then
// type, etc.) we keep the debugger attached for IDLE_DETACH_MS after
// the last call and reuse the session if a new call comes in within
// that window. The banner stays up for the duration but doesn't
// flicker.

const DEBUGGER_PROTOCOL_VERSION = '1.3';
const IDLE_DETACH_MS = 30_000;

/**
 * Per-tab attached-debugger state. Keyed by numeric chrome tab id.
 * Each entry: { idleTimer: timeout id }.
 */
const debugSessions = new Map();

/**
 * Promisified chrome.debugger.attach. Resolves once attached; rejects
 * with a clear error if Chrome refuses (privileged URL, DevTools
 * already open, etc.). If we're already attached to this tab, this
 * is a no-op and just refreshes the idle timer.
 */
async function attachDebuggerForTab(tabId) {
  if (debugSessions.has(tabId)) {
    refreshDebuggerIdleTimer(tabId);
    return;
  }
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(
          new Error(
            `chrome.debugger.attach failed: ${err.message}. ` +
              `Common causes: DevTools already open on this tab; ` +
              `tab is a chrome:// URL; user denied debugger permission.`
          )
        );
        return;
      }
      resolve();
    });
  });
  debugSessions.set(tabId, { idleTimer: null });
  refreshDebuggerIdleTimer(tabId);
}

/**
 * Reset the auto-detach timer so the session stays open as long as
 * the agent keeps using it.
 */
function refreshDebuggerIdleTimer(tabId) {
  const s = debugSessions.get(tabId);
  if (!s) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    detachDebuggerForTab(tabId).catch(() => {
      /* tab may have closed; ignore */
    });
  }, IDLE_DETACH_MS);
}

/**
 * Detach the debugger session if we have one. Safe to call on a tab
 * we never attached to — Chrome resolves with an error which we eat.
 */
async function detachDebuggerForTab(tabId) {
  const s = debugSessions.get(tabId);
  if (!s) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  debugSessions.delete(tabId);
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      // Errors here are typically "Debugger is not attached" if Chrome
      // already detached on its own (tab closed, user clicked Cancel
      // on the banner, etc.). Nothing useful to do.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

// User clicks "Cancel" on the debug banner OR navigates the tab in a
// way that breaks the debug session. Chrome fires onDetach; we
// reflect that in our local state so the next call attempts a fresh
// attach instead of re-using a dead session.
chrome.debugger?.onDetach.addListener((source, reason) => {
  if (typeof source.tabId !== 'number') return;
  const s = debugSessions.get(source.tabId);
  if (s) {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    debugSessions.delete(source.tabId);
  }
  console.warn(
    `[gc] chrome.debugger detached from tab ${source.tabId}: ${reason}`
  );
});

/**
 * Promisified chrome.debugger.sendCommand. Throws on protocol errors
 * with the CDP error message attached so callers get something useful
 * to log.
 */
function sendDebuggerCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(`CDP ${method} failed: ${err.message}`));
        return;
      }
      resolve(result);
    });
  });
}

/**
 * Map a JS-side modifier key set to the CDP modifiers bitmask.
 * (per https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent)
 */
function cdpModifiersBitmask({ alt, ctrl, meta, shift }) {
  let m = 0;
  if (alt) m |= 1;
  if (ctrl) m |= 2;
  if (meta) m |= 4;
  if (shift) m |= 8;
  return m;
}

/**
 * For a logical "key" name (e.g. "Enter", "j", "ArrowDown") return
 * a best-effort CDP key descriptor. Most apps read `key` (the
 * user-visible character / name); a few read `code` (physical
 * layout) for shortcut handling.
 */
function cdpKeyDescriptor(key) {
  if (key.length === 1) {
    if (/[a-zA-Z]/.test(key)) {
      return { key, code: 'Key' + key.toUpperCase() };
    }
    if (/[0-9]/.test(key)) {
      return { key, code: 'Digit' + key };
    }
    if (key === ' ') return { key: ' ', code: 'Space' };
    return { key, code: 'Unidentified' };
  }
  return { key, code: key };
}

/**
 * Send a real OS-level mouse click at (x, y) on the target tab via CDP.
 * `clickCount=1` matches a normal single-click; for double-click we'd
 * dispatch two press/release pairs with clickCount=2 on the second.
 */
async function cdpClickAt(tabId, x, y) {
  await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

/**
 * Send a real keyboard event sequence for ONE logical key.
 *
 * Two flavors:
 *   • Printable char (no Ctrl/Alt/Meta): keyDown(text) → keyUp.
 *     The `text` field on the keyDown is what inserts the character
 *     — Chromium treats this as a complete key+text input atom.
 *     This matches Puppeteer / Playwright. We do NOT send a separate
 *     `char` event after the keyDown(text); doing so causes the same
 *     character to be inserted twice on apps that don't preventDefault
 *     on keydown (Outlook search was the smoking gun: every char
 *     showed up as two). The CDP `char` type is documented as legacy
 *     for IME composition; it duplicates what keyDown(text) already
 *     does.
 *   • Named key (Enter, Tab, Escape, ArrowDown, …) and shortcut
 *     combos (Ctrl+a, Meta+c): rawKeyDown → keyUp. `rawKeyDown` is
 *     the CDP event for "key pressed without textual side-effect";
 *     the page reacts but no character lands.
 */
async function cdpDispatchKey(tabId, key, modifiersStr) {
  const mods = new Set((modifiersStr || []).map((m) => m.toLowerCase()));
  const modifiers = cdpModifiersBitmask({
    alt: mods.has('alt'),
    ctrl: mods.has('control') || mods.has('ctrl'),
    meta: mods.has('meta') || mods.has('cmd'),
    shift: mods.has('shift'),
  });
  const desc = cdpKeyDescriptor(key);
  const isPrintable = key.length === 1;
  const hasShortcutMod =
    mods.has('control') || mods.has('ctrl') || mods.has('alt') || mods.has('meta') || mods.has('cmd');

  if (isPrintable && !hasShortcutMod) {
    // Single keyDown carrying the text — Chromium inserts the char
    // as a side-effect of dispatching it. Then keyUp to close out
    // the keystroke. NO separate `char` event (would double-type).
    await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: desc.key,
      code: desc.code,
      text: key,
      unmodifiedText: key,
      modifiers,
    });
    await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: desc.key,
      code: desc.code,
      modifiers,
    });
    return;
  }
  // Shortcut or named key: rawKeyDown → keyUp.
  await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: desc.key,
    code: desc.code,
    modifiers,
  });
  await sendDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: desc.key,
    code: desc.code,
    modifiers,
  });
}

// ---- click ------------------------------------------------------------

async function rpcClick({ tabId, selector, text, timeoutMs, useDebugger }) {
  const id = parseTabId(tabId);
  if (!(await tabExists(id))) throw new Error(`tab id "${tabId}" not found`);
  if (!selector && !text) throw new Error('click needs selector or text');
  const deadline = Date.now() + (typeof timeoutMs === 'number' ? timeoutMs : 15000);

  // ---- chrome.debugger path -----------------------------------------
  //
  // Real OS-level click via CDP. Use this when synthetic dispatchEvent
  // can't reach the target — Outlook search, banks with Shadow DOM
  // wrappers, anything that gates on event.isTrusted. We still need
  // executeScript to find the element's bounding rect (CDP wants
  // viewport-relative pixel coords), but the actual click goes
  // through Input.dispatchMouseEvent.
  if (useDebugger) {
    while (Date.now() < deadline) {
      // Find element + scroll-into-view + return its center coords.
      const rect = await execInTab(
        id,
        (sel, txt) => {
          // ---- shared matcher (inlined; runs in page world) -----------
          //
          // Match strategy, in priority order:
          //   1. EXACT match on `innerText.trim() === txt`. Fastest and
          //      least ambiguous; most callers want this.
          //   2. CONTAINS match (`innerText.includes(txt)`) on a
          //      "clickish" element (a/button/input/[role=button|link|
          //      option|menuitem|tab|checkbox|radio]). The model
          //      regularly passes a truncated label like "June 3 -
          //      CONFIRMED" to click an Outlook row whose actual full
          //      subject is "June 3 - CONFIRMED - 2026 Product Vision
          //      Meeting"; before this fallback the click would time
          //      out and the model wasted 15 s before falling back to
          //      a manual CSS selector. Among multiple clickish
          //      candidates we pick the one with the SHORTEST innerText
          //      (most specific match — closest to "just the target").
          //   3. CONTAINS match on a generic element (span, div). Last
          //      resort; same shortest-innerText rule.
          function isClickish(el) {
            const tag = el.tagName.toLowerCase();
            if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select') return true;
            const role = (el.getAttribute('role') || '').toLowerCase();
            return (
              role === 'button' || role === 'link' || role === 'option' ||
              role === 'menuitem' || role === 'tab' || role === 'checkbox' ||
              role === 'radio' || role === 'switch' || role === 'searchbox' ||
              role === 'combobox'
            );
          }
          function findElByText(txt) {
            const all = document.querySelectorAll(
              'a, button, input, textarea, select, ' +
                '[role="button"], [role="link"], [role="option"], [role="menuitem"], ' +
                '[role="tab"], [role="checkbox"], [role="radio"], [role="switch"], ' +
                '[role="searchbox"], [role="combobox"], span, div'
            );
            let exact = null;
            let clickishContains = null;
            let clickishContainsLen = Infinity;
            let genericContains = null;
            let genericContainsLen = Infinity;
            for (const el of all) {
              const itxt = (el.innerText || '').trim();
              if (!itxt) continue;
              if (itxt === txt) {
                if (!exact || (isClickish(el) && !isClickish(exact))) exact = el;
                continue;
              }
              if (!itxt.includes(txt)) continue;
              if (isClickish(el)) {
                if (itxt.length < clickishContainsLen) {
                  clickishContainsLen = itxt.length;
                  clickishContains = el;
                }
              } else {
                if (itxt.length < genericContainsLen) {
                  genericContainsLen = itxt.length;
                  genericContains = el;
                }
              }
            }
            return exact || clickishContains || genericContains;
          }
          function findEl() {
            if (sel) return document.querySelector(sel);
            return findElByText(txt);
          }
          const el = findEl();
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          // After scrollIntoView the rect we read above may be stale —
          // re-read so the click lands on the post-scroll position.
          const r2 = el.getBoundingClientRect();
          return {
            x: Math.round(r2.left + r2.width / 2),
            y: Math.round(r2.top + r2.height / 2),
          };
        },
        [selector || null, text || null]
      );
      if (rect) {
        await attachDebuggerForTab(id);
        await cdpClickAt(id, rect.x, rect.y);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const what = selector ? `selector "${selector}"` : `text "${text}"`;
    throw new Error(`click(useDebugger): ${what} not found / not clickable within timeout`);
  }

  // ---- Synthetic-event path (default) -------------------------------
  while (Date.now() < deadline) {
    const ok = await execInTab(
      id,
      (sel, txt) => {
        function fire(el) {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          // dispatchEvent of pointer + mouse, then click() — covers most
          // sites including ones that listen for pointerdown/mouseup.
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            el.dispatchEvent(
              new MouseEvent(t, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: cx,
                clientY: cy,
                button: 0,
              })
            );
          }
          return true;
        }
        if (sel) return fire(document.querySelector(sel));
        // ---- text-based matcher (see useDebugger path above for rules)
        function isClickish(el) {
          const tag = el.tagName.toLowerCase();
          if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select') return true;
          const role = (el.getAttribute('role') || '').toLowerCase();
          return (
            role === 'button' || role === 'link' || role === 'option' ||
            role === 'menuitem' || role === 'tab' || role === 'checkbox' ||
            role === 'radio' || role === 'switch' || role === 'searchbox' ||
            role === 'combobox'
          );
        }
        const all = document.querySelectorAll(
          'a, button, input, textarea, select, ' +
            '[role="button"], [role="link"], [role="option"], [role="menuitem"], ' +
            '[role="tab"], [role="checkbox"], [role="radio"], [role="switch"], ' +
            '[role="searchbox"], [role="combobox"], span, div'
        );
        let exact = null;
        let clickishContains = null;
        let clickishContainsLen = Infinity;
        let genericContains = null;
        let genericContainsLen = Infinity;
        for (const el of all) {
          const itxt = (el.innerText || '').trim();
          if (!itxt) continue;
          if (itxt === txt) {
            if (!exact || (isClickish(el) && !isClickish(exact))) exact = el;
            continue;
          }
          if (!itxt.includes(txt)) continue;
          if (isClickish(el)) {
            if (itxt.length < clickishContainsLen) {
              clickishContainsLen = itxt.length;
              clickishContains = el;
            }
          } else {
            if (itxt.length < genericContainsLen) {
              genericContainsLen = itxt.length;
              genericContains = el;
            }
          }
        }
        const target = exact || clickishContains || genericContains;
        return target ? fire(target) : false;
      },
      [selector || null, text || null]
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  const what = selector ? `selector "${selector}"` : `text "${text}"`;
  throw new Error(`click: ${what} not found / not clickable within timeout`);
}

// ---- type -------------------------------------------------------------

async function rpcType({ tabId, selector, text, clearFirst, timeoutMs, useDebugger }) {
  const id = parseTabId(tabId);
  if (!(await tabExists(id))) throw new Error(`tab id "${tabId}" not found`);
  if (typeof text !== 'string') throw new Error('type requires text:string');
  const deadline = Date.now() + (typeof timeoutMs === 'number' ? timeoutMs : 15000);

  // ---- chrome.debugger path -----------------------------------------
  //
  // Focus + clear via executeScript (page-side, fast), then dispatch
  // every character through CDP as real OS-level keystrokes. Net
  // result: same input pipeline as a human typing on the physical
  // keyboard — bypasses Shadow DOM event re-targeting and isTrusted
  // gates that block the synthetic path.
  if (useDebugger) {
    // First find/focus the target. Returning the element's tag is
    // both a "did we find it" signal and useful for error messages.
    // We do NOT clear via DOM mutation here — the synthetic
    // textContent='' / value='' approach fails on apps that mirror
    // the field's value into a separate model (Outlook, Notion,
    // some Lit-based custom inputs): the DOM goes empty briefly
    // but the model overwrites it back. For useDebugger, clearing
    // via real keystrokes (Ctrl+A → Delete) below is the only
    // reliable approach because it goes through the same input
    // pipeline as a human pressing those keys.
    let focused = null;
    while (Date.now() < deadline) {
      focused = await execInTab(
        id,
        (sel) => {
          let el = sel ? document.querySelector(sel) : document.activeElement;
          if (!el) return null;
          try {
            el.focus();
          } catch {
            /* ignore */
          }
          return el.tagName.toLowerCase();
        },
        [selector || null]
      );
      if (focused) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!focused) {
      const what = selector ? `selector "${selector}"` : 'focused element';
      throw new Error(`type(useDebugger): ${what} not focusable within timeout`);
    }
    await attachDebuggerForTab(id);
    if (clearFirst) {
      // Real "Ctrl+A → Delete" keystrokes. This is what humans do
      // and it works across every app we've encountered, including
      // ones where DOM mutation gets reverted by a model layer.
      // Use Control on all platforms for the select-all shortcut —
      // although macOS users press Cmd+A on the physical keyboard,
      // Chromium's text editing intercepts both Ctrl+A and Cmd+A
      // for select-all in editable fields, so Ctrl+A is portable
      // without needing to know which OS we're targeting.
      await cdpDispatchKey(id, 'a', ['control']);
      await cdpDispatchKey(id, 'Delete', []);
    }
    // Per-char CDP dispatch. We don't add inter-char delay — the
    // browser's input pipeline correctly batches these, and most
    // autocompletes are debounced on the page side.
    for (const ch of text) {
      await cdpDispatchKey(id, ch, []);
    }
    return;
  }

  // ---- Synthetic-event path (default) -------------------------------
  while (Date.now() < deadline) {
    const ok = await execInTab(id, _gcTypeInPageFn, [
      selector || null,
      text,
      !!clearFirst,
    ]);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  const what = selector ? `selector "${selector}"` : 'focused element';
  throw new Error(`type: ${what} not typeable within timeout`);
}

/**
 * Per-character keyboard simulation that runs in the page.
 *
 * Why this is more than a one-line `el.value = text + dispatchEvent('input')`:
 * modern web apps (Outlook, Gmail, Slack, …) listen for `keydown`,
 * `beforeinput`, and per-keystroke `input` events to drive
 * autocomplete dropdowns, type-ahead search, slash-command menus,
 * etc. A single bulk `input` after a `value=` write does NOT match
 * what real typing produces, so a lot of those features stay dark.
 *
 * For each character we replay the spec-correct sequence:
 *   1. `keydown` — cancelable; if cancelled, that char is dropped.
 *   2. `beforeinput` — cancelable; same deal.
 *   3. write the new value via the native `value` setter (so React
 *      / Vue / Lit change-tracking notices).
 *   4. `input` (InputEvent with inputType=insertText, data=ch) —
 *      what most autocompletes hang off.
 *   5. `keyup`.
 *
 * After the loop we fire one `change` event — apps treat this as
 * "user finished editing and tabbed away". For contenteditable
 * targets we delegate to `document.execCommand('insertText')` which
 * synthesizes the right events through the browser's text editor.
 */
function _gcTypeInPageFn(sel, text, clear) {
  let el = sel ? document.querySelector(sel) : document.activeElement;
  if (!el) return false;
  if (el !== document.activeElement) {
    try {
      el.focus();
    } catch {
      /* ignore */
    }
  }
  if (clear) {
    if ('value' in el) {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // contenteditable path: execCommand fires beforeinput / input
  // through the browser's editor, including selection updates.
  if (!('value' in el) && el.isContentEditable) {
    try {
      document.execCommand('insertText', false, text);
      return true;
    } catch {
      return false;
    }
  }
  if (!('value' in el)) return false;

  // Resolve the prototype value-setter once outside the loop —
  // doing it per-keystroke is wasteful and React's change tracker
  // only cares about the call, not which exact descriptor.
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const writeValue = (next) => {
    if (setter) setter.call(el, next);
    else el.value = next;
  };

  /**
   * Map a printable char to a plausible KeyboardEvent.code value.
   * Real browsers derive `code` from the physical key, so 'J' typed
   * with Shift held becomes `{ key: 'J', code: 'KeyJ', shiftKey: true }`,
   * not `{ key: 'J', code: 'KeyJ' }` with no shift. Apps that gate
   * shortcuts on `code` (rare) need this to look right; apps that
   * read `key` (the common case) get the user-visible character.
   */
  function keyInfo(ch) {
    if (/[a-zA-Z]/.test(ch)) {
      return { key: ch, code: 'Key' + ch.toUpperCase(), shift: ch === ch.toUpperCase() && /[A-Z]/.test(ch) };
    }
    if (/[0-9]/.test(ch)) {
      return { key: ch, code: 'Digit' + ch, shift: false };
    }
    if (ch === ' ') return { key: ' ', code: 'Space', shift: false };
    if (ch === '\n') return { key: 'Enter', code: 'Enter', shift: false };
    // Punctuation: best-effort. We pass the char as both key and a
    // generic code; apps almost never branch on `code` for symbols.
    return { key: ch, code: 'Unidentified', shift: false };
  }

  for (const ch of text) {
    const info = keyInfo(ch);
    const evtBase = {
      key: info.key,
      code: info.code,
      shiftKey: info.shift,
      bubbles: true,
      cancelable: true,
    };
    // keydown — if the page cancels it (preventDefault), skip char.
    const kd = new KeyboardEvent('keydown', evtBase);
    if (!el.dispatchEvent(kd)) continue;
    // beforeinput — same opt-out semantics.
    let bi;
    try {
      bi = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: ch,
        bubbles: true,
        cancelable: true,
      });
    } catch {
      // Older Chrome lacks InputEvent in some contexts; fall back
      // to a plain Event so we at least notify listeners.
      bi = new Event('beforeinput', { bubbles: true, cancelable: true });
    }
    if (!el.dispatchEvent(bi)) continue;
    // Commit the new value, then fire input / keyup.
    writeValue((el.value || '') + ch);
    let inEv;
    try {
      inEv = new InputEvent('input', {
        inputType: 'insertText',
        data: ch,
        bubbles: true,
      });
    } catch {
      inEv = new Event('input', { bubbles: true });
    }
    el.dispatchEvent(inEv);
    el.dispatchEvent(new KeyboardEvent('keyup', evtBase));
  }
  // Single `change` after the whole burst — matches the
  // "user typed, then blurred" pattern most form libs treat as
  // a commit.
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// ---- press ------------------------------------------------------------

async function rpcPress({ tabId, key, useDebugger }) {
  const id = parseTabId(tabId);
  if (!(await tabExists(id))) throw new Error(`tab id "${tabId}" not found`);
  if (typeof key !== 'string' || !key) throw new Error('press requires `key`');

  // ---- chrome.debugger path -----------------------------------------
  //
  // Real OS-level keystroke. Crucially, this is the path that makes
  // Enter actually submit forms in apps that gate submission on
  // event.isTrusted (Outlook search, some banking sites, …).
  if (useDebugger) {
    // Parse "Control+a" / "Shift+Tab" style combos to extract the
    // primary key + modifier list.
    const parts = key.split('+');
    const mainKey = parts.pop();
    const mods = parts;
    await attachDebuggerForTab(id);
    await cdpDispatchKey(id, mainKey, mods);
    return;
  }

  // ---- Synthetic-event path (default) -------------------------------
  await execInTab(id, _gcPressInPageFn, [key]);
}

/**
 * Press a single key on the focused element, matching what a real
 * keyboard would do.
 *
 * Three cases, each modeled after browser behavior:
 *
 *   1. Printable single char, no Ctrl / Alt / Meta — e.g. "J", "5",
 *      " ", ",". Real keyboard: fires `keydown` → `beforeinput` →
 *      inserts the char into the focused input → `input` → `keyup`.
 *      We do the same. This is the case the agent ALWAYS wants for
 *      "press 'J'" to actually put a J in the field.
 *
 *   2. Modifier combo on a printable key — e.g. "Control+a",
 *      "Meta+c", "Alt+f". Real keyboard: fires keystroke events but
 *      DOES NOT insert text (the page handles the shortcut). We
 *      match that — keydown / keypress / keyup only.
 *
 *   3. Named key — e.g. "Enter", "Tab", "Escape", "ArrowDown",
 *      "Backspace". Real keyboard: fires keystroke events. Backspace
 *      / Delete / Enter sometimes mutate the input through the
 *      browser's editor, but cross-platform that's not reliable from
 *      JS, so we deliberately stay event-only and let the page's own
 *      handlers (Outlook's "Enter submits search", Slack's "Enter
 *      sends message") react. If the agent needs to delete chars,
 *      it can re-type with `clearFirst: true` instead.
 */
function _gcPressInPageFn(k) {
  // Parse "Control+K" / "Shift+Tab" style combos. Last segment is
  // the main key, earlier segments are modifiers.
  const parts = k.split('+');
  const mainKey = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const ctrlKey = mods.has('control') || mods.has('ctrl');
  const shiftKey = mods.has('shift');
  const altKey = mods.has('alt');
  const metaKey = mods.has('meta') || mods.has('cmd');

  // Derive the physical-key `code` value from `key`. Real browsers
  // base `code` on the physical layout, but for our purposes the
  // logical mapping (J → KeyJ, 5 → Digit5, " " → Space) is good
  // enough — apps virtually always read `key`, not `code`.
  let code;
  if (mainKey.length === 1) {
    if (/[a-zA-Z]/.test(mainKey)) code = 'Key' + mainKey.toUpperCase();
    else if (/[0-9]/.test(mainKey)) code = 'Digit' + mainKey;
    else if (mainKey === ' ') code = 'Space';
    else code = 'Unidentified';
  } else {
    code = mainKey;
  }
  const evtBase = {
    bubbles: true,
    cancelable: true,
    key: mainKey,
    code,
    ctrlKey,
    shiftKey,
    altKey,
    metaKey,
  };

  const target = document.activeElement || document.body;

  // CASE 1: printable single char with no text-eating modifier.
  // Shift IS allowed (uppercase letters, shifted symbols). Ctrl/Alt/
  // Meta are NOT allowed — those make the keystroke a shortcut, not
  // a typed character.
  const isPrintable = mainKey.length === 1;
  const isShortcut = ctrlKey || altKey || metaKey;
  if (isPrintable && !isShortcut) {
    // keydown — cancelable; if the page calls preventDefault we drop
    // the char. Matches real keyboard semantics (e.g., a form's
    // "block invalid characters" handler).
    if (!target.dispatchEvent(new KeyboardEvent('keydown', evtBase))) {
      target.dispatchEvent(new KeyboardEvent('keyup', evtBase));
      return true;
    }
    // beforeinput — same opt-out semantics. Many rich-text editors
    // gate input here for validation / IME composition.
    let bi;
    try {
      bi = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: mainKey,
        bubbles: true,
        cancelable: true,
      });
    } catch {
      bi = new Event('beforeinput', { bubbles: true, cancelable: true });
    }
    if (!target.dispatchEvent(bi)) {
      target.dispatchEvent(new KeyboardEvent('keyup', evtBase));
      return true;
    }
    // Commit the char into the focused element. Three flavors:
    //   • <input>/<textarea>: write via the prototype value setter
    //     so React's change tracker notices.
    //   • contenteditable: use document.execCommand which routes
    //     through the browser's text editor (selection-aware).
    //   • anything else (a div with focus, body): no text insertion
    //     possible; we still fire input event for listeners.
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      const proto = Object.getPrototypeOf(target);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const next = (target.value || '') + mainKey;
      if (setter) setter.call(target, next);
      else target.value = next;
    } else if (target.isContentEditable) {
      try {
        document.execCommand('insertText', false, mainKey);
      } catch {
        /* ignore — execCommand is deprecated but still works in
           Chrome; if it ever stops we'll just have to fall through
           with no value commit. */
      }
    }
    // input — fired AFTER the value has been updated, with the
    // committed char in `data`. This is the event most autocomplete /
    // search-as-you-type handlers listen for.
    let inEv;
    try {
      inEv = new InputEvent('input', {
        inputType: 'insertText',
        data: mainKey,
        bubbles: true,
      });
    } catch {
      inEv = new Event('input', { bubbles: true });
    }
    target.dispatchEvent(inEv);
    target.dispatchEvent(new KeyboardEvent('keyup', evtBase));
    return true;
  }

  // CASE 2 & 3: shortcut combos and named keys (Enter, Tab, Escape,
  // arrow keys, F-keys, …). Event-only — let the page decide what
  // to do.
  target.dispatchEvent(new KeyboardEvent('keydown', evtBase));
  target.dispatchEvent(new KeyboardEvent('keypress', evtBase));
  target.dispatchEvent(new KeyboardEvent('keyup', evtBase));
  return true;
}

// ---- scroll -----------------------------------------------------------

async function rpcScroll({ tabId, deltaY, toY }) {
  const id = parseTabId(tabId);
  if (!(await tabExists(id))) throw new Error(`tab id "${tabId}" not found`);
  await execInTab(
    id,
    (d, t) => {
      if (typeof t === 'number') window.scrollTo({ top: t });
      else window.scrollBy({ top: typeof d === 'number' ? d : 600 });
    },
    [typeof deltaY === 'number' ? deltaY : null, typeof toY === 'number' ? toY : null]
  );
}

// ---- eval -------------------------------------------------------------

async function rpcEval({ tabId, expression }) {
  const id = parseTabId(tabId);
  if (!(await tabExists(id))) throw new Error(`tab id "${tabId}" not found`);
  if (typeof expression !== 'string' || !expression) {
    throw new Error('eval requires `expression`');
  }
  // BrowserEval uses `new Function(...)` to build a runtime evaluator
  // for the expression, which is subject to whatever world's CSP we
  // inject into:
  //   - `world: 'MAIN'` → page's CSP applies. Most large web apps
  //     (Gmail, Outlook, GitHub, banks, etc.) block `unsafe-eval`,
  //     so `new Function` throws a CSP violation.
  //   - `world: 'ISOLATED'` → extension's CSP applies. MV3 default
  //     forbids `unsafe-eval` too.
  // In MV3 there is no portable way to run arbitrary JS via
  // executeScript. The fix-of-record (would-need-debugger-permission
  // + re-install) is documented in chrome-extension/README.md.
  // What we DO here: wrap the eval in try/catch and report a clear,
  // actionable error if it fails — instead of silently returning
  // undefined (which the agent saw as "null", not knowing why).
  const wrapped = await execInTab(
    id,
    (expr) => {
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(`return (${expr})`);
        const val = fn();
        return { ok: true, val };
      } catch (e) {
        return {
          ok: false,
          error: e && e.message ? e.message : String(e),
        };
      }
    },
    [expression]
  );
  if (!wrapped || wrapped.ok === false) {
    const inner = wrapped && wrapped.error ? wrapped.error : 'unknown error';
    throw new Error(
      `eval failed: ${inner}. BrowserEval uses \`new Function(...)\` which ` +
        'is blocked by Content Security Policy on most large web apps ' +
        '(Gmail, Outlook, GitHub, etc.). Use BrowserExtract with a CSS ' +
        'selector to read DOM content, or BrowserClick/BrowserType for ' +
        'interactions — those work through extension APIs that bypass CSP.'
    );
  }
  const val = wrapped.val;
  if (typeof val === 'string') return val;
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

// ---- helper: execute a function in a tab ------------------------------

async function execInTab(tabId, fn, args) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args,
    world: 'MAIN', // Run in the page's JS context so we can see its globals.
  });
  if (res && 'result' in res) return res.result;
  return undefined;
}

/**
 * Same as `execInTab` but runs in the ISOLATED world — separate JS
 * heap from page scripts, so the page can't see (or interfere with)
 * our overlay nodes / data attributes / etc. Both worlds see the
 * same DOM, so DOM-manipulation helpers work fine here. Use this
 * for the Set-of-Marks overlay so a page like Gmail can't mutate
 * our boxes mid-screenshot.
 */
async function execInTabIsolated(tabId, fn, args) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args,
    world: 'ISOLATED',
  });
  if (res && 'result' in res) return res.result;
  return undefined;
}

/**
 * Race a Promise against a timeout so a wedged page can't lock up
 * the service worker. `executeScript` has no built-in timeout — if
 * the page is in a long task (Outlook reflowing, a slow worker, …)
 * the underlying promise can hang indefinitely.
 *
 * If `p` resolves first → return its value.
 * If the timer fires first → throw `<label> timed out after Nms`.
 *
 * Callers decide whether to swallow the timeout (soft failure) or
 * propagate it (hard failure). The screenshot RPC, for instance,
 * treats SoM inject timeout as soft (return clean image without
 * labels) but pageInfo timeout as soft too (return empty pageInfo).
 */
function raceWithTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Wrapper around `chrome.tabs.captureVisibleTab` that absorbs
 * brief compositor glitches WITHOUT burning seconds when the tab is
 * persistently stuck.
 *
 * Why this exists:
 *
 *   On real machines, captureVisibleTab occasionally rejects with
 *   "Failed to capture tab: image readback failed" or
 *   "Failed to capture tab: 0" or similar. These are transient
 *   GPU-pipeline glitches — the tab hasn't fully composited yet,
 *   the GPU process is busy with another tab's video, the renderer
 *   hasn't finished a paint after a layout change. A quick retry
 *   resolves the ~99 % case.
 *
 * Why the retry budget is SHORT (~0.6 s, not 15+ s):
 *
 *   Earlier versions used a long [0, 1000, 2000, 4000, 8000] ms
 *   schedule under the theory that "more retries = more chances to
 *   succeed." The problem: when captureVisibleTab is persistently
 *   broken (sick GPU readback, Outlook with a CPU-pegged worker,
 *   window in another macOS Space, etc.), each individual API call
 *   ALSO hangs for 5-10 s before erroring. Five attempts × 10 s + 15 s
 *   of backoff = 65 s of wasted time before the CDP fallback gets
 *   to try. Users saw 50-70 s screenshot operations and concluded
 *   the tool was unusable.
 *
 *   The new policy: ~0.6 s of retry across 3 attempts, each
 *   attempt hard-bounded to 2 s via raceWithTimeout (so a hung
 *   chrome.tabs.captureVisibleTab call can't stall us).
 *   Worst-case here: 3 × 2 s + 0.55 s = 6.55 s. Then we fall
 *   through to CDP, which is ~1 s and reliable. Total worst-case
 *   from broken-fast-path to working-CDP: ~7-8 s — visibly fast,
 *   tolerable for the agent loop.
 *
 *   The old "8 s of paint settle time would help recover from a
 *   slow paint" intuition turned out to be wrong: paints either
 *   settle within ~1 frame (16 ms) or they're stuck long enough
 *   that CDP is faster than waiting.
 *
 * Permanent (non-retryable) errors are passed through immediately
 * so the agent isn't held up at all on a privileged-URL or
 * tab-not-found case.
 */
async function captureVisibleTabWithRetry(windowId) {
  const delays = [0, 150, 400];
  /**
   * Hard ceiling on each individual captureVisibleTab call. Sick
   * GPU readback states make the underlying API hang for many
   * seconds before erroring; bounding each attempt prevents the
   * "fail-slow" pathology where the retry schedule's wall-clock
   * ends up dominated by each attempt's hang time, not by the
   * intended backoff.
   */
  const PER_ATTEMPT_TIMEOUT_MS = 2000;
  let lastErr = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
    try {
      const dataUrl = await raceWithTimeout(
        chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
        PER_ATTEMPT_TIMEOUT_MS,
        `captureVisibleTab attempt ${attempt + 1}`
      );
      if (dataUrl) return dataUrl;
      // captureVisibleTab can resolve to undefined when the API call
      // succeeded but the renderer had nothing to read back yet.
      // Same root cause as the explicit "image readback failed"
      // error — treat it as retryable.
      lastErr = new Error('captureVisibleTab returned empty data');
    } catch (e) {
      lastErr = e;
      const msg = (e && e.message) || String(e);
      // Permanent errors: pass through immediately.
      if (
        /not\s*found/i.test(msg) ||
        /no tab with id/i.test(msg) ||
        /privileged\s*URL/i.test(msg) ||
        /Cannot access contents/i.test(msg) ||
        /No active web contents/i.test(msg)
      ) {
        throw e;
      }
      // Transient (or per-attempt timeout). Log and loop; the CDP
      // fallback will pick up if all attempts exhaust.
      console.warn(
        `[gc] captureVisibleTab attempt ${attempt + 1} failed: ${msg}`
      );
    }
  }
  // Exhausted retries.
  const msg = (lastErr && lastErr.message) || 'unknown';
  throw new Error(
    `captureVisibleTab failed after ${delays.length} attempts: ${msg}`
  );
}

/**
 * Two-tier screenshot capture: try `chrome.tabs.captureVisibleTab`
 * first (no debugger banner, fast path), fall back to
 * `chrome.debugger` + `Page.captureScreenshot` if that fails.
 *
 * Why this exists:
 *
 *   captureVisibleTab requires the target window to be visible AND
 *   the target tab to be the active tab in that window. We've
 *   already done the un-minimize pre-flight in `rpcScreenshot`, but
 *   real users still hit captureVisibleTab failures from:
 *
 *     • Window backgrounded into another macOS Space / virtual
 *       desktop. Chrome reports state='normal' but the compositor
 *       isn't producing frames for it.
 *     • Persistent GPU readback failures on certain hardware
 *       (older Intel iGPUs, some Hyper-V VMs).
 *     • Race with another extension that calls captureVisibleTab
 *       on the same window (Chrome serializes; the loser fails).
 *
 *   chrome.debugger + Page.captureScreenshot bypasses ALL of this
 *   because CDP captures from the renderer process directly,
 *   without going through the compositor's visible-frame buffer.
 *   Works on background tabs, off-screen windows, occluded windows,
 *   minimized windows — anywhere the renderer is alive.
 *
 *   The cost: chrome.debugger.attach shows the yellow "Guy Code
 *   Bridge has started debugging this browser" banner for as long
 *   as the session is attached. We minimize banner exposure by
 *   reusing existing `attachDebuggerForTab` (which has the 30 s
 *   idle-detach timer); if the agent is already using the
 *   debugger for clicks/types on this tab, the screenshot piggy-
 *   backs without any extra banner time.
 *
 * Returns a `data:image/png;base64,...` data URL string, matching
 * what captureVisibleTab returns. Callers don't need to know which
 * path actually fired.
 *
 * Optimization: if the chrome.debugger session is ALREADY attached
 * to this tab (because the agent just used `useDebugger:true` for a
 * BrowserType / BrowserClick / BrowserPress), we skip the
 * captureVisibleTab attempt and go directly to Page.captureScreenshot.
 * Two reasons:
 *   1. The yellow debugger banner is already showing — there's no
 *      banner-exposure cost to using CDP. Trying captureVisibleTab
 *      first only wastes wall time.
 *   2. captureVisibleTab on a tab that's actively being debugged
 *      sometimes returns stale frames (the debugger's `Input.*`
 *      events can disrupt the compositor's readback). CDP capture
 *      is consistent.
 */
async function captureWithCdpFallback(tabId, windowId) {
  // Fast path: debugger already attached. Go straight to CDP.
  if (debugSessions.has(tabId)) {
    try {
      return await captureViaCdp(tabId);
    } catch (cdpErr) {
      // CDP failed despite being attached. Fall through to
      // captureVisibleTab as a backup — better to have a chance
      // of success than to fail outright.
      const msg = (cdpErr && cdpErr.message) || String(cdpErr);
      console.warn(
        `[gc] CDP screenshot failed (debugger pre-attached); ` +
          `falling back to captureVisibleTab: ${msg}`
      );
    }
  }

  try {
    return await captureVisibleTabWithRetry(windowId);
  } catch (cdtErr) {
    const msg = (cdtErr && cdtErr.message) || String(cdtErr);
    // Permanent errors thrown by captureVisibleTabWithRetry early
    // return (privileged URL, tab not found) — re-throw, the
    // debugger can't help with those.
    if (
      /privileged\s*URL/i.test(msg) ||
      /no tab with id/i.test(msg) ||
      /not\s*found/i.test(msg) ||
      /Cannot access contents/i.test(msg)
    ) {
      throw cdtErr;
    }
    console.warn(
      `[gc] captureVisibleTab exhausted; falling back to chrome.debugger Page.captureScreenshot: ${msg}`
    );
    try {
      return await captureViaCdp(tabId);
    } catch (cdpErr) {
      // Both paths failed. Surface BOTH error messages so the user
      // can tell which one to fix. The CDP error is usually more
      // useful (e.g., "Cannot attach: tab is being debugged by
      // another devtools instance" tells you to close DevTools).
      const cdpMsg = (cdpErr && cdpErr.message) || String(cdpErr);
      throw new Error(
        `screenshot failed via both transports. ` +
          `captureVisibleTab: ${msg}. ` +
          `chrome.debugger fallback: ${cdpMsg}.`
      );
    }
  }
}

/**
 * Capture a screenshot via chrome.debugger + Page.captureScreenshot.
 *
 * Used as both the primary path (when the debugger is already
 * attached to the tab — see `captureWithCdpFallback`) and the
 * fallback when captureVisibleTab can't recover. Always returns the
 * same `data:image/png;base64,...` shape that captureVisibleTab
 * returns, so callers can treat both transports identically.
 *
 * Reuses an existing debugger session if attached; otherwise
 * attaches one (and the 30 s idle-detach timer in
 * `attachDebuggerForTab` cleans up after we're done).
 */
async function captureViaCdp(tabId) {
  await attachDebuggerForTab(tabId);
  // Page.captureScreenshot returns { data } where `data` is raw
  // base64 (no data: prefix). We wrap it to match the data-URL
  // shape callers expect from captureVisibleTab. format=png to
  // match the existing pipeline (the bridge / tool layer
  // assumes PNG).
  const result = await sendDebuggerCommand(tabId, 'Page.captureScreenshot', {
    format: 'png',
  });
  if (!result || typeof result.data !== 'string' || !result.data) {
    throw new Error('Page.captureScreenshot returned no data');
  }
  return `data:image/png;base64,${result.data}`;
}
