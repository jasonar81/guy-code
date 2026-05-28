// build/afterPack.js — electron-builder hook to ad-hoc sign the .app on macOS.
//
// WHY THIS EXISTS
// ---------------
// macOS on Apple Silicon hard-rejects any arm64 binary that lacks a code
// signature. The user sees "Guy Code is damaged and can't be opened" or
// "invalid binary" the moment they try to launch the app — and unlike the
// soft Gatekeeper warning on Intel, there is no right-click → Open
// workaround for this. It's a kernel rule.
//
// electron-builder 26.x exposes `mac.identity: "-"` as the documented
// ad-hoc-signing escape hatch (no Apple Developer cert required), but our
// pinned version is 25.1.8 and that version treats `"-"` as a literal cert
// name, looks it up in the keychain, finds nothing, and silently skips
// signing entirely. We confirmed this empirically against v0.1.8's first
// macOS build log:
//   • skipped macOS application code signing
//     reason=Identity name is specified, but no valid identity with this
//     name in the keychain identity=- allIdentities=0 identities found
//
// Rather than do a major-version bump of electron-builder (which risks
// breaking the Windows and Linux paths too), we patch around 25.x's
// behavior by running `codesign -s - --deep --force` ourselves in this
// afterPack hook. electron-builder calls afterPack after the .app bundle
// is fully assembled but before DMG/zip packaging — exactly the right
// moment to ad-hoc sign.
//
// WHAT THIS DOES
// --------------
// 1. No-op on non-macOS runners.
// 2. Walks the produced .app bundle and runs:
//      codesign --force --deep --sign - \
//               --entitlements build/entitlements.mac.plist \
//               --options runtime <App>.app
//    The `--deep` flag ensures every embedded helper, framework, and
//    binary inside the bundle gets signed (Electron's structure has 4+
//    embedded helpers). `--force` re-signs anything that came in with a
//    different ad-hoc sig from a previous run. `--options runtime` opts
//    into hardened runtime semantics so the entitlements file actually
//    matters; without it codesign would silently ignore the file.
// 3. Verifies the signature with `codesign --verify --deep --strict`. If
//    verification fails we throw — better to fail the CI build loudly
//    than to ship a DMG that still has the original problem.
//
// COSTS
// -----
// Adds ~5s to the macOS build. Zero impact on Windows / Linux runners.
//
// FUTURE
// ------
// When we buy an Apple Developer ID cert (~$99/year), we replace `-`
// with the cert's common name, flip `hardenedRuntime: true` in
// package.json, and add an afterSign hook that calls
// `@electron/notarize`. This afterPack file goes away or becomes a
// no-op. The entitlements file we wrote is forward-compatible with
// that flow.

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Run a command and surface its output. Throws on non-zero exit.
 * We avoid the `shell: true` option so app names with spaces ("Guy Code.app")
 * don't need escape gymnastics — execFileSync passes argv verbatim.
 */
function run(cmd, args, opts = {}) {
  console.log(`  + ${cmd} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

/**
 * electron-builder calls this with a context object describing what it just
 * packed. The relevant fields for us are:
 *   - electronPlatformName: 'darwin' on macOS, 'win32' / 'linux' elsewhere
 *   - appOutDir: filesystem path containing the freshly-built .app
 *   - packager.appInfo.productFilename: the .app name without the suffix
 */
exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  // Bail on non-mac runners so this file is a no-op for Windows / Linux.
  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = packager.appInfo.productFilename; // e.g. "Guy Code"
  const appPath = path.join(appOutDir, `${appName}.app`);
  const entitlements = path.join(
    packager.info.projectDir,
    'build',
    'entitlements.mac.plist',
  );

  // Sanity-check paths so the failure mode is "your config is wrong" instead
  // of a cryptic codesign error.
  if (!fs.existsSync(appPath)) {
    throw new Error(`afterPack: expected .app at ${appPath} but it does not exist`);
  }
  if (!fs.existsSync(entitlements)) {
    throw new Error(
      `afterPack: entitlements file not found at ${entitlements}. ` +
        `Did build/entitlements.mac.plist get stripped from the source sync?`,
    );
  }

  console.log(`\n[afterPack] ad-hoc signing ${appPath}`);
  console.log(`[afterPack] entitlements:    ${entitlements}\n`);

  // The order of arguments matters to codesign:
  //   --force         — replace any existing sig (important when the build
  //                     is re-run on a cached runner)
  //   --deep          — recursively sign every nested bundle (Electron has
  //                     Frameworks/, Helpers/, etc.)
  //   --sign -        — ad-hoc identity (the literal dash)
  //   --options runtime — opt into hardened-runtime semantics so the
  //                     entitlements file is actually consulted
  //   --entitlements <plist> — the file we wrote at build/entitlements.mac.plist
  //   --timestamp=none — don't try to contact Apple's timestamp server
  //                     (we don't have a real cert; would just be a wasted
  //                     network round-trip + occasional CI flake)
  run('codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--options',
    'runtime',
    '--entitlements',
    entitlements,
    '--timestamp=none',
    appPath,
  ]);

  // Verify the signature applied cleanly. If this throws, the macOS build
  // fails loudly in CI and we know about it before users hit the same
  // "invalid binary" error.
  console.log('\n[afterPack] verifying signature');
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);

  // spctl --assess will report "rejected" for ad-hoc signatures, which is
  // expected (Gatekeeper only accepts Apple-issued certs). We don't fail
  // on this — it's informational. The interesting question is whether
  // codesign --verify passed, which it did if we got here.
  try {
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  } catch {
    console.log('\n[afterPack] spctl rejected (expected for ad-hoc signing)');
  }

  console.log('\n[afterPack] done — .app is now ad-hoc signed and should\n' +
              '             launch on Apple Silicon after a one-time\n' +
              '             right-click → Open in Finder.\n');
};
