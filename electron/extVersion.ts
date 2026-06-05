/**
 * Single source of truth for the Chrome/Edge bridge extension's BUILD
 * number — the version the *app* ships and therefore expects the loaded
 * extension to be.
 *
 * Why a separate build number (not the manifest `version`): the extension is
 * loaded UNPACKED and does not auto-update, so an app update can ship newer
 * extension code while the user's Chrome keeps running the old service worker
 * until they manually reload it at chrome://extensions. The manifest version
 * didn't even change across a behavioral fix (it was 0.1.1 before and after
 * the screenshot CDP-fallback rewrite), so it can't distinguish builds. This
 * monotonic integer does: bump it (here AND in chrome-extension/service_worker.js,
 * which a test keeps in lockstep) whenever the extension's behavior changes.
 *
 * The bridge compares the build the extension reports in its `hello` handshake
 * against this value; if the extension is older (or doesn't report a build at
 * all — i.e. it predates the handshake), the connector status is flagged
 * stale and the Settings UI tells the user to reload it.
 *
 * History:
 *   1 — original screenshot path (5-attempt captureVisibleTab, no
 *       chrome.debugger CDP fallback, no un-minimize pre-flight). Fails on
 *       minimized / occluded / background windows with "image readback
 *       failed". (This build did NOT report `extBuild` in its hello, so it
 *       surfaces as build=null = stale.)
 *   2 — current: 3-attempt captureVisibleTab + CDP Page.captureScreenshot
 *       fallback + un-minimize pre-flight + the build-version handshake.
 */
export const EXTENSION_BUILD = 2;

/**
 * Pure staleness rule. The connected extension is "stale" when it's older
 * than the build the app ships — or reports no build at all (it predates the
 * handshake). Only meaningful while connected; we never warn when
 * disconnected/connecting/error.
 */
export function isExtensionStale(
  status: 'disconnected' | 'connecting' | 'connected' | 'error',
  extensionBuild: number | null,
  expected: number = EXTENSION_BUILD
): boolean {
  if (status !== 'connected') return false;
  if (extensionBuild == null) return true;
  return extensionBuild < expected;
}
