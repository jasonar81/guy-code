/**
 * The WaitForCondition check runner, on its own so it can be shared.
 *
 * It used to live in tools.ts, which imports electron-log and db.ts. The
 * Claude Code plugin's daemon (integrations/claude-code-a2a) runs A2A watches
 * with exactly the same shell handling as Guy Code (design 5.5, 7.2), and it
 * must not pull in Electron, so the runner moved here. tools.ts re-exports it
 * unchanged, so every existing caller and test mock keeps working.
 */
import { spawn } from 'node:child_process';

export interface ConditionCheckResult {
  /** Process exit code (or a sentinel if it couldn't run). */
  code: number;
  /**
   * Whether the check command actually LAUNCHED and ran to completion. False
   * means the shell/command couldn't even start (ENOENT) or timed out - a
   * BROKEN check, which must be surfaced to the user, NOT silently treated as
   * "condition not met yet" (which would loop forever).
   */
  launched: boolean;
  /** Short detail for the broken-check case (e.g. the spawn error). */
  detail?: string;
  /**
   * The tail of stdout + stderr (interleaved as it arrived, capped at the last
   * 16 KB). WaitForCondition ignores it; the A2A watch extension puts the last
   * 20 lines in the task's artifact (design 5.5).
   */
  output?: string;
}

/** How much check output runConditionCheck keeps (the tail). */
const CONDITION_OUTPUT_TAIL_BYTES = 16 * 1024;

/**
 * Run a WaitForCondition check command. Resolves with the exit code AND whether
 * it actually launched, so callers can distinguish "ran and said not-ready"
 * from "couldn't run at all". NEVER throws.
 *
 * On Windows a `bash` check is routed through `wsl.exe bash -lc` (plain `bash`
 * isn't on PATH there); on other platforms it's `bash -lc` directly.
 */
export function runConditionCheck(
  command: string,
  cwd: string,
  shell: 'powershell' | 'bash',
  timeoutMs = 60_000
): Promise<ConditionCheckResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ConditionCheckResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      let cmd: string;
      let args: string[];
      if (shell === 'bash') {
        if (process.platform === 'win32') {
          // No direct `bash` on Windows - go through WSL (matches the WSL tool).
          cmd = 'wsl.exe';
          args = ['bash', '-lc', command];
        } else {
          cmd = 'bash';
          args = ['-lc', command];
        }
      } else {
        cmd = 'powershell.exe';
        args = ['-NoProfile', '-NonInteractive', '-Command', command];
      }
      const child = spawn(cmd, args, { cwd, windowsHide: true });
      // Keep only a bounded tail of the output: a chatty check run every
      // minute for days must not grow memory.
      let tail = Buffer.alloc(0);
      const collect = (b: Buffer) => {
        tail = Buffer.concat([tail, b]);
        if (tail.length > CONDITION_OUTPUT_TAIL_BYTES) tail = tail.subarray(tail.length - CONDITION_OUTPUT_TAIL_BYTES);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const output = () => tail.toString('utf8');
      const killer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        done({ code: 124, launched: false, detail: `check timed out after ${timeoutMs}ms`, output: output() });
      }, timeoutMs);
      child.on('error', (e) => {
        clearTimeout(killer);
        done({ code: 125, launched: false, detail: `could not launch ${cmd}: ${(e as Error).message}` });
      });
      child.on('close', (code) => {
        clearTimeout(killer);
        done({ code: typeof code === 'number' ? code : 1, launched: true, output: output() });
      });
    } catch (e) {
      done({ code: 125, launched: false, detail: `spawn failed: ${(e as Error).message}` });
    }
  });
}
