# Releasing Guy Code

End-to-end checklist for shipping a new version. Most of the work is automated by `.github/workflows/release.yml`; the manual parts are bumping the version and reviewing the draft release.

## One-time setup

You don't need to do anything special for the first release. The GitHub Actions workflow uses `secrets.GITHUB_TOKEN` (auto-provided) to publish releases. No personal access token needed.

## Cutting a release

1. **Bump the version.**

   ```sh
   npm version patch    # 0.1.0 → 0.1.1, bug-fix-only
   npm version minor    # 0.1.0 → 0.2.0, new features, no breaking changes
   npm version major    # 0.1.0 → 1.0.0, breaking changes
   ```

   `npm version` updates `package.json`, creates a commit, and creates a `vX.Y.Z` git tag in one step.

2. **Push commit and tag.**

   ```sh
   git push
   git push --tags
   ```

   The tag push triggers `.github/workflows/release.yml`. You can watch progress at https://github.com/jasonar81/guy-code/actions.

3. **Wait for the build.** Three runners (macOS, Windows, Linux) build in parallel. Total time: ~10-15 minutes typically.

4. **Review the draft release.** Once all three platforms finish, head to https://github.com/jasonar81/guy-code/releases. There's a draft release named `vX.Y.Z` with these assets:

   | Asset | Platform | Notes |
   | --- | --- | --- |
   | `Guy.Code-X.Y.Z.dmg` | macOS Universal | Drag-to-Applications installer |
   | `Guy.Code-X.Y.Z-mac.zip` | macOS | Auto-update payload |
   | `latest-mac.yml` | macOS | electron-updater manifest |
   | `Guy.Code.Setup.X.Y.Z.exe` | Windows | NSIS installer with Start Menu shortcut |
   | `Guy.Code-X.Y.Z.exe` | Windows | Portable single-exe |
   | `latest.yml` | Windows | electron-updater manifest |
   | `Guy.Code-X.Y.Z.AppImage` | Linux | Run-anywhere binary |
   | `guy-code_X.Y.Z_amd64.deb` | Linux | Debian/Ubuntu package |
   | `latest-linux.yml` | Linux | electron-updater manifest |

   The three `latest*.yml` files are critical — without them, the in-app auto-updater can't verify that an update is genuine.

5. **Write release notes.** GitHub auto-generates a "what's new" list from PR titles, but you should rewrite it for users. Focus on user-visible changes:

   ```markdown
   ## What's new

   - Drag-to-select upward in the chat now actually scrolls (#42)
   - Chrome screenshot works on minimized windows (#43)
   - Auto-update from GitHub Releases (#44)

   ## Bug fixes

   - Sleeping-budget sessions now restore correctly across restart (#41)
   ```

6. **Click "Publish release."** Users on existing installs see the update banner within 4 hours (the auto-updater poll interval). New users get the latest installer from the release page.

## Local builds (no release)

Test the installer pipeline without publishing:

```sh
npm run pack         # Build app directory only (no installer) — fastest
npm run dist         # Build installer for current platform
npm run dist:mac     # macOS only (requires macOS host)
npm run dist:win     # Windows only
npm run dist:linux   # Linux only
```

Output lands in `release/`.

## Hotfix releases

If a release is broken, the cleanest path is to bump-fix-and-tag again:

```sh
git checkout main
# fix the bug
git commit -am 'Fix: <description>'
npm version patch
git push --follow-tags
```

The new tag triggers a new release. Don't try to mutate an already-published release — auto-updaters that already saw the old `latest*.yml` will refuse to downgrade.

## Disabling auto-update for a user

If a user's auto-update is causing problems (rate-limited, broken proxy, etc.), they can disable polling:

```
Settings → Updates → "Check for updates automatically" off
```

This sets `update.autoCheck=0` in the SQLite settings table. Manual "Check for updates" still works.

Or directly:

```sh
sqlite3 ~/.guycode/guy.sqlite \
  "INSERT OR REPLACE INTO settings(key,value) VALUES('update.autoCheck','0');"
```

## Code signing (deferred — not needed for v1)

Without code signing:
- **macOS:** users see "Guy Code can't be opened because Apple cannot check it" on first run. Right-click → Open works.
- **Windows:** SmartScreen warns "Windows protected your PC." More info → Run anyway.

Auto-update works either way.

When we add signing later:

| Platform | What you need | How to wire |
| --- | --- | --- |
| macOS | Apple Developer cert ($99/yr) + notarization | Set `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` in repo secrets. electron-builder reads them automatically. |
| Windows | Code-signing cert ($200-400/yr) or EV cert ($500/yr) | Set `CSC_LINK` + `CSC_KEY_PASSWORD` in repo secrets. EV cert gives instant SmartScreen reputation. |

Add the secrets to `.github/workflows/release.yml`'s `env:` block. Nothing else changes.
