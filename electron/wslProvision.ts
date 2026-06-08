// WSL provisioning + transport for the Linux-VM app-automation mode on Windows.
//
// WSL2 is a lightweight Linux VM built into Windows. We run our existing Linux
// automation stack (Xvfb + openbox + xdotool + scrot/ImageMagick) INSIDE WSL,
// so Linux apps - including games/emulators (SDL/X11 device-state input) and
// drawing apps - can be driven with real input on a virtual display, isolated
// from the user's desktop. This is the device-state-app path the native
// Windows hidden-desktop backend cannot do.
//
// Responsibilities:
//   - detect whether WSL (v2) is installed + has a usable distro
//   - run commands inside WSL (with and without sudo)
//   - install the Linux dependencies + apps (needs sudo; password from
//     settings or a per-call prompt)
//   - offer to install WSL itself (wsl --install, elevated, one-time)
//
// The sudo password is read from encrypted settings (safeStorage) when the
// user opted to remember it, else passed per-call. We NEVER log it.

import { spawn, spawnSync } from 'node:child_process';
import log from 'electron-log';

/** The Linux packages the Linux-VM mode needs inside the distro. */
export const WSL_PACKAGES = [
  'xvfb',
  'openbox',
  'xdotool',
  'scrot',
  'imagemagick',
  'wmctrl',
  'x11-utils',
];

/** Optional apps we preinstall so "run an NES game" / "draw" work out of the box. */
export const WSL_APPS = [
  'fceux', // NES emulator
  'mtpaint', // lightweight drawing app
];

export interface WslStatus {
  installed: boolean; // wsl.exe present + a v2 distro available
  defaultDistro: string | null;
  depsInstalled: boolean; // our WSL_PACKAGES all present
  reason?: string; // human-readable status / what's missing
}

/** wsl.exe emits UTF-16LE; decode it to normal text. */
function decodeWsl(buf: Buffer): string {
  // Heuristic: lots of NUL bytes => UTF-16LE.
  if (buf.includes(0x00)) return buf.toString('utf16le');
  return buf.toString('utf8');
}

/** Run `wsl.exe <args>` (host-side), return {code, stdout, stderr}. */
function wslExe(args: string[], timeoutMs = 20_000): { code: number; out: string; err: string } {
  const r = spawnSync('wsl.exe', args, { timeout: timeoutMs, windowsHide: true });
  return {
    code: r.status ?? -1,
    out: r.stdout ? decodeWsl(r.stdout) : '',
    err: r.stderr ? decodeWsl(r.stderr) : '',
  };
}

/** Is WSL installed with at least one distro? */
export function isWslInstalled(): boolean {
  const r = wslExe(['-l', '-q'], 10_000);
  if (r.code !== 0) return false;
  const distros = r.out
    .split(/\r?\n/)
    .map((s) => s.replace(/\u0000/g, '').trim())
    .filter(Boolean);
  return distros.length > 0;
}

/** Default distro name, or null. */
export function defaultDistro(): string | null {
  const r = wslExe(['-l', '-q'], 10_000);
  if (r.code !== 0) return null;
  const distros = r.out
    .split(/\r?\n/)
    .map((s) => s.replace(/\u0000/g, '').trim())
    .filter(Boolean);
  return distros[0] ?? null;
}

/**
 * Run a bash command inside the default WSL distro (no sudo).
 * Returns {code, out, err}. Uses `bash -lc` for a login shell (PATH etc).
 */
export function runInWsl(
  bashCommand: string,
  timeoutMs = 30_000
): { code: number; out: string; err: string } {
  // Use `bash -c` (NON-login) on purpose: WSLg's login profile resets DISPLAY
  // to :0 (its own X server), which would clobber our Xvfb display. A
  // non-login shell still has the standard PATH (tools live in /usr/bin), so
  // DISPLAY=:N survives.
  const r = spawnSync('wsl.exe', ['-e', 'bash', '-c', bashCommand], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: r.status ?? -1,
    out: r.stdout ? r.stdout.toString('utf8') : '',
    err: r.stderr ? r.stderr.toString('utf8') : '',
  };
}

/**
 * Run a bash command in WSL with sudo, feeding the password via `sudo -S`.
 * The password is passed on stdin (never on the command line / never logged).
 */
export function runInWslSudo(
  bashCommand: string,
  sudoPassword: string,
  timeoutMs = 600_000
): { code: number; out: string; err: string } {
  // `sudo -S -p ''` reads the password from stdin with no prompt text.
  const wrapped = `sudo -S -p '' bash -lc ${shellQuote(bashCommand)}`;
  const r = spawnSync('wsl.exe', ['-e', 'bash', '-lc', wrapped], {
    timeout: timeoutMs,
    windowsHide: true,
    input: sudoPassword + '\n',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: r.status ?? -1,
    out: r.stdout ? r.stdout.toString('utf8') : '',
    err: r.stderr ? r.stderr.toString('utf8') : '',
  };
}

/** Single-quote a string for safe embedding in a bash -lc argument. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Are all our WSL packages present in the distro? */
export function depsInstalled(): boolean {
  // `command -v` each tool; if any is missing the && chain fails.
  const checks = ['Xvfb', 'openbox', 'xdotool', 'scrot', 'import', 'wmctrl']
    .map((t) => `command -v ${t} >/dev/null 2>&1`)
    .join(' && ');
  const r = runInWsl(checks, 15_000);
  return r.code === 0;
}

/** Verify a sudo password works (cheap `sudo -S true`). */
export function verifySudoPassword(sudoPassword: string): boolean {
  const r = runInWslSudo('true', sudoPassword, 15_000);
  return r.code === 0;
}

/** Full status snapshot for the settings UI / preflight. */
export function getWslStatus(): WslStatus {
  if (!isWslInstalled()) {
    return {
      installed: false,
      defaultDistro: null,
      depsInstalled: false,
      reason:
        'WSL (Windows Subsystem for Linux) is not installed. The Linux app-automation features (games, drawing, device-state apps) need it. Guy Code can install it for you, or run `wsl --install` in an elevated terminal.',
    };
  }
  const distro = defaultDistro();
  const deps = depsInstalled();
  return {
    installed: true,
    defaultDistro: distro,
    depsInstalled: deps,
    reason: deps
      ? `WSL ready (${distro}).`
      : `WSL is installed (${distro}) but the Linux automation tools aren't set up yet. Guy Code can install them (needs your WSL sudo password).`,
  };
}

/**
 * Install the Linux deps + apps into the distro. Needs sudo. Returns a result
 * with a human message. Idempotent (apt-get install is safe to re-run).
 */
export function installDeps(sudoPassword: string): { ok: boolean; message: string } {
  if (!isWslInstalled()) {
    return { ok: false, message: 'WSL is not installed.' };
  }
  if (!verifySudoPassword(sudoPassword)) {
    return { ok: false, message: 'The WSL sudo password was not accepted.' };
  }
  log.info('[wslProvision] installing Linux deps + apps into WSL');
  const pkgs = [...WSL_PACKAGES, ...WSL_APPS].join(' ');
  const r = runInWslSudo(
    `DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkgs}`,
    sudoPassword,
    900_000
  );
  if (r.code !== 0) {
    return {
      ok: false,
      message: `apt-get install failed: ${(r.err || r.out).trim().slice(0, 400)}`,
    };
  }
  if (!depsInstalled()) {
    return { ok: false, message: 'Install ran but some tools are still missing.' };
  }
  // Also configure the WSL boot hook so Xvfb works (see configureWslBoot).
  const boot = configureWslBoot(sudoPassword);
  if (!boot.ok) {
    return { ok: false, message: `deps installed but boot config failed: ${boot.message}` };
  }
  return {
    ok: true,
    message:
      'Linux automation tools + apps installed in WSL. Restart of the WSL distro applied the display fix.',
  };
}

/**
 * Write /etc/wsl.conf with a [boot] command that fixes the X11 socket dir
 * (/tmp/.X11-unix) at every WSL boot. WSLg mounts that dir READ-ONLY at mode
 * 777, but Xvfb refuses to bind unless it's 1777 (sticky bit). The boot
 * command runs as root automatically on every WSL start, so after this is set
 * once, Xvfb works with NO per-launch sudo. We then terminate the distro so
 * the hook takes effect immediately.
 */
export function configureWslBoot(sudoPassword: string): { ok: boolean; message: string } {
  // Heredoc-free: write the file with printf to avoid quoting surprises.
  const wslConf = [
    '[boot]',
    'command = "/bin/sh -c \\"umount /tmp/.X11-unix 2>/dev/null; rm -rf /tmp/.X11-unix; mkdir -p /tmp/.X11-unix; chmod 1777 /tmp/.X11-unix\\""',
  ].join('\n');
  const r = runInWslSudo(
    `printf '%s\\n' ${shellQuote(wslConf)} > /etc/wsl.conf && echo OK`,
    sudoPassword,
    20_000
  );
  if (r.code !== 0 || !/OK/.test(r.out)) {
    return { ok: false, message: `could not write /etc/wsl.conf: ${(r.err || r.out).slice(0, 200)}` };
  }
  // Apply now by terminating the distro (next launch re-boots with the hook).
  terminateDistro();
  return { ok: true, message: 'WSL boot hook configured.' };
}

/** Terminate the default distro so the next command boots it fresh. */
export function terminateDistro(): void {
  const distro = defaultDistro();
  if (!distro) return;
  spawnSync('wsl.exe', ['--terminate', distro], { timeout: 15_000, windowsHide: true });
}

/**
 * Best-effort: ensure the X11 socket dir is usable for THIS WSL session,
 * without needing sudo (the boot hook should already have done it). Returns
 * true if Xvfb can bind. Cheap to call before a launch.
 */
export function displaySocketReady(): boolean {
  const r = runInWsl(`stat -c '%a' /tmp/.X11-unix 2>/dev/null`, 6000);
  return (r.out || '').trim() === '1777';
}

/**
 * Offer to install WSL itself. `wsl --install` requires elevation and a reboot
 * on first-ever install. We launch it elevated; the user completes any reboot.
 * Returns immediately after kicking it off (it's long + interactive).
 */
export function installWsl(): { ok: boolean; message: string } {
  try {
    // Launch elevated via PowerShell Start-Process -Verb RunAs.
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Start-Process wsl.exe -ArgumentList '--install' -Verb RunAs",
      ],
      { windowsHide: true, detached: true, stdio: 'ignore' }
    ).unref();
    return {
      ok: true,
      message:
        'Started WSL installation (you may see a UAC prompt and need to reboot once). After it finishes and reboots, open Settings again to install the Linux tools.',
    };
  } catch (e: any) {
    return { ok: false, message: `Could not start WSL install: ${e?.message ?? e}` };
  }
}
