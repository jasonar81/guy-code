#!/usr/bin/env node
/**
 * Compile the Windows app-automation helper (native/win/GuyCodeAppHelper.cs)
 * into build/helper/GuyCodeAppHelper.exe.
 *
 * Uses csc.exe — the .NET Framework C# compiler that ships with every Windows
 * 10/11 install — so NO .NET SDK is required. The helper references
 * System.Drawing + UI Automation, all part of .NET Framework 4.x, so there's
 * no runtime to bundle either.
 *
 * This is a no-op on non-Windows hosts (the helper is Windows-only; the Linux
 * backend uses Xvfb/xdotool instead). electron-builder ships the produced exe
 * via the win `extraResources` config.
 *
 * Usage: node scripts/build-helper.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('[build-helper] non-Windows host — skipping (helper is Windows-only).');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
const src = path.join(ROOT, 'native', 'win', 'GuyCodeAppHelper.cs');
const outDir = path.join(ROOT, 'build', 'helper');
const out = path.join(outDir, 'GuyCodeAppHelper.exe');

if (!fs.existsSync(src)) {
  console.error(`[build-helper] source not found: ${src}`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

// Locate csc.exe (prefer 64-bit Framework).
const fwDirs = [
  'C:\\Windows\\Microsoft.NET\\Framework64',
  'C:\\Windows\\Microsoft.NET\\Framework',
];
let csc = null;
for (const dir of fwDirs) {
  if (!fs.existsSync(dir)) continue;
  const versions = fs
    .readdirSync(dir)
    .filter((v) => v.startsWith('v4.'))
    .sort()
    .reverse();
  for (const v of versions) {
    const cand = path.join(dir, v, 'csc.exe');
    if (fs.existsSync(cand)) {
      csc = cand;
      break;
    }
  }
  if (csc) break;
}
if (!csc) {
  console.error('[build-helper] csc.exe not found under Microsoft.NET\\Framework64/Framework.');
  process.exit(1);
}

// Resolve assembly paths. System.Drawing resolves by bare name against the
// framework dir, but the WPF/UIA assemblies (UIAutomationClient,
// UIAutomationTypes, WindowsBase) live in the GAC and csc can't find them by
// bare name — so resolve their full paths with PowerShell's
// Assembly.LoadWithPartialName and pass those.
function resolveGac(name) {
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `[System.Reflection.Assembly]::LoadWithPartialName('${name}').Location`,
    ],
    { encoding: 'utf8' }
  );
  const loc = (ps.stdout || '').trim();
  return loc && fs.existsSync(loc) ? loc : null;
}

const refs = ['System.Drawing.dll'];
for (const gac of ['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase']) {
  const p = resolveGac(gac);
  if (!p) {
    console.error(`[build-helper] could not resolve GAC assembly ${gac}`);
    process.exit(1);
  }
  refs.push(p);
}

const args = [
  '/nologo',
  '/platform:x64',
  '/target:exe',
  `/out:${out}`,
  ...refs.map((r) => `/reference:${r}`),
  src,
];

console.log(`[build-helper] csc: ${csc}`);
console.log(`[build-helper] compiling ${src} -> ${out}`);
const r = spawnSync(csc, args, { encoding: 'utf8' });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
if (r.status !== 0 || !fs.existsSync(out)) {
  console.error(`[build-helper] FAILED (csc exit ${r.status}).`);
  process.exit(1);
}
console.log('[build-helper] OK — built ' + out);
