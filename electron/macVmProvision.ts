// macOS Linux-guest provisioning via QEMU.
//
// macOS can't isolate native app automation (one WindowServer; synthetic input
// is shared/disruptive), so the Linux-VM mode is the ONLY automation path on
// Mac. We boot a small Linux guest with QEMU (accelerated by Apple's Hypervisor
// framework: `-accel hvf`), running the same Xvfb + xdotool + scrot stack as
// the Windows WSL path, and drive it over SSH to a forwarded port.
//
// QEMU is provisioned via Homebrew if present, else the user is told how to get
// it. The guest disk image (a prebuilt minimal Linux with our deps + apps) is
// downloaded on first setup into the app's userData dir. Booting maps an SSH
// port (host 127.0.0.1:<port> -> guest 22) for the transport.
//
// This module owns: detection/status, qemu/image acquisition, boot/shutdown,
// and exposing an ssh-exec the Mac backend uses (mirroring runInWsl).

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log';

const GUEST_SSH_PORT = 0; // assigned at boot
let _vm: { proc: ChildProcess; sshPort: number } | null = null;

function dataDir(): string {
  const d = join(app.getPath('userData'), 'linux-vm');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return p && existsSync(p) ? p : null;
}

/** qemu binary appropriate for this Mac's arch (arm64 vs x86_64). */
export function qemuBinary(): string | null {
  const isArm = process.arch === 'arm64';
  const candidates = isArm
    ? ['qemu-system-aarch64', 'qemu-system-x86_64']
    : ['qemu-system-x86_64'];
  for (const c of candidates) {
    const p = which(c);
    if (p) return p;
  }
  return null;
}

/** Path to the guest disk image once downloaded. */
function guestImagePath(): string {
  return join(dataDir(), 'guest.qcow2');
}

export interface MacVmStatus {
  ready: boolean;
  qemu: boolean;
  image: boolean;
  reason: string;
}

export function getMacVmStatus(): MacVmStatus {
  if (process.platform !== 'darwin') {
    return { ready: false, qemu: false, image: false, reason: 'not macOS' };
  }
  const qemu = !!qemuBinary();
  const image = existsSync(guestImagePath());
  if (!qemu) {
    return {
      ready: false,
      qemu: false,
      image,
      reason:
        'The Linux-VM mode on macOS needs QEMU. Install it with Homebrew (`brew install qemu`), then set up the Linux guest in Settings > Linux app automation.',
    };
  }
  if (!image) {
    return {
      ready: false,
      qemu: true,
      image: false,
      reason:
        'QEMU is installed but the Linux guest image isn\'t set up yet. Use Settings > Linux app automation to download it (one-time).',
    };
  }
  return { ready: true, qemu: true, image: true, reason: 'Linux-VM ready.' };
}

/** Pick a free localhost port for SSH forwarding. */
function pickPort(): number {
  // Ephemeral high port; collisions are retried by the OS on bind in practice.
  return 20000 + Math.floor(Math.random() * 20000);
}

/**
 * Boot the Linux guest if not already running. Returns the SSH port. Uses HVF
 * acceleration. The guest is headless (we drive Xvfb inside it, captured via
 * import + SSH), so no display window appears on the Mac.
 */
export async function bootGuest(): Promise<number> {
  if (_vm) return _vm.sshPort;
  const st = getMacVmStatus();
  if (!st.ready) throw new Error(st.reason);
  const qemu = qemuBinary()!;
  const sshPort = pickPort();
  const isArm = process.arch === 'arm64';

  const args = [
    '-accel', 'hvf',
    '-cpu', 'host',
    '-smp', '2',
    '-m', '2048',
    '-nographic',
    '-drive', `file=${guestImagePath()},if=virtio,format=qcow2`,
    '-netdev', `user,id=net0,hostfwd=tcp::${sshPort}-:22`,
    '-device', 'virtio-net,netdev=net0',
  ];
  if (isArm) {
    args.unshift('-machine', 'virt,highmem=on');
  } else {
    args.unshift('-machine', 'q35');
  }

  log.info(`[macVmProvision] booting Linux guest (ssh port ${sshPort})`);
  const proc = spawn(qemu, args, { stdio: 'ignore' });
  _vm = { proc, sshPort };
  proc.on('exit', () => {
    _vm = null;
  });

  // Wait for SSH to come up.
  for (let i = 0; i < 60; i++) {
    await delay(1000);
    if (sshExec('true', 4000).code === 0) return sshPort;
  }
  throw new Error('Linux guest did not become reachable over SSH within 60s');
}

/** Run a bash command in the guest over SSH; mirrors runInWsl's shape. */
export function sshExec(
  bashCommand: string,
  timeoutMs = 30_000
): { code: number; out: string; err: string } {
  if (!_vm) return { code: -1, out: '', err: 'guest not booted' };
  const keyPath = join(dataDir(), 'guest_key');
  const r = spawnSync(
    'ssh',
    [
      '-i', keyPath,
      '-p', String(_vm.sshPort),
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-o', 'ConnectTimeout=5',
      'guest@127.0.0.1',
      bashCommand,
    ],
    { timeout: timeoutMs, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  );
  return {
    code: r.status ?? -1,
    out: r.stdout ? r.stdout.toString('utf8') : '',
    err: r.stderr ? r.stderr.toString('utf8') : '',
  };
}

/**
 * One-time setup of the Linux guest on macOS: ensure QEMU is present and
 * download the prebuilt guest image (a minimal Linux with Xvfb + xdotool +
 * scrot + an NES emulator + a drawing app + sshd + our key baked in) into the
 * app's data dir. The image URL is configurable; ships disabled until an image
 * is published. Returns a human-readable result.
 */
export async function setupMacGuest(imageUrl?: string): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== 'darwin') return { ok: false, message: 'macOS only.' };
  if (!qemuBinary()) {
    return {
      ok: false,
      message: 'QEMU is not installed. Install it first: `brew install qemu`.',
    };
  }
  if (existsSync(guestImagePath())) {
    return { ok: true, message: 'Linux guest image already present.' };
  }
  const url = imageUrl || GUEST_IMAGE_URL;
  if (!url) {
    return {
      ok: false,
      message:
        'No guest image URL configured. The macOS Linux guest image needs to be published before this can auto-download; until then, place a prepared guest.qcow2 in the app data dir.',
    };
  }
  try {
    log.info('[macVmProvision] downloading Linux guest image');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { writeFileSync } = await import('node:fs');
    writeFileSync(guestImagePath(), buf);
    return { ok: true, message: 'Linux guest image downloaded.' };
  } catch (e: any) {
    return { ok: false, message: `Could not download guest image: ${e?.message ?? e}` };
  }
}

/** Configurable URL for the prebuilt guest image (empty until published). */
const GUEST_IMAGE_URL = '';

export function shutdownGuest(): void {
  if (_vm) {
    try {
      sshExec('sudo poweroff', 3000);
    } catch {
      /* ignore */
    }
    try {
      _vm.proc.kill();
    } catch {
      /* ignore */
    }
    _vm = null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
