# Build resources

`electron-builder` reads icons and other resources from this folder during installer creation. Add the following files before running `npm run dist`:

| File | Format | Required for | Notes |
| --- | --- | --- | --- |
| `icon.icns` | Apple icon | macOS `.dmg` / `.zip` | 512×512 minimum, 1024×1024 recommended. Generate from a 1024×1024 PNG with `iconutil -c icns icon.iconset/`. |
| `icon.ico` | Windows icon | Windows NSIS / portable | Multi-resolution `.ico` containing 16, 32, 48, 64, 128, 256 px. ImageMagick: `magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico`. |
| `icon.png` | PNG | Linux AppImage / `.deb` | 512×512 PNG, alpha channel ok. |

## Running a local installer build

After adding the icons:

```sh
npm run dist:win    # Windows NSIS + portable
npm run dist:mac    # macOS dmg + zip (requires macOS host)
npm run dist:linux  # Linux AppImage + deb
npm run dist        # Current platform only
```

Output lands in `release/`.

## Without icons

Builds will succeed without these files; `electron-builder` falls back to its default Electron icon. Cosmetic only — auto-update and installer mechanics work either way.

## Code signing (deferred)

For broader distribution we'd add:

- macOS: Apple Developer cert ($99/yr) + notarization step. Set `CSC_LINK` / `CSC_KEY_PASSWORD` env vars before `dist:mac`.
- Windows: code-signing cert ($200-400/yr) or EV cert (~$500/yr) for instant SmartScreen reputation. Same env-var pattern.

Until then, users see "unidentified developer" on macOS first launch (right-click → Open) and SmartScreen warning on Windows (More info → Run anyway). Auto-update still works.
