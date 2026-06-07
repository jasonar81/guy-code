// Tool registry: schemas (sent to model) + executors (run locally).
// Phase 2 set: Read, Write, Edit, Bash/PowerShell, Grep, Glob, TodoWrite, WaitForUser.
// Each tool returns a string (or structured content) that the model receives
// as the tool_result block in the next turn.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, isAbsolute, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import log from 'electron-log';
import { setSessionState, setSessionWakeAt } from './db';
import {
  listClaudeSkills,
  recallFromDisk,
  saveMemory,
  setMemoryPriority,
  listGuyMemory,
  listClaudeMemory,
  deleteGuyMemory,
} from './memory';
import type { MemoryBundle, MemoryTier } from './memory';
import { broadcastStateChanged } from './agentEvents';
import { getMcpToolSchemas, invokeMcpTool } from './mcp';
import { loadMessagesWithTsFromJsonl, ourJsonlPath } from './sessionRuntime';

export interface ToolContext {
  sessionId: string;
  cwd: string;
  /**
   * Project identifier. For Guy-owned per-project memory writes, this is the
   * directory key under `~/.guycode/projects/<projectId>/memory`. May be a
   * `__guy_*` synthetic id for cwd-less sessions; the save tool will refuse
   * 'project' scope in that case and steer the model toward 'global'.
   */
  projectId?: string;
  /** Memory bundle loaded at session start, used by recall_memory. */
  memory?: MemoryBundle;
  /** Abort signal so blocking tools can wake on user-initiated cancel. */
  signal?: AbortSignal;
  /**
   * API key id this turn is being charged to. Currently consumed by the
   * subagent tools (`Task` / `Plan` / `Execute` / `Review`) so the child
   * call lands in the same per-key budget bucket and ledger as the
   * parent. Other tools ignore it.
   */
  apiKeyId?: string | null;
}

/**
 * Image content block for tool results. Mirrors the Anthropic API
 * shape exactly so we can pass it through to the SDK without
 * conversion. PNG / JPEG / GIF / WebP are the supported media types
 * (the same set Anthropic accepts in user-uploaded images).
 */
export type ToolResultImageBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;
  };
};

export type ToolResultTextBlock = { type: 'text'; text: string };

/**
 * Structured tool result. Lets a tool ship images (or other rich
 * blocks) to the model while giving the UI a plain-text summary
 * for the tool-call card. The model sees `modelContent` verbatim;
 * the UI sees `uiSummary`.
 *
 * Used today by `BrowserScreenshot` so the model receives the
 * actual image bytes instead of a file path. Most tools should
 * keep returning a plain string — only reach for this shape when
 * the model genuinely needs to see binary data.
 */
export interface StructuredToolResult {
  modelContent: Array<ToolResultTextBlock | ToolResultImageBlock>;
  uiSummary: string;
  /**
   * Persistent-sleep signal. Forwarded to `ExecutedToolResult.sleepUntil`
   * by `executeTool` and consumed by the agent loop. See the
   * `sleepUntil` doc on `ExecutedToolResult` for the full lifecycle.
   * Optional so the existing structured-result callers (today only
   * `BrowserScreenshot`) don't have to set it.
   */
  sleepUntil?: number;
}

export interface ToolDef {
  schema: Anthropic.Tool;
  /**
   * Returns the content that goes into the tool_result. A plain
   * string is the common case; return a `StructuredToolResult`
   * when the model needs to see images or other rich blocks.
   */
  execute: (input: any, ctx: ToolContext) => Promise<string | StructuredToolResult>;
  /** If true, the agent loop ends after this tool with no follow-up. */
  endsTurn?: boolean;
}

/** Narrow type guard for structured results. */
export function isStructuredToolResult(
  v: unknown
): v is StructuredToolResult {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as StructuredToolResult).modelContent) &&
    typeof (v as StructuredToolResult).uiSummary === 'string'
  );
}

const isWin = process.platform === 'win32';

/**
 * One-time WSL availability probe at module load.
 *
 * On Windows we want to expose a dedicated `WSL` tool *only* when the
 * user has WSL installed and at least one distro registered. Probing
 * once at startup keeps the per-call cost zero and makes the tool
 * registry static (so the schemas the model sees don't change
 * mid-session).
 *
 * `wsl.exe --status` exits 0 on a healthy install, non-zero (or fails
 * to spawn) otherwise. We give it a small timeout because Microsoft's
 * own launcher occasionally takes ~1 s to respond on a cold boot, and
 * we don't want a wedged probe to block the whole electron startup.
 *
 * Linux/macOS: never available, short-circuit before spawning.
 */
const isWslAvailable: boolean = (() => {
  if (!isWin) return false;
  try {
    // Lazy require so non-Windows platforms don't even pay the
    // import cost. spawnSync is the only way to get a synchronous
    // "available?" answer at module evaluation time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const res = spawnSync('wsl.exe', ['--status'], {
      timeout: 2000,
      stdio: 'pipe',
      windowsHide: true,
    });
    // status === null when the spawn failed entirely (ENOENT, timeout)
    // or > 0 when wsl reported an error (no distros, service down).
    return res.status === 0;
  } catch {
    return false;
  }
})();

/**
 * Resolve a possibly-relative path against the session's cwd. When the
 * session has no cwd binding (Guy-created session, cwd = ''), relative
 * paths resolve against the user's home directory; absolute paths are
 * untouched. Users are expected to use absolute paths for anything outside
 * their home in cwd-less sessions.
 */
function resolveCwd(p: string, cwd: string): string {
  if (isAbsolute(p)) return p;
  const base = cwd && cwd.trim() ? cwd : homedir();
  return resolvePath(base, p);
}

/** Where to launch a subprocess when no explicit cwd is given. */
function defaultLaunchCwd(cwd: string): string {
  return cwd && cwd.trim() ? cwd : homedir();
}

function trimOutput(s: string, maxBytes = 32_000): string {
  if (s.length <= maxBytes) return s;
  const head = s.slice(0, maxBytes / 2);
  const tail = s.slice(-maxBytes / 2);
  return `${head}\n\n[... ${s.length - maxBytes} bytes truncated ...]\n\n${tail}`;
}

/**
 * Kill a child process AND any descendants it spawned. Plain `p.kill()` is
 * insufficient on Windows (SIGTERM is ignored by PowerShell, and child
 * processes the script started — python, nested cmd.exe, etc. — are not
 * touched at all). We use `taskkill /T /F /PID` on Windows to nuke the
 * whole tree, and SIGTERM-then-SIGKILL on Unix as a safety net for
 * processes that ignore polite termination.
 *
 * Called from any tool that spawns a subprocess and registers an abort
 * listener, so `cancelRun` actually translates to a dead child.
 */
function killProcessTree(p: { pid?: number; kill: (sig?: any) => boolean }): void {
  if (!p.pid) return;
  try {
    if (isWin) {
      // Detached so taskkill outlives any quirks in our event loop.
      // /T = terminate process tree, /F = force.
      const tk = spawn('taskkill', ['/T', '/F', '/PID', String(p.pid)], {
        detached: true,
        stdio: 'ignore',
      });
      tk.unref();
    } else {
      try {
        p.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      // Some scripts ignore SIGTERM (e.g. running a tight CPU loop in a
      // shell that hasn't installed a handler). Escalate after a beat.
      setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          /* exited cleanly */
        }
      }, 2000).unref();
    }
  } catch (e) {
    log.warn(`[tools] killProcessTree(${p.pid}) failed`, e);
  }
}

// ---- Read ----

const READ: ToolDef = {
  schema: {
    name: 'Read',
    description:
      'Read the contents of a file. Optional `offset` (1-indexed line) and `limit` (line count) for large files. Lines are 1-indexed in output.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or cwd-relative path.' },
        offset: { type: 'integer', description: '1-indexed start line.' },
        limit: { type: 'integer', description: 'Max lines to read.' },
      },
      required: ['file_path'],
    },
  },
  async execute(input, ctx) {
    const path = resolveCwd(input.file_path, ctx.cwd);
    if (!existsSync(path)) return `error: file not found: ${path}`;
    const stat = statSync(path);
    if (stat.isDirectory()) return `error: ${path} is a directory; use Glob or list its contents`;
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    const offset = Math.max(1, input.offset ?? 1);
    const limit = Math.max(1, input.limit ?? lines.length);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice
      .map((l, i) => `${(offset + i).toString().padStart(6)}\t${l}`)
      .join('\n');
    return trimOutput(numbered);
  },
};

// ---- Write ----

const WRITE: ToolDef = {
  schema: {
    name: 'Write',
    description:
      'Create or overwrite a file. The parent directory is created if missing.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
  },
  async execute(input, ctx) {
    const path = resolveCwd(input.file_path, ctx.cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.content, 'utf8');
    return `wrote ${input.content.length} chars to ${path}`;
  },
};

// ---- Edit ----

const EDIT: ToolDef = {
  schema: {
    name: 'Edit',
    description:
      'Find and replace exact strings in a file. `old_string` must be unique unless `replace_all` is true.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  async execute(input, ctx) {
    const path = resolveCwd(input.file_path, ctx.cwd);
    if (!existsSync(path)) return `error: file not found: ${path}`;
    const orig = readFileSync(path, 'utf8');
    if (input.old_string === input.new_string) return `error: old_string and new_string are identical`;
    const all = !!input.replace_all;
    let next: string;
    if (all) {
      next = orig.split(input.old_string).join(input.new_string);
      if (next === orig) return `error: old_string not found in file`;
    } else {
      const occ = orig.split(input.old_string).length - 1;
      if (occ === 0) return `error: old_string not found in file`;
      if (occ > 1)
        return `error: old_string occurs ${occ} times; pass replace_all=true or include more context to make it unique`;
      next = orig.replace(input.old_string, input.new_string);
    }
    writeFileSync(path, next, 'utf8');
    return `edited ${path}`;
  },
};

// ---- Bash / PowerShell ----

const SHELL: ToolDef = {
  schema: {
    name: isWin ? 'PowerShell' : 'Bash',
    description: `Run a ${isWin ? 'PowerShell' : 'Bash'} command. Returns combined stdout+stderr. Default timeout 120s, max 600s.`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer', description: 'Default 120000.' },
        cwd: { type: 'string', description: 'Override session cwd.' },
      },
      required: ['command'],
    },
  },
  async execute(input, ctx) {
    const timeout = Math.min(600_000, Math.max(1000, input.timeout_ms ?? 120_000));
    const cwd = input.cwd ? resolveCwd(input.cwd, ctx.cwd) : defaultLaunchCwd(ctx.cwd);
    return await new Promise<string>((resolve) => {
      const cmd = isWin ? 'powershell.exe' : 'bash';
      const args = isWin
        ? ['-NoProfile', '-NonInteractive', '-Command', input.command]
        : ['-lc', input.command];
      // stdin: 'ignore' (= /dev/null) is critical. Without it, child
      // processes that read stdin (most notably ssh, but also things
      // like sudo, gpg, and any CLI that prompts on first run) block
      // on the empty pipe forever. The user's interactive shell has a
      // TTY which lets those tools detect "no input now, but maybe
      // later" and skip the read; a piped stdin with no writer is
      // indistinguishable to the child from "input pending", so it
      // waits. The symptom we hit: `ssh net1 'echo alive; date'`
      // hanging at 30+ seconds in the app while working instantly
      // from PowerShell. With stdin closed, ssh sees EOF and either
      // skips interactive auth methods or fails fast — both are
      // strictly better than hanging.
      const p = spawn(cmd, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let timedOut = false;
      let abortedByUser = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(p);
      }, timeout);
      // User-initiated cancel: `cancelRun(sessionId)` aborts ctx.signal,
      // we kill the process tree (incl. any nested processes the script
      // spawned), and resolve with the captured output so far + a clear
      // marker the agent and user can see.
      const onAbort = () => {
        abortedByUser = true;
        log.info(`[tools] SHELL aborted by user pid=${p.pid}`);
        killProcessTree(p);
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      p.stdout.on('data', (b) => (out += b.toString()));
      p.stderr.on('data', (b) => (out += b.toString()));
      p.on('close', (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        const status = abortedByUser
          ? 'aborted by user'
          : timedOut
            ? `timed out after ${timeout}ms`
            : `exit ${code}`;
        resolve(trimOutput(`[${status}]\n${out}`));
      });
      p.on('error', (e) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve(`error: ${e.message}`);
      });
    });
  },
};

// ---- WSL (Windows-only, registered iff a working WSL install is found) ----
//
// On Windows the SHELL tool above runs PowerShell. That's the right
// default — it's the OS-native shell — but a non-trivial slice of
// useful CLI work is simpler in bash: jq filters, find with -exec,
// grep -P, tar pipelines, anything that uses Unix path separators
// natively, anything from the Linux-only ecosystem (some MCP servers,
// `code .` from a WSL-installed VS Code, etc.).
//
// Rather than make the agent prefix every command with `wsl --` from
// PowerShell (which works but mangles non-ASCII output through
// PowerShell's UTF-16 stdout) we expose WSL as a peer tool. The agent
// picks whichever shell suits the task — the description below lays
// out the choice explicitly.
//
// Tool is only registered when `wsl.exe --status` returned 0 at
// module load (see `isWslAvailable` above), so on a Windows machine
// without WSL the model never sees a tool that wouldn't work.

const WSL: ToolDef = {
  schema: {
    name: 'WSL',
    description:
      "Run a bash command inside WSL (Windows Subsystem for Linux). Returns combined stdout+stderr in UTF-8. Default timeout 120s, max 600s.\n\n" +
      "When to use this vs PowerShell:\n" +
      "  • WSL: Unix tools (jq, sed -E, grep -P, awk, find -exec), pipelines that depend on Unix utility flags, anything that needs a real Linux environment (Docker-in-WSL, snap, apt). Output is clean UTF-8 — non-ASCII characters survive intact.\n" +
      "  • PowerShell: Windows-native cmdlets (Get-Process, Get-ChildItem, Active Directory, Windows registry), .NET, COM, anything that touches Windows paths with backslashes that bash would mangle.\n\n" +
      "Cwd handling: the cwd you pass (or the session cwd) is interpreted as a Windows path. WSL auto-mounts the Windows filesystem under /mnt/<drive>, so `cwd: c:\\\\Users\\\\you\\\\proj` becomes `/mnt/c/Users/you/proj` inside bash automatically. To run inside the WSL filesystem (`/home/...`), `cd` to it as the first thing in the command — passing a WSL path as cwd doesn't work because spawn's cwd is Windows-resolved.\n\n" +
      "Login shell semantics: we invoke `bash -lc`, so your `~/.bashrc`, `~/.profile`, and PATH are loaded the same way an interactive WSL shell sees them.",
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer', description: 'Default 120000.' },
        cwd: {
          type: 'string',
          description:
            'Override session cwd. Pass a Windows path (e.g. c:\\path); WSL auto-mounts it.',
        },
      },
      required: ['command'],
    },
  },
  async execute(input, ctx) {
    const timeout = Math.min(600_000, Math.max(1000, input.timeout_ms ?? 120_000));
    const cwd = input.cwd ? resolveCwd(input.cwd, ctx.cwd) : defaultLaunchCwd(ctx.cwd);
    return await new Promise<string>((resolve) => {
      // `wsl.exe -- bash -lc <cmd>`:
      //   • The bare `--` tells wsl.exe to stop interpreting its own
      //     flags and pass everything after to the default distro.
      //   • `bash -lc` runs as a login shell so rc files are sourced
      //     and PATH / aliases / pyenv / nvm shims all work.
      // Same `stdio: ['ignore', 'pipe', 'pipe']` rationale as SHELL —
      // closing stdin prevents wedged-on-prompt hangs (gpg, ssh, sudo).
      const p = spawn('wsl.exe', ['--', 'bash', '-lc', input.command], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let timedOut = false;
      let abortedByUser = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(p);
      }, timeout);
      const onAbort = () => {
        abortedByUser = true;
        log.info(`[tools] WSL aborted by user pid=${p.pid}`);
        killProcessTree(p);
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      p.stdout.on('data', (b) => (out += b.toString()));
      p.stderr.on('data', (b) => (out += b.toString()));
      p.on('close', (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        const status = abortedByUser
          ? 'aborted by user'
          : timedOut
            ? `timed out after ${timeout}ms`
            : `exit ${code}`;
        resolve(trimOutput(`[${status}]\n${out}`));
      });
      p.on('error', (e) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve(`error: ${e.message}`);
      });
    });
  },
};

// ---- Grep (uses ripgrep if available, falls back to JS scan) ----

const GREP: ToolDef = {
  schema: {
    name: 'Grep',
    description:
      'Search file contents for a regex. Uses ripgrep if available. Returns matching lines.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory or file. Defaults to cwd.' },
        glob: { type: 'string', description: 'Glob filter, e.g. "*.ts".' },
        case_sensitive: { type: 'boolean' },
        max_results: { type: 'integer' },
      },
      required: ['pattern'],
    },
  },
  async execute(input, ctx) {
    const path = input.path ? resolveCwd(input.path, ctx.cwd) : defaultLaunchCwd(ctx.cwd);
    const args: string[] = ['--no-heading', '--with-filename', '-n'];
    if (!input.case_sensitive) args.push('-i');
    if (input.glob) args.push('-g', input.glob);
    args.push(input.pattern, path);
    return await new Promise<string>((resolve) => {
      const p = spawn('rg', args, { cwd: defaultLaunchCwd(ctx.cwd) });
      let out = '';
      let err = '';
      let abortedByUser = false;
      const onAbort = () => {
        abortedByUser = true;
        log.info(`[tools] GREP aborted by user pid=${p.pid}`);
        killProcessTree(p);
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      p.stdout.on('data', (b) => (out += b.toString()));
      p.stderr.on('data', (b) => (err += b.toString()));
      p.on('close', (code) => {
        ctx.signal?.removeEventListener('abort', onAbort);
        if (abortedByUser) {
          resolve('[aborted by user]');
          return;
        }
        if (code === 0 || code === 1) {
          const lines = out.split('\n').filter(Boolean);
          const max = input.max_results ?? 200;
          const truncated = lines.length > max;
          const shown = lines.slice(0, max).join('\n');
          resolve(truncated ? `${shown}\n[... ${lines.length - max} more matches ...]` : shown || '(no matches)');
        } else {
          resolve(`error: rg exit ${code}\n${err}`);
        }
      });
      p.on('error', (e) => {
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve(`error: ripgrep not available: ${e.message}`);
      });
    });
  },
};

// ---- Glob ----

const GLOB: ToolDef = {
  schema: {
    name: 'Glob',
    description:
      'List files matching a glob pattern (recursive ** supported). Returns up to 200 paths.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'e.g. **/*.ts or src/**/*.tsx' },
        path: { type: 'string', description: 'Search root. Defaults to cwd.' },
      },
      required: ['pattern'],
    },
  },
  async execute(input, ctx) {
    const root = input.path ? resolveCwd(input.path, ctx.cwd) : defaultLaunchCwd(ctx.cwd);
    const matches: string[] = [];
    const re = globToRegex(input.pattern);
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (matches.length >= 200) return;
        // Skip large/noisy dirs
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
          walk(join(dir, e.name));
        } else {
          const full = join(dir, e.name);
          const rel = full.slice(root.length + 1).replace(/\\/g, '/');
          if (re.test(rel)) matches.push(full);
        }
      }
    };
    walk(root);
    return matches.length === 0 ? '(no matches)' : matches.join('\n');
  },
};

function globToRegex(pat: string): RegExp {
  // Translate **, *, ? into regex. Not full glob compliance but sufficient.
  let re = '';
  let i = 0;
  while (i < pat.length) {
    const c = pat[i];
    if (c === '*' && pat[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (pat[i] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^$()|[]{}\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

// ---- TodoWrite ----

const TODOWRITE: ToolDef = {
  schema: {
    name: 'TodoWrite',
    description:
      'Set the current todo list for this session. Each todo has content, status (pending|in_progress|completed), and id. The active plan is persisted to the database — survives compaction, restarts, and budget pauses, and is re-injected at the top of every API call so you stay oriented after long autonomous runs. To finalize a plan and start a new one in the same session, use the `PlanState` tool. Optional `title` sets the human-readable label for the active plan (auto-derived from first incomplete step if omitted).',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              notes: {
                type: 'string',
                description: 'Optional inline note for this step (e.g. blockers, decisions).',
              },
            },
            required: ['id', 'content', 'status'],
          },
        },
        title: {
          type: 'string',
          description:
            'Optional plan title. Set on the first TodoWrite of a new plan; ignored thereafter. Defaults to the first incomplete step if omitted.',
        },
      },
      required: ['todos'],
    },
  },
  async execute(input, ctx) {
    const { persistTodoWrite } = await import('./planManager');
    return persistTodoWrite({
      sessionId: ctx.sessionId,
      todos: Array.isArray(input.todos) ? input.todos : [],
      title: typeof input.title === 'string' ? input.title : null,
    });
  },
};

// ---- PlanState (lifecycle: complete / abandon / start_new) ------------

const PLAN_STATE: ToolDef = {
  schema: {
    name: 'PlanState',
    description:
      'Manage the LIFECYCLE of the session\'s active plan (created via TodoWrite). Use this when:\n  • The current plan is fully delivered → action="complete" with an outcome_summary.\n  • You\'re abandoning the current plan (user redirected, plan turned out infeasible) → action="abandon" with a reason.\n  • You\'re starting a fresh plan in the same session → action="start_new" with the previous plan\'s outcome AND the new plan\'s title + initial steps.\nOnce a plan is completed or abandoned, its row stays in the DB for history; only the steps of the ACTIVE plan are re-injected into your context. Distinct from the `Plan` subagent tool, which spawns a planner subagent in fresh context.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['complete', 'abandon', 'start_new'],
        },
        outcome_summary: {
          type: 'string',
          description:
            'One-paragraph summary of how the previous plan ended. Required for complete/abandon; recorded as `previous_outcome` for start_new.',
        },
        previous_outcome: {
          type: 'string',
          enum: ['completed', 'abandoned'],
          description:
            'For action=start_new only: how the OUTGOING plan ended. Required.',
        },
        next_title: {
          type: 'string',
          description: 'For action=start_new only: title for the new plan.',
        },
        next_steps: {
          type: 'array',
          description:
            'For action=start_new only: initial steps for the new plan, same shape as TodoWrite.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              notes: { type: 'string' },
            },
            required: ['id', 'content', 'status'],
          },
        },
      },
      required: ['action'],
    },
  },
  async execute(input, ctx) {
    const { handlePlanState } = await import('./planManager');
    return handlePlanState({
      sessionId: ctx.sessionId,
      action: String(input?.action ?? '') as any,
      outcomeSummary: typeof input?.outcome_summary === 'string' ? input.outcome_summary : null,
      previousOutcome:
        typeof input?.previous_outcome === 'string' ? (input.previous_outcome as any) : null,
      nextTitle: typeof input?.next_title === 'string' ? input.next_title : null,
      nextSteps: Array.isArray(input?.next_steps) ? input.next_steps : null,
    });
  },
};

// ---- WaitFor* helpers ----------------------------------------------------

const MAX_WAIT_MS = 60 * 60 * 1000; // 1 hour hard cap on any blocking wait

function clampWait(ms: unknown, def = 60_000): number {
  const n = typeof ms === 'number' && isFinite(ms) ? ms : def;
  return Math.min(MAX_WAIT_MS, Math.max(100, Math.floor(n)));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run `cond` every `intervalMs` until it returns truthy or timeout. */
async function pollUntil<T>(
  cond: () => Promise<T | null>,
  intervalMs: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ ok: true; value: T } | { ok: false; reason: 'timeout' | 'aborted' }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, reason: 'aborted' };
    try {
      const v = await cond();
      if (v != null) return { ok: true, value: v };
    } catch {
      /* keep polling */
    }
    try {
      await sleep(Math.min(intervalMs, deadline - Date.now()), signal);
    } catch {
      return { ok: false, reason: 'aborted' };
    }
  }
  return { ok: false, reason: 'timeout' };
}

/**
 * Wraps a blocking-wait tool body so the session shows `waiting-on-system`
 * for the duration. Always restores `running` afterward (the agent loop
 * resumes immediately after).
 */
async function withWaitingState<T>(
  ctx: ToolContext,
  body: () => Promise<T>
): Promise<T> {
  setSessionState(ctx.sessionId, 'waiting-on-system');
  broadcastStateChanged(ctx.sessionId, 'waiting-on-system');
  try {
    return await body();
  } finally {
    setSessionState(ctx.sessionId, 'running');
    broadcastStateChanged(ctx.sessionId, 'running');
  }
}

// ---- WaitForFile ----

const WAIT_FOR_FILE: ToolDef = {
  schema: {
    name: 'WaitForFile',
    description:
      'Block this turn until a file appears, disappears, changes mtime, or contains a substring. Use when waiting for an external build, download, log line, etc. The session shows waiting-on-system while blocked. Returns a brief observation when the condition fires.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        condition: {
          type: 'string',
          enum: ['exists', 'not_exists', 'mtime_changes', 'contains'],
          description: 'Default exists. mtime_changes returns when the file is touched. contains polls file text for `pattern`.',
        },
        pattern: {
          type: 'string',
          description: 'Required when condition=contains. Substring (case-sensitive).',
        },
        timeout_ms: { type: 'integer', description: 'Default 5 minutes. Hard max 1 hour.' },
        poll_ms: { type: 'integer', description: 'Default 1000.' },
      },
      required: ['file_path'],
    },
  },
  async execute(input, ctx) {
    const path = resolveCwd(input.file_path, ctx.cwd);
    const cond = (input.condition as string) || 'exists';
    const timeout = clampWait(input.timeout_ms, 5 * 60 * 1000);
    const poll = clampWait(input.poll_ms, 1000);
    const baseline = existsSync(path) ? statSync(path).mtimeMs : null;

    return await withWaitingState(ctx, async () => {
      const r = await pollUntil(
        async () => {
          const present = existsSync(path);
          if (cond === 'exists' && present) return { hit: true, info: `exists` };
          if (cond === 'not_exists' && !present) return { hit: true, info: `gone` };
          if (cond === 'mtime_changes' && present) {
            const m = statSync(path).mtimeMs;
            if (baseline == null || m !== baseline) return { hit: true, info: `mtime=${m}` };
          }
          if (cond === 'contains' && present && input.pattern) {
            try {
              const t = readFileSync(path, 'utf8');
              if (t.includes(input.pattern)) return { hit: true, info: `match` };
            } catch {
              /* race; retry */
            }
          }
          return null;
        },
        poll,
        timeout,
        ctx.signal
      );
      if (!r.ok) return `WaitForFile timed out after ${timeout}ms (${cond} on ${path})`;
      return `WaitForFile fired (${r.value.info}) on ${path}`;
    });
  },
};

// ---- WaitForProcess ----

const WAIT_FOR_PROCESS: ToolDef = {
  schema: {
    name: 'WaitForProcess',
    description:
      'Block until a process matching `pid` (preferred) or `name` (substring of command line) is no longer running. Returns when the process exits or timeout fires. Session shows waiting-on-system.',
    input_schema: {
      type: 'object',
      properties: {
        pid: { type: 'integer' },
        name: { type: 'string', description: 'Process name substring (case-insensitive).' },
        timeout_ms: { type: 'integer', description: 'Default 30 minutes. Max 1 hour.' },
        poll_ms: { type: 'integer', description: 'Default 2000.' },
      },
    },
  },
  async execute(input, ctx) {
    const timeout = clampWait(input.timeout_ms, 30 * 60 * 1000);
    const poll = clampWait(input.poll_ms, 2000);
    const targetPid = typeof input.pid === 'number' ? input.pid : null;
    const targetName = typeof input.name === 'string' ? input.name.toLowerCase() : null;
    if (targetPid == null && !targetName) return `error: provide pid or name`;

    return await withWaitingState(ctx, async () => {
      const r = await pollUntil(
        async () => {
          if (targetPid != null) {
            try {
              process.kill(targetPid, 0);
              return null; // still alive
            } catch {
              return { gone: true } as const;
            }
          }
          // name-based: rely on tasklist (win) or ps (unix)
          const found = await new Promise<boolean>((res) => {
            const cmd = isWin ? 'tasklist' : 'ps';
            const args = isWin ? [] : ['ax', '-o', 'comm,args'];
            const p = spawn(cmd, args);
            let out = '';
            p.stdout.on('data', (b) => (out += b.toString()));
            p.on('close', () => {
              const lower = out.toLowerCase();
              res(lower.includes(targetName!));
            });
            p.on('error', () => res(false));
          });
          return found ? null : ({ gone: true } as const);
        },
        poll,
        timeout,
        ctx.signal
      );
      if (!r.ok) return `WaitForProcess timed out after ${timeout}ms`;
      return `WaitForProcess: target exited`;
    });
  },
};

// ---- WaitForTime ----

const WAIT_FOR_TIME: ToolDef = {
  schema: {
    name: 'WaitForTime',
    description:
      'Pause the turn for a fixed duration in milliseconds (max 1 hour). Use sparingly — prefer WaitForFile/Process/Http when possible. Session shows sleeping-tool and survives app restart: the agent loop exits cleanly while sleeping and is resumed automatically when the wake time arrives (in-process timer if the app stayed alive, governor sweep if it was restarted).',
    input_schema: {
      type: 'object',
      properties: { duration_ms: { type: 'integer' } },
      required: ['duration_ms'],
    },
  },
  async execute(input, ctx) {
    // Persistent-sleep path. Instead of holding a setTimeout in this
    // process for `ms`, we:
    //   1. Write `sleeping-tool` state + `wake_at_ts = now + ms` to the
    //      DB so the row knows when to wake even if the app dies.
    //   2. Return a tool_result IMMEDIATELY (the call returns now, in
    //      microseconds) carrying a `sleepUntil` signal on the
    //      structured result.
    //   3. The agent loop detects `sleepUntil` and exits cleanly —
    //      it writes the tool_result to JSONL like normal, sets
    //      state=sleeping-tool, and stops sending API calls.
    //   4. Wake fires via either the in-process `wakeSleepingToolSweep`
    //      timer (snappy in-app wake) or the governor's sweep
    //      (handles restart-while-sleeping).
    //
    // The model-facing tool_result string still says "slept ${ms}ms"
    // so the conversation history reads naturally after the wake;
    // the model doesn't need to know the wait was implemented
    // persistently. The wall-clock IS honored — wake won't fire
    // before `wake_at_ts`.
    const ms = clampWait(input.duration_ms, 1000);
    const wakeAtTs = Date.now() + ms;
    try {
      setSessionWakeAt(ctx.sessionId, wakeAtTs);
      setSessionState(ctx.sessionId, 'sleeping-tool');
      broadcastStateChanged(ctx.sessionId, 'sleeping-tool');
    } catch (e) {
      log.warn(
        `[tool:WaitForTime] persistent-sleep setup failed for session ${ctx.sessionId}, falling back to in-process sleep`,
        e
      );
      // Fallback to historical in-process behavior. The wait still
      // happens; it just doesn't survive restart. Better than
      // failing the tool call outright.
      return await withWaitingState(ctx, async () => {
        try {
          await sleep(ms, ctx.signal);
          return `WaitForTime: slept ${ms}ms (non-persistent fallback after DB error)`;
        } catch {
          return `WaitForTime: aborted`;
        }
      });
    }
    const wakeIso = new Date(wakeAtTs).toISOString();
    log.info(
      `[tool:WaitForTime] sleeping ${ctx.sessionId} for ${ms}ms (wake at ${wakeIso})`
    );
    return {
      modelContent: [
        {
          type: 'text',
          text: `WaitForTime: slept ${ms}ms (wake at ${wakeIso})`,
        },
      ],
      uiSummary: `WaitForTime: ${ms}ms — sleeping until ${wakeIso}`,
      sleepUntil: wakeAtTs,
    };
  },
};

// ---- WaitForHttp ----

const WAIT_FOR_HTTP: ToolDef = {
  schema: {
    name: 'WaitForHttp',
    description:
      'Block until an HTTP GET to `url` returns an expected status (default 200) or its body matches `pattern`. Session shows waiting-on-system.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        expect_status: { type: 'integer', description: 'Default 200.' },
        pattern: { type: 'string', description: 'Optional substring that body must contain.' },
        timeout_ms: { type: 'integer', description: 'Default 5 minutes. Max 1 hour.' },
        poll_ms: { type: 'integer', description: 'Default 2000.' },
      },
      required: ['url'],
    },
  },
  async execute(input, ctx) {
    const timeout = clampWait(input.timeout_ms, 5 * 60 * 1000);
    const poll = clampWait(input.poll_ms, 2000);
    const want = typeof input.expect_status === 'number' ? input.expect_status : 200;
    const pattern = typeof input.pattern === 'string' ? input.pattern : null;

    return await withWaitingState(ctx, async () => {
      const r = await pollUntil(
        async () => {
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), Math.min(poll, 10_000));
            const res = await fetch(input.url, { signal: ctrl.signal });
            clearTimeout(t);
            if (res.status !== want) return null;
            if (pattern) {
              const body = await res.text();
              if (!body.includes(pattern)) return null;
              return { status: res.status, sample: body.slice(0, 120) } as const;
            }
            return { status: res.status, sample: '' } as const;
          } catch {
            return null;
          }
        },
        poll,
        timeout,
        ctx.signal
      );
      if (!r.ok) return `WaitForHttp timed out after ${timeout}ms (${r.reason})`;
      return `WaitForHttp: status=${r.value.status}${r.value.sample ? ` body~"${r.value.sample.replace(/\n/g, ' ')}"` : ''}`;
    });
  },
};

// ---- search_conversation ----
//
// Substring search across the CURRENT session's JSONL transcript. This is how
// the agent answers "what did we discuss about X earlier?" — without it, the
// model can only see whatever is still inside its context window, which gets
// compacted aggressively on long sessions.
//
// We search text from every block type that carries human-readable strings:
// user text, assistant text, tool inputs (so "what command did you run?"
// works), and tool outputs (so "what was the test result?" works). Each hit
// returns a windowed snippet (±200 chars around the match) labeled with role,
// approximate position from the end of the transcript ("4 messages back"),
// and the original timestamp when available.

const SEARCH_CONVERSATION: ToolDef = {
  schema: {
    name: 'search_conversation',
    description:
      "Search the CURRENT session's full conversation transcript (JSONL) for a substring. Returns matching snippets from user messages, assistant replies, tool inputs, and tool outputs — including parts that have already been compacted/truncated out of your active context window. Use this whenever the user refers to something earlier in the conversation that you don't remember (\"what did we decide about X?\", \"go back and find the benchmark numbers\", \"what command did I run to set this up?\"). Prefer this over re-asking the user. Match is case-insensitive. Returns up to `max_results` snippets, newest first.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Substring to look for (case-insensitive). Be specific — a unique phrase from what you remember works better than a single common word.',
        },
        max_results: {
          type: 'integer',
          description: 'Max snippets to return. Default 10, hard cap 30.',
        },
        roles: {
          type: 'array',
          items: { type: 'string', enum: ['user', 'assistant', 'tool_use', 'tool_result'] },
          description:
            'Optional filter. Default searches all of: user, assistant, tool_use, tool_result. Pass [\"user\",\"assistant\"] to skip tool noise.',
        },
      },
      required: ['query'],
    },
  },
  async execute(input, ctx) {
    const query = String(input.query ?? '').trim();
    if (!query) return 'error: empty query';
    const maxResults = Math.min(
      Math.max(1, parseInt(String(input.max_results ?? 10), 10) || 10),
      30
    );
    const rolesFilter: Set<string> | null = Array.isArray(input.roles)
      ? new Set(input.roles.map((r: unknown) => String(r)))
      : null;

    const path = ourJsonlPath(ctx.sessionId);
    // Pass null to load the FULL transcript — the renderer caps at 500 to
    // avoid IPC blowups on huge imports, but for searching we need history.
    const msgs = loadMessagesWithTsFromJsonl(path, null);
    if (msgs.length === 0) {
      return '(no conversation history found on disk for this session)';
    }

    const needle = query.toLowerCase();
    type Hit = { posFromEnd: number; ts: number | null; role: string; snippet: string };
    const hits: Hit[] = [];

    // Walk newest-to-oldest so we report the most recent matches first; users
    // referencing "earlier" almost always mean "earlier but still recent".
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const posFromEnd = msgs.length - 1 - i;
      const blocks: Array<{ role: string; text: string }> = [];
      if (typeof m.content === 'string') {
        blocks.push({ role: m.role, text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text' && typeof b.text === 'string') {
            blocks.push({ role: m.role, text: b.text });
          } else if (b.type === 'tool_use') {
            // Tool_use blocks live inside assistant messages. Surface the
            // name + JSON-serialized input so "what command did we run" type
            // queries hit the actual shell command string.
            const inputStr =
              typeof b.input === 'string' ? b.input : safeJsonStringify(b.input);
            blocks.push({
              role: 'tool_use',
              text: `[${b.name ?? 'tool'}] ${inputStr}`,
            });
          } else if (b.type === 'tool_result') {
            // tool_result.content can be a string OR an array of content
            // blocks (mostly text). Flatten to a single string for searching.
            const content = b.content;
            let text = '';
            if (typeof content === 'string') {
              text = content;
            } else if (Array.isArray(content)) {
              text = content
                .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
                .filter(Boolean)
                .join('\n');
            }
            if (text) blocks.push({ role: 'tool_result', text });
          }
        }
      }
      for (const blk of blocks) {
        if (rolesFilter && !rolesFilter.has(blk.role)) continue;
        const idx = blk.text.toLowerCase().indexOf(needle);
        if (idx < 0) continue;
        // Window ~200 chars on either side of the hit so the agent gets
        // enough context to reconstruct the original point without us
        // dumping a full tool_result that could be 50KB.
        const start = Math.max(0, idx - 200);
        const end = Math.min(blk.text.length, idx + needle.length + 200);
        let snippet = blk.text.slice(start, end);
        if (start > 0) snippet = '…' + snippet;
        if (end < blk.text.length) snippet = snippet + '…';
        hits.push({
          posFromEnd,
          ts: m.ts,
          role: blk.role,
          snippet,
        });
        if (hits.length >= maxResults) break;
      }
      if (hits.length >= maxResults) break;
    }

    if (hits.length === 0) {
      return `No matches for "${query}" in this session's transcript (${msgs.length} messages searched).`;
    }
    const header = `Found ${hits.length} match${hits.length === 1 ? '' : 'es'} (newest first; ${msgs.length} messages on disk):`;
    const body = hits
      .map((h) => {
        const tsLabel = h.ts ? new Date(h.ts).toISOString() : 'no-ts';
        const posLabel =
          h.posFromEnd === 0
            ? 'latest message'
            : `${h.posFromEnd} message${h.posFromEnd === 1 ? '' : 's'} back`;
        return `--- [${h.role}] ${posLabel} (${tsLabel}) ---\n${h.snippet}`;
      })
      .join('\n\n');
    return `${header}\n\n${body}`;
  },
};

/** JSON.stringify that never throws on cyclic input. */
function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---- recall_memory ----

const RECALL_MEMORY: ToolDef = {
  schema: {
    name: 'recall_memory',
    description:
      'Search ALL memory ON DISK — both Guy-owned writable leaves (~/.guycode, EVERY tier including archived/completed-task state) AND read-only imported Claude memory (~/.claude CLAUDE.md / reference_* / feedback_* / project_* leaves) — for a substring. Returns matching paragraphs with their source path and (for Guy leaves) their tier. Unlike the session-start load (which is budget-capped and tiered), this reads the full tree, so archived and otherwise-evicted content is still findable. Use it to look something up (a convention, a prior decision, a checklist trigger like "hardening", or details from a finished task) without re-quoting the whole tree.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'integer', description: 'Default 8.' },
      },
      required: ['query'],
    },
  },
  async execute(input, ctx) {
    return recallFromDisk({
      cwd: ctx.cwd,
      projectId: ctx.projectId,
      query: String(input.query),
      maxResults: input.max_results ?? 8,
    });
  },
};

// ---- save_memory / list_memory / delete_memory ----
//
// These manage Guy-owned writable memory under ~/.guycode. They DO NOT touch
// ~/.claude — that tree is treated as a read-only import. Use scope='global'
// for facts that apply across all your work (machines, default behaviors,
// preferences) and scope='project' for facts tied to one project/codebase.

const SAVE_MEMORY: ToolDef = {
  schema: {
    name: 'save_memory',
    description:
      "Save a memory leaf so it persists across sessions and is reloaded next time. WRITES UNDER ~/.guycode, NEVER under ~/.claude (which is treated as read-only Claude import). Use scope='global' for cross-project facts (e.g. \"on Windows, prefer PowerShell\", default machines, naming conventions) and scope='project' for facts tied to one codebase. The key becomes the filename (sanitized to lowercase / hyphens / underscores). Use mode='append' to add to an existing leaf without clobbering it; default 'replace' overwrites.",
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['global', 'project'],
          description:
            "global = ~/.guycode/memory/<key>.md, project = ~/.guycode/projects/<projectId>/memory/<key>.md. Use 'global' for cross-project facts; 'project' requires a cwd-bound session.",
        },
        key: {
          type: 'string',
          description:
            'Short identifier; becomes the filename. Examples: "xgsrc-workflow", "default-machines", "preferences". Sanitized to a-z 0-9 _ - only.',
        },
        content: {
          type: 'string',
          description: 'Markdown body to save. Up to 64KB.',
        },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: "Default 'replace'. Use 'append' to add a timestamped section to an existing leaf.",
        },
        priority: {
          type: 'string',
          enum: ['pinned', 'normal', 'archived'],
          description:
            "Load tier. 'pinned' = a permanent always-applies rule/convention that must ALWAYS load at session start (use sparingly, for durable rules). 'normal' (default) = active task state. 'archived' = completed-task state kept for reference but loaded last. Omit to leave an existing leaf's tier unchanged (or default a new leaf to normal). Non-pinned leaves auto-archive after ~14 days untouched; editing a leaf un-archives it.",
        },
      },
      required: ['scope', 'key', 'content'],
    },
  },
  async execute(input, ctx) {
    const scope = String(input.scope) as 'global' | 'project';
    const priority =
      input.priority === 'pinned' || input.priority === 'normal' || input.priority === 'archived'
        ? (input.priority as MemoryTier)
        : undefined;
    const r = saveMemory({
      scope,
      key: String(input.key),
      content: String(input.content ?? ''),
      mode: input.mode === 'append' ? 'append' : 'replace',
      projectId: ctx.projectId,
      priority,
    });
    if (!r.ok) return `error: ${r.error}`;
    return `Saved ${scope} memory (${r.bytes}b) at ${r.path}. Will be loaded into context at the start of every future session.`;
  },
};

const LIST_MEMORY: ToolDef = {
  schema: {
    name: 'list_memory',
    description:
      'List memory leaves the model knows about. Covers BOTH the Guy-owned writable leaves under ~/.guycode AND the read-only imported Claude memory under ~/.claude (reference/feedback/project docs loaded at session start). Claude-import rows show their name + description (the trigger text) so you can tell when one applies — e.g. a "when Jason says hardening…" reference. Read-only imports can be Read by path but not saved/deleted. Use this to discover what guidance already exists before acting or before saving something new. Default scope "all" returns everything; "guy" = only writable Guy leaves; "claude" = only read-only imports.',
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['global', 'project', 'all', 'guy', 'claude'],
          description:
            "Default 'all' (Guy leaves + Claude imports). 'global'/'project' = the matching Guy-owned subset. 'guy' = all Guy-owned. 'claude' = read-only Claude imports only.",
        },
      },
    },
  },
  async execute(input, ctx) {
    const scope = (input.scope as string | undefined) ?? 'all';
    const wantGuy = scope === 'all' || scope === 'guy' || scope === 'global' || scope === 'project';
    const wantClaude = scope === 'all' || scope === 'claude';

    const sections: string[] = [];

    if (wantGuy) {
      // For the Guy listing, 'guy' behaves like 'all' (both global + project);
      // 'global'/'project' narrow to that subset.
      const guyScope: 'global' | 'project' | 'all' =
        scope === 'global' ? 'global' : scope === 'project' ? 'project' : 'all';
      const rows = listGuyMemory({ scope: guyScope, projectId: ctx.projectId });
      if (rows.length > 0) {
        // Group by tier so the model can see at a glance what's pinned
        // (always loads), what's normal (active), and what's archived
        // (completed; loads last but still recall-searchable).
        const order: MemoryTier[] = ['pinned', 'normal', 'archived'];
        const byTier = order
          .map((tier) => ({ tier, items: rows.filter((r) => r.tier === tier) }))
          .filter((g) => g.items.length > 0);
        const body = byTier
          .map(({ tier, items }) => {
            const lines = items
              .sort((a, b) => b.mtime - a.mtime)
              .map((r) => {
                // Mark whether the tier is explicit (frontmatter) or
                // auto-derived (staleness) so archive surprises are legible.
                const how =
                  r.explicitTier === tier
                    ? ''
                    : tier === 'archived'
                      ? ' (auto: stale >14d)'
                      : '';
                return `    [${r.scope}] ${r.path}\n        ${r.bytes}b · modified ${new Date(r.mtime).toISOString()}${how}`;
              })
              .join('\n');
            return `  ${tier.toUpperCase()} (${items.length}):\n${lines}`;
          })
          .join('\n');
        sections.push(
          'WRITABLE (Guy-owned, ~/.guycode — save_memory / delete_memory / set_memory_priority work here):\n' +
            body
        );
      }
    }

    if (wantClaude) {
      const claude = listClaudeMemory({ cwd: ctx.cwd, projectId: ctx.projectId });
      if (claude.length > 0) {
        sections.push(
          'READ-ONLY (imported Claude memory, ~/.claude — Read by path; cannot save/delete):\n' +
            claude
              .map((r) => {
                const label = r.name ? r.name : '(no name)';
                const desc = r.description
                  ? `\n      ${r.description.length > 400 ? r.description.slice(0, 400) + '…' : r.description}`
                  : '';
                return `  [claude-import] ${r.path}\n      ${label} · ${r.bytes}b${desc}`;
              })
              .join('\n')
        );
      }
    }

    if (sections.length === 0) {
      return wantClaude && !wantGuy
        ? '(no imported Claude memory found for this session)'
        : wantGuy && !wantClaude
          ? '(no Guy-owned memory saved yet)'
          : '(no memory found — neither Guy-owned leaves nor Claude imports)';
    }
    return sections.join('\n\n');
  },
};

const DELETE_MEMORY: ToolDef = {
  schema: {
    name: 'delete_memory',
    description:
      'Delete a Guy-owned memory leaf. Only works under ~/.guycode (Claude memory is read-only). Be conservative — once deleted the content is gone.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'project'] },
        key: {
          type: 'string',
          description: 'Same key you used when saving.',
        },
      },
      required: ['scope', 'key'],
    },
  },
  async execute(input, ctx) {
    const scope = String(input.scope) as 'global' | 'project';
    const r = deleteGuyMemory({
      scope,
      key: String(input.key),
      projectId: ctx.projectId,
    });
    return r.ok ? `Deleted ${scope} memory "${input.key}".` : `error: ${r.error}`;
  },
};

const SET_MEMORY_PRIORITY: ToolDef = {
  schema: {
    name: 'set_memory_priority',
    description:
      "Set the load tier of an existing Guy-owned memory leaf. Tiers: 'pinned' (a permanent always-applies rule that must ALWAYS load at session start — use sparingly), 'normal' (active task state, the default), 'archived' (completed-task state kept for reference but loaded last; still searchable via recall_memory). Use this to PIN a durable rule so it can never be evicted by the session-load budget, to ARCHIVE a finished task's state so it stops crowding the budget, or to UNARCHIVE one. Non-pinned leaves also auto-archive after ~14 days untouched. Only works under ~/.guycode (Claude imports are read-only).",
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'project'] },
        key: { type: 'string', description: 'Same key you used when saving.' },
        priority: { type: 'string', enum: ['pinned', 'normal', 'archived'] },
      },
      required: ['scope', 'key', 'priority'],
    },
  },
  async execute(input, ctx) {
    const scope = String(input.scope) as 'global' | 'project';
    const priority = String(input.priority) as MemoryTier;
    const r = setMemoryPriority({
      scope,
      key: String(input.key),
      priority,
      projectId: ctx.projectId,
    });
    return r.ok
      ? `Set ${scope} memory "${input.key}" to ${priority}.`
      : `error: ${r.error}`;
  },
};

// ---- list_skills / read_skill ----

const LIST_SKILLS: ToolDef = {
  schema: {
    name: 'list_skills',
    description:
      'List skills and slash-commands defined under ~/.claude/skills and ~/.claude/commands. Returns name, path, and short description. Use read_skill to fetch the full body of one.',
    input_schema: { type: 'object', properties: {} },
  },
  async execute() {
    const skills = listClaudeSkills();
    if (skills.length === 0) return '(no skills found under ~/.claude/skills or ~/.claude/commands)';
    return skills
      .map((s) => `- ${s.name}\t${s.path}\n    ${s.description ?? '(no description)'}`)
      .join('\n');
  },
};

const READ_SKILL: ToolDef = {
  schema: {
    name: 'read_skill',
    description:
      'Read the full markdown of a skill or command file (typically discovered via list_skills). Pass the absolute path returned by list_skills.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  async execute(input) {
    const p = String(input.path);
    if (!existsSync(p)) return `error: not found: ${p}`;
    return trimOutput(readFileSync(p, 'utf8'));
  },
};

// ---- Skill (fetch the body of a registered skill for execution) ----

const SKILL_TOOL: ToolDef = {
  schema: {
    name: 'Skill',
    description:
      'Fetch the full instruction body of a skill registered under ~/.guycode/skills, <cwd>/.guycode/skills, or imported from ~/.claude/skills. The skill names available are listed in the system prompt under "Available skills". Pass the EXACT name. Returns the markdown body verbatim — read it, then follow its instructions for the rest of the turn (or until the user changes direction).',
    input_schema: {
      type: 'object',
      properties: {
        SkillName: {
          type: 'string',
          description:
            'Exact skill name as listed in the Available skills system block (e.g. "feature-spec", "drafting-commits").',
        },
      },
      required: ['SkillName'],
    },
  },
  async execute(input, ctx) {
    const { loadSkills } = await import('./skills');
    const name = String(input?.SkillName ?? '').trim();
    if (!name) return 'error: SkillName is required';
    const registry = loadSkills(ctx.cwd);
    const skill = registry.skills.find((s) => s.name === name);
    if (!skill) {
      const known = registry.skills.map((s) => s.name).slice(0, 20).join(', ');
      return `error: no skill named "${name}". Known skills: ${known}${registry.skills.length > 20 ? ', ...' : ''}`;
    }
    return [
      `# Skill: ${skill.name}`,
      `Source: ${skill.source}`,
      `Path: ${skill.path}`,
      `Supporting files dir: ${skill.dir}`,
      ``,
      skill.body,
    ].join('\n');
  },
};

// ---- WebSearch + WebFetch (both client-side; run locally) ----
//
// We deliberately do NOT use Anthropic's server-side
// `web_search_20250305` tool. That capability is gated per-organization;
// orgs without it enabled return a 400 on every turn the tool is
// registered. A local DuckDuckGo-backed search works for every user and
// doesn't bill against Anthropic's per-search fee.

const WEB_SEARCH: ToolDef = {
  schema: {
    name: 'WebSearch',
    description:
      'Search the web via DuckDuckGo and return the top results (title + URL + snippet for each). Use this when you need to find information you don\'t already have — current docs, recent news, code examples, error explanations, comparisons. After picking a relevant result, call WebFetch on its URL to read the full page. 15s timeout, returns up to 10 results by default (cap 25). The output starts with a `Search results for: <query>` header followed by numbered entries.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The search query. Phrase it like you would in a search engine — plain keywords work better than full natural-language sentences for most queries.',
        },
        max_results: {
          type: 'integer',
          description:
            'Maximum number of results to return. Defaults to 10. Hard cap of 25.',
          minimum: 1,
          maximum: 25,
        },
      },
      required: ['query'],
    },
  },
  async execute(input) {
    const { webSearch } = await import('./webSearch');
    return await webSearch({
      query: String(input?.query ?? ''),
      max_results:
        typeof input?.max_results === 'number' ? input.max_results : undefined,
    });
  },
};

const WEB_FETCH: ToolDef = {
  schema: {
    name: 'WebFetch',
    description:
      'Fetch a single URL and return its readable text content (extracted via Mozilla Readability for HTML; verbatim for plain text / JSON / markdown). Use after WebSearch when you need the actual content of a result, or when the user gives you a specific URL. Has a 15s timeout, follows redirects, caps body at 5 MB. Output begins with `Title:` and `URL:` lines, then the extracted body. NOT suitable for binary downloads or for paginating a site — fetches one URL once.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Absolute http(s) URL to fetch. The tool follows redirects automatically.',
        },
      },
      required: ['url'],
    },
  },
  async execute(input) {
    const { webFetch } = await import('./webFetch');
    // webFetch returns either content or an `error: ...` string. We
    // surface either verbatim — `executeTool` wraps real exceptions
    // separately, and the `error:` text-prefix convention is what
    // every other tool here uses to convey domain errors without
    // setting the API-level is_error flag.
    return await webFetch({ url: String(input?.url ?? '') });
  },
};

// ---- Browser* (Chrome connector) ----
//
// These tools drive the user's running Chrome over CDP via
// `playwright-core`. The user must launch Chrome with
// `--remote-debugging-port=9222` (and a profile dir) once, then click
// Connect in Settings → Chrome connector. After that the tools can
// read AND write to the user's actual logged-in tabs (Gmail, Slack,
// Outlook, etc.) without a separate login per site, which is the
// whole point.
//
// Read tools (BrowserList, BrowserOpen, BrowserExtract,
// BrowserScreenshot, BrowserWaitFor) are intentionally split from
// write tools (BrowserClick, BrowserType, BrowserPress,
// BrowserScroll, BrowserEval) so a future per-write confirmation
// gate can be added without affecting passive inspection. Today
// there's no gate — connection itself is the user's affirmative
// consent, registered through the Settings UI.

const BROWSER_LIST: ToolDef = {
  schema: {
    name: 'BrowserList',
    description:
      "List all currently open tabs in the connected Chrome browser. Returns each tab's id, URL, and page title.\n\nWhen to call this: ONLY when the user has explicitly told you to look at one of their existing tabs (\"check my Gmail\", \"summarize the article I have open\"). The returned tabIds may then be passed to READ tools (BrowserExtract, BrowserScreenshot, BrowserWaitFor) which work without authorization.\n\nWhen NOT to call this: as a routine first step before doing any browser work. The default workflow is BrowserOpen with a fresh URL — that gives you a clean tab the user isn't using, auto-authorized for write operations, with no permission prompts. Calling BrowserList speculatively and then BrowserAttach-ing to whatever you find is the wrong workflow and the user has flagged it as annoying.\n\nRequires the user to have Chrome running with --remote-debugging-port=9222 and to have clicked Connect in Settings → Chrome connector.",
    input_schema: { type: 'object', properties: {} },
  },
  async execute() {
    const { listTabs } = await import('./chromeBridge');
    const tabs = await listTabs();
    if (tabs.length === 0) return '(no open tabs)';
    return tabs
      .map((t) => `${t.id}\t${t.url}\n    ${t.title || '(no title)'}`)
      .join('\n');
  },
};

const BROWSER_OPEN: ToolDef = {
  schema: {
    name: 'BrowserOpen',
    description:
      "Open a URL in a new tab in the connected Chrome browser and AUTO-AUTHORIZE that tab for you to drive. Returns the new tab's id, final URL (after redirects), and title. The new tab opens in the user's logged-in profile, so site-level auth is already handled.\n\nThis is the PREFERRED way to do browser work: open your own tab and operate inside it. Never reach into the user's existing tabs (Gmail, Slack, etc.) for write actions — those require explicit user permission via BrowserAttach.",
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http(s) URL to open. Must include scheme.',
        },
      },
      required: ['url'],
    },
  },
  async execute(input) {
    const { openTab } = await import('./chromeBridge');
    const tab = await openTab(String(input?.url ?? ''));
    return [
      `Opened ${tab.id} (auto-authorized — you can click/type/etc here)`,
      `  URL: ${tab.url}`,
      `  Title: ${tab.title || '(no title)'}`,
    ].join('\n');
  },
};

const BROWSER_ATTACH: ToolDef = {
  schema: {
    name: 'BrowserAttach',
    description:
      "Request authorization to DRIVE (click, type, press, scroll, eval, screenshot) one of the user's existing Chrome tabs.\n\nDEFAULT: do not call this. The user has explicitly flagged speculative BrowserAttach as a UX bug. Every invocation pops a native modal interrupting the user, and they don't want to be asked unless they've already told you to work in a specific existing tab.\n\nThe ONLY valid trigger for calling BrowserAttach is the user saying — in plain English — something like \"use the Gmail tab I have open\", \"work in my Slack window\", \"the Outlook tab I'm looking at\". An ambient mention of Gmail/Outlook/etc in the conversation is NOT consent. \"Send a Slack message to Bob\" is NOT consent — open your own Slack tab with BrowserOpen. If you find yourself reasoning \"the user probably wants me to use their existing tab to save a step\", you are about to ship the bug; stop and call BrowserOpen.\n\nWhen in doubt, BrowserOpen. It creates a fresh tab in the same Chrome profile (so the user is already logged in to whatever site you need) and auto-authorizes it without bothering the user. There is no scenario where BrowserOpen is wrong but BrowserAttach is right — the user can always tell you to switch to their existing tab afterward if they prefer.\n\nIf the user denies the modal, the call fails with a clear error — fall back to BrowserOpen, do NOT retry BrowserAttach on the same tab. The authorization (if approved) lasts until the Chrome connector is disconnected.",
    input_schema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'string',
          description: 'Tab id from BrowserList (e.g. tab-12345).',
        },
      },
      required: ['tabId'],
    },
  },
  async execute(input) {
    const { authorizeTab } = await import('./chromeBridge');
    const tab = await authorizeTab(String(input?.tabId ?? ''));
    return [
      `Authorized ${tab.id} — you may now drive it.`,
      `  URL: ${tab.url}`,
      `  Title: ${tab.title || '(no title)'}`,
    ].join('\n');
  },
};

const BROWSER_EXTRACT: ToolDef = {
  schema: {
    name: 'BrowserExtract',
    description:
      'Extract readable text from a tab. By default returns the full body innerText (hidden / display:none nodes filtered out). Pass a CSS selector to narrow — useful for SPAs like Gmail / Slack / Outlook where the meaningful content is nested. 200K char hard cap; if hit, narrow with a more specific selector. Output begins with `Title:` and `URL:` headers like WebFetch so the model treats the two interchangeably for downstream consumption.',
    input_schema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'string',
          description: 'Tab id from BrowserList or BrowserOpen (e.g. tab-1).',
        },
        selector: {
          type: 'string',
          description:
            'Optional CSS selector. Use to narrow to a Gmail thread, a Slack channel scroll, an Outlook message body. Multiple matches are joined with double-newlines.',
        },
      },
      required: ['tabId'],
    },
  },
  async execute(input) {
    const { extractTab } = await import('./chromeBridge');
    return await extractTab({
      tabId: String(input?.tabId ?? ''),
      selector:
        typeof input?.selector === 'string' && input.selector.trim()
          ? input.selector
          : undefined,
    });
  },
};

const BROWSER_SCREENSHOT: ToolDef = {
  schema: {
    name: 'BrowserScreenshot',
    description:
      "Take a screenshot of a tab's current viewport and return TWO images plus a label table:\n\n" +
        "  • A clean image of the page as the user sees it — READ this one for page content, text, layout.\n" +
        "  • An ANNOTATED image with numbered colored boxes drawn over every clickable / focusable element. PICK targets from this one.\n" +
        "  • A label table mapping each number to its element: tag, role, visible text, aria-label, a CSS selector, and bbox.\n\n" +
        'Workflow: read the clean image to understand what\'s on the page; find the label number of the thing you want to interact with on the annotated image; then drive the page with BrowserClick / BrowserType / BrowserPress passing the corresponding `selector` or `text` from the label table. Labels are renumbered on every screenshot.\n\n' +
        "If the page extends below the fold (`pageInfo.fullSize.height > viewport.height`), call BrowserScroll then re-shoot to see more.\n\n" +
        'Defaults to viewport (the only supported `area`). `annotate=false` skips the overlay pass and returns only the clean image — use that when overlays would confuse you (page already has numbered UI, you only need to read content, etc.). Privileged URLs (chrome://, file://, about:) cannot be captured — Chrome blocks captureVisibleTab for those.\n\n' +
        "Transient capture failures: errors like \"image readback failed\" or \"capture failed\" are usually GPU/compositor hiccups (heavy page mid-paint, tab transitioning out of minimized state). The tool already retries up to 5 times with backoff internally (~16s total), un-minimizes Chrome if needed before each attempt, and falls back to chrome.debugger Page.captureScreenshot if all retries are exhausted (works on background / off-screen / occluded windows that captureVisibleTab can't reach). The user does NOT need to bring Chrome to the foreground — that's handled. If you get an error AFTER all of that, it's a real problem (DRM video, dead renderer, no permission). Wait 30-60s with WaitForTime and retry once before escalating. Don't re-issue immediately in a tight loop; the GPU needs time to settle.\n\n" +
        'Requires the tab to be authorized (BrowserOpen auto-authorizes; BrowserAttach for user tabs).',
    input_schema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        area: {
          type: 'string',
          enum: ['viewport'],
          description:
            'Only "viewport" is supported by the extension transport. Scroll between shots to see more of a long page.',
        },
        annotate: {
          type: 'boolean',
          description:
            'Default true. Set false to skip the Set-of-Marks overlay pass — you\'ll get only the clean image, no label table, and the call is faster (one capture instead of two).',
        },
      },
      required: ['tabId'],
    },
  },
  async execute(input): Promise<StructuredToolResult> {
    const { screenshotTab } = await import('./chromeBridge');
    const annotate = input?.annotate !== false;
    const r = await screenshotTab({
      tabId: String(input?.tabId ?? ''),
      area: 'viewport',
      annotate,
    });
    // Persist both images to disk so the user can open them in their
    // image viewer to compare with what the model saw. Filename
    // suffix marks which is which.
    const dir = join(homedir(), '.guycode', 'browser-screenshots');
    mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    const cleanPath = join(dir, `screenshot-${ts}-clean.png`);
    writeFileSync(cleanPath, Buffer.from(r.cleanBase64, 'base64'));
    let annotatedPath: string | null = null;
    const hasAnnotated =
      annotate && !!r.annotatedBase64 && r.annotatedBase64 !== r.cleanBase64;
    if (hasAnnotated) {
      annotatedPath = join(dir, `screenshot-${ts}-annotated.png`);
      writeFileSync(annotatedPath, Buffer.from(r.annotatedBase64, 'base64'));
    }

    // ---- Build the label table string for the model ------------------
    //
    // Format chosen for the model's benefit: each label on its own
    // line, fields fixed-position so a Claude reading it can scan a
    // big table fast. We include all four identifiers (text / aria /
    // selector / role) when present, so the model can pick the most
    // durable one for its BrowserClick call.
    const labelLines: string[] = [];
    for (const lab of r.labels) {
      const parts: string[] = [`[${lab.label}]`, lab.tag];
      if (lab.role) parts.push(`role=${lab.role}`);
      if (lab.text) parts.push(`text=${JSON.stringify(lab.text)}`);
      if (lab.aria && lab.aria !== lab.text)
        parts.push(`aria=${JSON.stringify(lab.aria)}`);
      if (lab.selector) parts.push(`css=${lab.selector}`);
      labelLines.push(parts.join(' '));
    }

    // ---- Build the model-facing content blocks -----------------------
    //
    // Order: leading text (context) → clean image → annotated image →
    // label table. The model sees them in order so the "this is the
    // clean one, this is the annotated one" framing lands before the
    // images themselves.
    const pi = r.pageInfo;
    const morePagesHint =
      pi.fullSize.height > pi.viewport.height + 50
        ? ` (page continues below — full height ${pi.fullSize.height}px, viewport ${pi.viewport.height}px; scroll and re-shoot to see more)`
        : '';
    const intro =
      `Screenshot of ${pi.url}\n` +
      `Title: ${pi.title || '(no title)'}\n` +
      `Viewport ${pi.viewport.width}×${pi.viewport.height} @ DPR ${pi.devicePixelRatio}; scroll ${pi.scroll.x},${pi.scroll.y}${morePagesHint}\n\n` +
      'CLEAN IMAGE (read this for content/text):';
    const cleanLabel: ToolResultTextBlock = { type: 'text', text: intro };
    const cleanImg: ToolResultImageBlock = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: r.cleanBase64,
      },
    };
    const blocks: Array<ToolResultTextBlock | ToolResultImageBlock> = [
      cleanLabel,
      cleanImg,
    ];
    if (hasAnnotated) {
      blocks.push({
        type: 'text',
        text:
          '\nANNOTATED IMAGE (numbered boxes mark interactive elements — pick targets from here):',
      });
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: r.annotatedBase64,
        },
      });
      if (labelLines.length > 0) {
        blocks.push({
          type: 'text',
          text:
            `\nLABEL TABLE (${r.labels.length} element${r.labels.length === 1 ? '' : 's'}):\n` +
            labelLines.join('\n') +
            '\n\nTo act on one of these, call BrowserClick / BrowserType / BrowserPress with the `text`, `selector`, or `tabId` shown above.',
        });
      } else {
        blocks.push({
          type: 'text',
          text:
            '\nLABEL TABLE: (no interactive elements detected in the current viewport).',
        });
      }
    }

    // ---- UI summary ---------------------------------------------------
    //
    // The renderer's tool-call card shows this string. Keep it short
    // and useful for the human: paths to both images + label count.
    const sizeStr = (bytes: number) =>
      bytes > 1024
        ? `${(bytes / 1024).toFixed(1)}KB`
        : `${bytes.toLocaleString()}B`;
    const uiParts: string[] = [
      `Clean: ${cleanPath} (${sizeStr(r.bytesClean)})`,
    ];
    if (annotatedPath) {
      uiParts.push(
        `Annotated: ${annotatedPath} (${sizeStr(r.bytesAnnotated)})`
      );
      uiParts.push(
        `${r.labels.length} interactive element${r.labels.length === 1 ? '' : 's'} labeled`
      );
    }
    const uiSummary = uiParts.join('\n');

    return { modelContent: blocks, uiSummary };
  },
};

const BROWSER_WAIT_FOR: ToolDef = {
  schema: {
    name: 'BrowserWaitFor',
    description:
      "Wait for a condition on a tab. Provide ONE of: selector (CSS selector to appear), text (visible text to match), or networkIdle (no network activity for 500ms). 15s default timeout. Use after a navigation or a form submission when the next state's appearance is unpredictable. Returns 'OK' on success; throws with a clear timeout message on failure.",
    input_schema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        networkIdle: { type: 'boolean' },
        timeoutMs: {
          type: 'integer',
          description: 'Override the default 15000 ms timeout.',
        },
      },
      required: ['tabId'],
    },
  },
  async execute(input) {
    const { waitForTab } = await import('./chromeBridge');
    await waitForTab({
      tabId: String(input?.tabId ?? ''),
      selector:
        typeof input?.selector === 'string' && input.selector.trim()
          ? input.selector
          : undefined,
      text:
        typeof input?.text === 'string' && input.text.trim()
          ? input.text
          : undefined,
      networkIdle: !!input?.networkIdle,
      timeoutMs:
        typeof input?.timeoutMs === 'number' ? input.timeoutMs : undefined,
    });
    return 'OK';
  },
};

const BROWSER_CLICK: ToolDef = {
  schema: {
    name: 'BrowserClick',
    description:
      "Click an element in a tab. Provide either `selector` (CSS) or `text` (visible-text matcher). Text is preferred for SPAs whose class hashes change between releases — e.g. clicking the Gmail Compose button by text=\"Compose\" is more durable than chasing a class name. 15 s default timeout.\n\nText match semantics: tries EXACT match first (`innerText.trim() === text`), then SUBSTRING match. The substring match prefers clickish elements (a/button/[role=button|link|option|menuitem|tab]) and picks the smallest containing element when several match. So `text: \"June 3 - CONFIRMED\"` will hit a row whose full label is \"June 3 - CONFIRMED - 2026 Product Vision Meeting\" without you having to know the full string. Pass the SHORTEST distinct fragment of the visible label — that's the most reliable selector and it tolerates trailing UI noise (timestamps, sender names, snippet preview text) the model can't see in advance.\n\nuseDebugger=true — escape hatch for stubborn pages (Outlook search, Shadow DOM custom elements, banks that gate on event.isTrusted). Routes the click through chrome.debugger / CDP Input.dispatchMouseEvent so the page sees a real OS-level click. Cost: Chrome shows a yellow \"started debugging this browser\" banner while attached. Use only when the default synthetic-event click fails to register.\n\nRequires the tab to be authorized — open your own with BrowserOpen, or use BrowserAttach only with explicit user permission.",
    input_schema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        timeoutMs: { type: 'integer' },
        useDebugger: {
          type: 'boolean',
          description:
            'Use chrome.debugger to dispatch a real OS-level click. Default false. Set true only when the synthetic click is being ignored by the page.',
        },
      },
      required: ['tabId'],
    },
  },
  async execute(input) {
    const { clickTab } = await import('./chromeBridge');
    await clickTab({
      tabId: String(input?.tabId ?? ''),
      selector:
        typeof input?.selector === 'string' && input.selector.trim()
          ? input.selector
          : undefined,
      text:
        typeof input?.text === 'string' && input.text.trim()
          ? input.text
          : undefined,
      timeoutMs:
        typeof input?.timeoutMs === 'number' ? input.timeoutMs : undefined,
      useDebugger: !!input?.useDebugger,
    });
    return 'OK';
  },
};

const BROWSER_TYPE: ToolDef = {
  schema: {
    name: 'BrowserType',
    description:
      "Type a string into an input/textarea/contenteditable, simulating real keyboard typing. Per character we fire the full keystroke sequence (keydown → beforeinput → value commit → input → keyup) — the same events a real user produces — so autocomplete dropdowns, type-ahead search, and React/Vue/Lit change-tracking all see the input as if a human typed it. After all characters, a single change event fires.\n\nIf selector is given, focuses it first then types; if not, types into whatever is currently focused (use after a BrowserClick that focused the right field).\n\nTO REPLACE EXISTING FIELD CONTENTS, ALWAYS use clearFirst:true on the same BrowserType call. Don't engineer a multi-step clear-then-type — clearFirst handles it correctly:\n  • With useDebugger:false (default): clearFirst does a native-setter wipe + input event.\n  • With useDebugger:true: clearFirst sends real Ctrl+A + Delete keystrokes, which works on EVERY app we've tested including ones where DOM mutation gets reverted by an app model (Outlook, Notion, custom Lit inputs).\nDO NOT try to clear by sending repeated BrowserPress {key:\"Backspace\"} calls — synthetic-event Backspace doesn't delete in most apps, and even with useDebugger it's strictly slower than clearFirst's Ctrl+A + Delete.\n\nWhen to use this vs BrowserPress: BrowserType for typing words/sentences/numeric strings into a field. BrowserPress for one-off keys like Enter, Tab, Escape, Arrow keys, or shortcut combos (Ctrl+K, Cmd+S). Note that BrowserPress on a single printable char (e.g. {key:\"J\"}) ALSO inserts the char into the focused field — so it's fine for the rare \"send one more keystroke\" case.\n\nRequires an authorized tab (BrowserOpen / BrowserAttach).",
    input_schema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        selector: {
          type: 'string',
          description:
            'Optional CSS selector for the field. Omit to type into the currently focused element.',
        },
        text: {
          type: 'string',
          description: 'Literal text to type.',
        },
        clearFirst: {
          type: 'boolean',
          description: 'Clear the field before typing (only valid with selector).',
        },
        timeoutMs: { type: 'integer' },
        useDebugger: {
          type: 'boolean',
          description:
            'Use chrome.debugger to dispatch real OS-level keystrokes. Default false. Set true for pages where the synthetic-event path types but doesn\'t trigger autocomplete / submit (Outlook search, Lit-based custom inputs).',
        },
      },
      required: ['tabId', 'text'],
    },
  },
  async execute(input) {
    const { typeTab } = await import('./chromeBridge');
    await typeTab({
      tabId: String(input?.tabId ?? ''),
      selector:
        typeof input?.selector === 'string' && input.selector.trim()
          ? input.selector
          : undefined,
      text: String(input?.text ?? ''),
      clearFirst: !!input?.clearFirst,
      timeoutMs:
        typeof input?.timeoutMs === 'number' ? input.timeoutMs : undefined,
      useDebugger: !!input?.useDebugger,
    });
    return 'OK';
  },
};

const BROWSER_PRESS: ToolDef = {
  schema: {
    name: 'BrowserPress',
    description:
      "Press a single key on the focused element. Three behavior modes, mirroring a real keyboard:\n\n" +
      "  • Printable single char with no Ctrl/Alt/Meta (e.g. {key:\"J\"}, {key:\" \"}, {key:\",\"}): fires the full keystroke event sequence AND inserts the character into the focused input/textarea/contenteditable. Same effect as a real keystroke.\n" +
      "  • Shortcut combo (e.g. {key:\"Control+a\"}, {key:\"Meta+c\"}, {key:\"Shift+Tab\"}): fires keystroke events with the modifier bits set; does NOT insert text — let the page handle the shortcut.\n" +
      "  • Named key (e.g. {key:\"Enter\"}, {key:\"Escape\"}, {key:\"ArrowDown\"}, {key:\"Backspace\"}, {key:\"Tab\"}): fires keystroke events; the page reacts (Enter submits forms, Escape closes modals, ArrowDown moves selection in autocompletes, etc.).\n\n" +
      "Use BrowserType for typing whole strings — it's faster and runs the same per-char pipeline. Use BrowserPress for one-off keys: submitting forms (Enter), tabbing between fields (Tab), navigating autocompletes (ArrowDown / Enter), shortcuts (Ctrl+K).\n\n" +
      "Requires an authorized tab (BrowserOpen / BrowserAttach).",
    input_schema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        key: {
          type: 'string',
          description: 'Key string in Playwright keyboard syntax.',
        },
        useDebugger: {
          type: 'boolean',
          description:
            'Use chrome.debugger to dispatch a real OS-level keystroke. Default false. Set true for pages where Enter doesn\'t submit / Tab doesn\'t move focus despite the synthetic events firing (typically apps gating on event.isTrusted).',
        },
      },
      required: ['tabId', 'key'],
    },
  },
  async execute(input) {
    const { pressTab } = await import('./chromeBridge');
    await pressTab({
      tabId: String(input?.tabId ?? ''),
      key: String(input?.key ?? ''),
      useDebugger: !!input?.useDebugger,
    });
    return 'OK';
  },
};

const BROWSER_SCROLL: ToolDef = {
  schema: {
    name: 'BrowserScroll',
    description:
      'Scroll a tab. Pass deltaY (relative pixel delta, positive=down) OR toY (absolute Y position; use 0 to jump to top). Defaults to deltaY=600 if neither is given. Useful for paging through Slack channel scroll-back or a long Gmail thread.\n\nRequires an authorized tab (BrowserOpen / BrowserAttach).',
    input_schema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        deltaY: { type: 'integer' },
        toY: { type: 'integer' },
      },
      required: ['tabId'],
    },
  },
  async execute(input) {
    const { scrollTab } = await import('./chromeBridge');
    await scrollTab({
      tabId: String(input?.tabId ?? ''),
      deltaY: typeof input?.deltaY === 'number' ? input.deltaY : undefined,
      toY: typeof input?.toY === 'number' ? input.toY : undefined,
    });
    return 'OK';
  },
};

const BROWSER_EVAL: ToolDef = {
  schema: {
    name: 'BrowserEval',
    description:
      "Evaluate a JS expression in page context. The expression runs inside the page (NOT the agent / electron) and its return value is JSON-serialized back. Use as an escape hatch when the typed Browser* tools don't cover what you need — e.g. reading a custom window property, extracting structured JSON the page already exposes, or checking a computed style. Side-effecting code (mutations, fetch calls) works but should be a last resort: prefer BrowserClick / BrowserType for user-style interactions.\n\nNote: many sites (Gmail, Outlook, GitHub, banks) block `new Function` / eval via Content-Security-Policy. If the call errors out with a CSP-related message, fall back to BrowserExtract with a CSS selector for the data you need.\n\nRequires an authorized tab (BrowserOpen / BrowserAttach).",
    input_schema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        expression: {
          type: 'string',
          description: 'JS expression. Wrapped in `(...)` automatically.',
        },
      },
      required: ['tabId', 'expression'],
    },
  },
  async execute(input) {
    const { evalTab } = await import('./chromeBridge');
    return await evalTab({
      tabId: String(input?.tabId ?? ''),
      expression: String(input?.expression ?? ''),
    });
  },
};

// ---- App automation (launch + drive GUI apps in an isolated display) ----
//
// These mirror the Browser* tools but for arbitrary desktop applications.
// Apps run on a hidden Win32 desktop (Windows) or a private Xvfb display
// (Linux), so the user's real screen / mouse / keyboard are never disturbed.
// macOS is unsupported (returns a clear message).

async function appBackendOrThrow() {
  const { getBackend } = await import('./appAutomation');
  const backend = await getBackend();
  if (!backend) {
    throw new Error(
      'App automation is not supported on this platform (macOS). It works on Windows and Linux.'
    );
  }
  return backend;
}

const SHOW_IMAGE: ToolDef = {
  schema: {
    name: 'ShowImage',
    description:
      'Display an image INLINE in the conversation (the user sees it and can click to copy or save it). Give a local file PATH or an http(s) URL — the bytes are read by Guy Code and shown directly, so you do NOT put any base64 in your message. Use this whenever you want to show the user a picture: a file on disk, an image you downloaded/generated and saved, etc. DO NOT paste large base64 data: URLs into your text — they exceed your output limit and render corrupt; ShowImage (or a markdown ![](http/file URL)) is the correct way.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a local image file (png/jpg/gif/webp).' },
        url: { type: 'string', description: 'http(s) URL of an image (fetched by Guy Code, no CORS issues).' },
        alt: { type: 'string', description: 'Optional caption/description.' },
      },
    },
  },
  async execute(input): Promise<StructuredToolResult> {
    const path = input.path ? String(input.path) : '';
    const url = input.url ? String(input.url) : '';
    if (!path && !url) return { modelContent: [{ type: 'text', text: 'error: ShowImage needs a path or url.' }], uiSummary: 'ShowImage (no source)' } as any;
    let buf: Buffer;
    let mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' = 'image/png';
    try {
      if (path) {
        const { readFileSync } = await import('node:fs');
        buf = readFileSync(path);
        const ext = path.split('.').pop()?.toLowerCase();
        mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
      } else {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        mediaType = ct.includes('jpeg') || ct.includes('jpg') ? 'image/jpeg' : ct.includes('gif') ? 'image/gif' : ct.includes('webp') ? 'image/webp' : 'image/png';
      }
    } catch (e: any) {
      return { modelContent: [{ type: 'text', text: `error: could not load image: ${e?.message ?? e}` }], uiSummary: 'ShowImage failed' } as any;
    }
    // Guard against absurdly large inline images (the model sees the block too;
    // keep it sane). ~8MB of raw bytes is plenty for any screenshot/photo.
    if (buf.length > 8 * 1024 * 1024) {
      return { modelContent: [{ type: 'text', text: `error: image too large (${Math.round(buf.length / 1024)}KB). Resize it first.` }], uiSummary: 'ShowImage too large' } as any;
    }
    return {
      modelContent: [
        { type: 'text', text: input.alt ? `Image: ${String(input.alt)}` : 'Image shown inline.' },
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
      ],
      uiSummary: `ShowImage ${path || url}`,
    };
  },
};

const APP_LAUNCH: ToolDef = {
  schema: {
    name: 'AppLaunch',
    description:
      'Launch a GUI application in an ISOLATED display so it does NOT appear on the user\'s screen, steal focus, or move their mouse/keyboard — the user keeps working normally while you drive the app. Windows: the app runs on a hidden desktop. Linux: on a private virtual display (needs xvfb/openbox/xdotool/scrot installed; you\'ll get an apt-install hint if missing). NOT supported on macOS. Returns an appId you pass to the other App* tools, plus the app\'s initial windows. After launching, use AppScreenshot to see the app and AppListWindows to get window ids.\n\nIMPORTANT (Windows): CLASSIC Win32 apps automate fully — screenshots, clicks, AND drag-drawing all work. But modern Windows Store / WinUI3 apps — including the BUILT-IN Win11 Paint, Notepad, and Calculator — route input through a pipeline that does NOT accept simulated input on an isolated/background desktop, so you can screenshot them but clicks/drags/typing won\'t register. For drawing or any input automation on Windows, prefer a classic Win32 app (e.g. a classic editor/drawing tool), not the modern Store Paint/Notepad. Linux apps (gedit, GIMP, xterm, etc.) all work.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'Executable to launch. Windows e.g. "notepad.exe" or a full path; Linux e.g. "gedit" or "/usr/bin/xterm". Classic Win32 apps work best; some Win11 Store apps (Notepad, Paint) run in a sandbox that can complicate window-finding.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional command-line arguments.',
        },
        width: { type: 'integer', description: 'Virtual display width (default 1280).' },
        height: { type: 'integer', description: 'Virtual display height (default 800).' },
      },
      required: ['command'],
    },
  },
  async execute(input) {
    const backend = await appBackendOrThrow();
    const pf = await backend.preflight();
    if (!pf.ok) return `error: ${pf.reason}`;
    const handle = await backend.launch({
      command: String(input.command),
      args: Array.isArray(input.args) ? input.args.map(String) : undefined,
      width: typeof input.width === 'number' ? input.width : undefined,
      height: typeof input.height === 'number' ? input.height : undefined,
    });
    // Give the app a beat to create its window, then list.
    await new Promise((r) => setTimeout(r, 1200));
    let windows: any[] = [];
    try {
      windows = await backend.listWindows(handle.appId);
    } catch {
      /* window may not be up yet */
    }
    const winLines = windows
      .map((w) => `  [${w.windowId}] "${w.title}" ${w.width}x${w.height} @ ${w.x},${w.y}`)
      .join('\n');
    return (
      `Launched "${handle.command}" (appId=${handle.appId}, pid=${handle.pid}) on an isolated display.\n` +
      (windows.length
        ? `Windows:\n${winLines}\n\nUse AppScreenshot(appId="${handle.appId}") to see it.`
        : `No window detected yet — call AppScreenshot or AppListWindows in a moment (the app may still be starting).`)
    );
  },
};

const APP_LIST_WINDOWS: ToolDef = {
  schema: {
    name: 'AppListWindows',
    description:
      'List the top-level windows of an app launched with AppLaunch. Returns each window\'s id, title, and geometry. Use the window ids with AppScreenshot / AppClick / AppType / AppPress.',
    input_schema: {
      type: 'object',
      properties: { appId: { type: 'string' } },
      required: ['appId'],
    },
  },
  async execute(input) {
    const backend = await appBackendOrThrow();
    const windows = await backend.listWindows(String(input.appId));
    if (windows.length === 0) return 'No windows (the app may have closed or not opened a window yet).';
    return windows
      .map((w) => `[${w.windowId}] "${w.title}" ${w.width}x${w.height} @ ${w.x},${w.y}`)
      .join('\n');
  },
};

const APP_SCREENSHOT: ToolDef = {
  schema: {
    name: 'AppScreenshot',
    description:
      'Capture a PNG screenshot of an app\'s window (rendered off-screen — the user never sees it). Omit windowId to capture the app\'s primary window. Use this to see what the app looks like before clicking/typing, and again afterward to confirm the result. Coordinates for AppClick are relative to the captured window\'s top-left.',
    input_schema: {
      type: 'object',
      properties: {
        appId: { type: 'string' },
        windowId: { type: 'string', description: 'Optional; defaults to the primary window.' },
      },
      required: ['appId'],
    },
  },
  async execute(input): Promise<StructuredToolResult> {
    const backend = await appBackendOrThrow();
    const shot = await backend.screenshot(
      String(input.appId),
      input.windowId ? String(input.windowId) : undefined
    );
    return {
      modelContent: [
        {
          type: 'text',
          text: `Screenshot of app ${input.appId}${input.windowId ? ` window ${input.windowId}` : ''} (${shot.width}x${shot.height}):`,
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: shot.pngBase64 },
        },
      ],
      uiSummary: `AppScreenshot ${input.appId} (${shot.width}x${shot.height})`,
    };
  },
};

const APP_CLICK: ToolDef = {
  schema: {
    name: 'AppClick',
    description:
      'Click at window-relative coordinates (x,y from the window\'s top-left, as seen in the latest AppScreenshot). On Windows this prefers UI-Automation invoke of the control under the point (robust), falling back to a posted mouse click. Use AppScreenshot first to find the coordinates.',
    input_schema: {
      type: 'object',
      properties: {
        appId: { type: 'string' },
        windowId: { type: 'string' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Default left.' },
      },
      required: ['appId', 'windowId', 'x', 'y'],
    },
  },
  async execute(input) {
    const backend = await appBackendOrThrow();
    await backend.click(
      String(input.appId),
      String(input.windowId),
      Number(input.x),
      Number(input.y),
      input.button === 'right' ? 'right' : 'left'
    );
    return `Clicked (${input.x},${input.y}) in window ${input.windowId}.`;
  },
};

const APP_DRAG: ToolDef = {
  schema: {
    name: 'AppDrag',
    description:
      'Press-move-release drag — this is how you DRAW (freehand strokes), use shape tools (click-drag bounds), move sliders, or drag-and-drop. Unlike AppClick (a single click), AppDrag holds the button down and moves through a path, which canvases and drawing apps register as a real drag. Provide either a `path` of window-relative points (many points = a freehand curve) OR fromX/fromY/toX/toY for a straight drag. Coordinates are window-relative (from the latest AppScreenshot — the (0,0) origin is the window top-left). Take a screenshot afterward to confirm the result.',
    input_schema: {
      type: 'object',
      properties: {
        appId: { type: 'string' },
        windowId: { type: 'string' },
        path: {
          type: 'array',
          description:
            'Ordered window-relative points to drag through, e.g. [{"x":100,"y":100},{"x":160,"y":140},...]. Two points = a straight drag; many = a freehand stroke. The backend interpolates between points for a smooth motion.',
          items: {
            type: 'object',
            properties: { x: { type: 'integer' }, y: { type: 'integer' } },
            required: ['x', 'y'],
          },
        },
        fromX: { type: 'integer', description: 'Convenience straight drag: start X (use instead of path).' },
        fromY: { type: 'integer' },
        toX: { type: 'integer' },
        toY: { type: 'integer' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Default left.' },
      },
      required: ['appId', 'windowId'],
    },
  },
  async execute(input) {
    const backend = await appBackendOrThrow();
    let path: Array<{ x: number; y: number }> = [];
    if (Array.isArray(input.path) && input.path.length > 0) {
      path = input.path.map((p: any) => ({ x: Number(p.x), y: Number(p.y) }));
    } else if (
      typeof input.fromX === 'number' &&
      typeof input.fromY === 'number' &&
      typeof input.toX === 'number' &&
      typeof input.toY === 'number'
    ) {
      path = [
        { x: input.fromX, y: input.fromY },
        { x: input.toX, y: input.toY },
      ];
    } else {
      return 'error: AppDrag needs either a non-empty "path" array or all of fromX/fromY/toX/toY.';
    }
    await backend.drag(
      String(input.appId),
      String(input.windowId),
      path,
      input.button === 'right' ? 'right' : 'left'
    );
    return `Dragged through ${path.length} point(s) in window ${input.windowId}.`;
  },
};

const APP_TYPE: ToolDef = {
  schema: {
    name: 'AppType',
    description:
      'Type a string into the focused control of the app window. Click into the target field first (AppClick) if needed. On Windows this uses UI-Automation value-setting when available, else posts characters to the focused control.',
    input_schema: {
      type: 'object',
      properties: {
        appId: { type: 'string' },
        windowId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['appId', 'windowId', 'text'],
    },
  },
  async execute(input) {
    const backend = await appBackendOrThrow();
    await backend.type(String(input.appId), String(input.windowId), String(input.text));
    return `Typed ${JSON.stringify(String(input.text)).slice(0, 60)} into window ${input.windowId}.`;
  },
};

const APP_PRESS: ToolDef = {
  schema: {
    name: 'AppPress',
    description:
      'Press a key or chord in the app window. Examples: "Enter", "Tab", "Escape", "ctrl+s", "F5", "Down". Use for submitting, navigating, and shortcuts.',
    input_schema: {
      type: 'object',
      properties: {
        appId: { type: 'string' },
        windowId: { type: 'string' },
        key: { type: 'string', description: 'Key or chord, e.g. "Enter" or "ctrl+s".' },
      },
      required: ['appId', 'windowId', 'key'],
    },
  },
  async execute(input) {
    const backend = await appBackendOrThrow();
    await backend.key(String(input.appId), String(input.windowId), String(input.key));
    return `Pressed ${input.key} in window ${input.windowId}.`;
  },
};

const APP_CLOSE: ToolDef = {
  schema: {
    name: 'AppClose',
    description:
      'Close an app launched with AppLaunch and tear down its isolated display/desktop. Always call this when done with an app so it doesn\'t linger.',
    input_schema: {
      type: 'object',
      properties: { appId: { type: 'string' } },
      required: ['appId'],
    },
  },
  async execute(input) {
    const backend = await appBackendOrThrow();
    await backend.close(String(input.appId));
    return `Closed app ${input.appId} and tore down its isolated display.`;
  },
};

// ---- WaitForUser (special: ends turn, surfaces to UI) ----

const WAIT_FOR_USER: ToolDef = {
  schema: {
    name: 'WaitForUser',
    description:
      'Break autonomy and surface a question to the user. Use ONLY when you genuinely need information only the user has, when stuck after retries, or when the top-level task is complete and you want acknowledgment.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What to show the user.' },
      },
      required: ['question'],
    },
  },
  endsTurn: true,
  async execute(input) {
    return input.question; // not actually used; the loop ends here
  },
};

// ---- Subagent tools ------------------------------------------------------
//
// `Task` is the generic primitive: caller picks a role hint and provides a
// freeform prompt. `Plan`, `Execute`, and `Review` are preset wrappers that
// hardwire the role, intentionally restricting the parent's knobs so the
// model uses the right phase for the right job. All four delegate to
// `runSubagent` in `electron/subagent.ts`, which spins up a fresh Anthropic
// call with a curated tool subset and a role-specific system prompt. The
// parent agent's tool call BLOCKS until the child returns its final text —
// no parallelism, no recursion (children cannot spawn grandchildren).
//
// We import lazily inside `execute` to avoid a circular module load:
// subagent.ts imports `TOOLS` to look up tool schemas, and TOOLS imports
// the subagent runners. The `await import` defers the resolution until
// runtime, when both modules are fully initialized.

const TASK: ToolDef = {
  schema: {
    name: 'Task',
    description:
      'Spawn a subagent in a fresh context window. Use when a chunk of work would consume too much of your own context (e.g. exhaustive code search, multi-file refactor, deep review). The subagent runs sequentially (you wait), shares your API key + budget, and returns its final text as your tool_result. It CANNOT spawn further subagents and has no access to TodoWrite or WaitForUser. Pick the role that matches the work: "plan" (read-only investigation + planning), "execute" (code edits + verification), "review" (read-only critique), or "general" (anything else; same toolset as execute).',
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short title for logs and audit (3-8 words).',
        },
        prompt: {
          type: 'string',
          description:
            'The task body the subagent receives as its only user message. Be specific about goals, constraints, and what you want as output. The subagent has no memory of your conversation outside this prompt.',
        },
        role: {
          type: 'string',
          enum: ['plan', 'execute', 'review', 'general'],
          description:
            'Role hint that picks the subagent\'s system prompt + tool subset. Default: "general".',
        },
        max_rounds: {
          type: 'integer',
          description:
            'Optional override for the subagent\'s round cap (one round = one model turn + its tool calls). Default is 200. Raise it when you KNOW the task is large (e.g. a big multi-file refactor or exhaustive review). If the cap is hit, the subagent returns its partial work plus a note.',
        },
      },
      required: ['description', 'prompt'],
    },
  },
  async execute(input, ctx) {
    const { runSubagent } = await import('./subagent');
    // Dynamic import of broadcast avoids a static cycle (agent -> tools).
    const { broadcast } = await import('./agent');
    const role = (input.role || 'general') as
      | 'plan'
      | 'execute'
      | 'review'
      | 'general';
    return runSubagent(
      {
        sessionId: ctx.sessionId,
        projectId: ctx.projectId || '',
        cwd: ctx.cwd,
        apiKeyId: ctx.apiKeyId ?? null,
        signal: ctx.signal,
        memory: ctx.memory,
        emit: broadcast as (e: unknown) => void,
      },
      {
        role,
        description: String(input.description ?? 'task'),
        prompt: String(input.prompt ?? ''),
        maxRounds:
          typeof input.max_rounds === 'number' ? input.max_rounds : undefined,
      }
    );
  },
};

const PLAN: ToolDef = {
  schema: {
    name: 'Plan',
    description:
      'Spawn a planning subagent in a fresh context. The child READS the codebase (Read/Glob/Grep/recall_memory) and returns a numbered, file-grounded plan with risks and an effort estimate. It CANNOT edit, write, or modify any state. Use this when the task ahead is non-trivial and you want a planning pass before committing to execution — keeps your own context small and produces a structured handoff to a follow-up Execute call.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'What needs to be planned. Include constraints, target files (if you know them), and the success criteria.',
        },
        max_rounds: {
          type: 'integer',
          description:
            'Optional override for the subagent round cap (default 200). Raise it for a large planning pass. On cap-hit the subagent returns its partial work plus a note.',
        },
      },
      required: ['task'],
    },
  },
  async execute(input, ctx) {
    const { runSubagent } = await import('./subagent');
    // Dynamic import of broadcast avoids a static cycle (agent -> tools).
    const { broadcast } = await import('./agent');
    return runSubagent(
      {
        sessionId: ctx.sessionId,
        projectId: ctx.projectId || '',
        cwd: ctx.cwd,
        apiKeyId: ctx.apiKeyId ?? null,
        signal: ctx.signal,
        memory: ctx.memory,
        emit: broadcast as (e: unknown) => void,
      },
      {
        role: 'plan',
        description: 'plan',
        prompt: String(input.task ?? ''),
        maxRounds:
          typeof input.max_rounds === 'number' ? input.max_rounds : undefined,
      }
    );
  },
};

const EXECUTE: ToolDef = {
  schema: {
    name: 'Execute',
    description:
      'Spawn an execution subagent in a fresh context. The child has full edit tools (Read/Write/Edit/Bash/Grep/Glob/Wait*) MINUS Task, Plan, Execute, Review, TodoWrite, WaitForUser. Use when you have a clear, scoped change in mind and want it shipped without using up your own context on the diff/test loop. Pass the plan you already have — vague prompts produce sloppy work.',
    input_schema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description:
            'The plan to execute. Be specific: file paths, the exact change, and how to verify (commands to run, tests to look for). The subagent will not see your prior context.',
        },
        max_rounds: {
          type: 'integer',
          description:
            'Optional override for the subagent round cap (default 200). Raise it for a large multi-file change. On cap-hit the subagent returns its partial work plus a note.',
        },
      },
      required: ['plan'],
    },
  },
  async execute(input, ctx) {
    const { runSubagent } = await import('./subagent');
    // Dynamic import of broadcast avoids a static cycle (agent -> tools).
    const { broadcast } = await import('./agent');
    return runSubagent(
      {
        sessionId: ctx.sessionId,
        projectId: ctx.projectId || '',
        cwd: ctx.cwd,
        apiKeyId: ctx.apiKeyId ?? null,
        signal: ctx.signal,
        memory: ctx.memory,
        emit: broadcast as (e: unknown) => void,
      },
      {
        role: 'execute',
        description: 'execute',
        prompt: String(input.plan ?? ''),
        maxRounds:
          typeof input.max_rounds === 'number' ? input.max_rounds : undefined,
      }
    );
  },
};

const REVIEW: ToolDef = {
  schema: {
    name: 'Review',
    description:
      'Spawn a review subagent in a fresh context. The child reads the changed files (Read/Glob/Grep) and returns a structured critique: "Findings:" (bug-shaped issues), "Suggestions:" (non-blocking improvements), and a verdict (APPROVED or CHANGES REQUESTED). Read-only — cannot modify code. Use after an Execute pass when you want a second opinion before declaring done.',
    input_schema: {
      type: 'object',
      properties: {
        work: {
          type: 'string',
          description:
            'Describe what was done, where (file paths + line ranges), and what the reviewer should focus on (correctness, perf, security, style, test coverage). The subagent will read the files itself.',
        },
        max_rounds: {
          type: 'integer',
          description:
            'Optional override for the subagent round cap (default 200). Raise it for an exhaustive review. On cap-hit the subagent returns its partial work plus a note.',
        },
      },
      required: ['work'],
    },
  },
  async execute(input, ctx) {
    const { runSubagent } = await import('./subagent');
    // Dynamic import of broadcast avoids a static cycle (agent -> tools).
    const { broadcast } = await import('./agent');
    return runSubagent(
      {
        sessionId: ctx.sessionId,
        projectId: ctx.projectId || '',
        cwd: ctx.cwd,
        apiKeyId: ctx.apiKeyId ?? null,
        signal: ctx.signal,
        memory: ctx.memory,
        emit: broadcast as (e: unknown) => void,
      },
      {
        role: 'review',
        description: 'review',
        prompt: String(input.work ?? ''),
        maxRounds:
          typeof input.max_rounds === 'number' ? input.max_rounds : undefined,
      }
    );
  },
};

// ---- Registry ----

export const TOOLS: Record<string, ToolDef> = {
  Read: READ,
  Write: WRITE,
  Edit: EDIT,
  [SHELL.schema.name]: SHELL,
  // WSL is registered alongside PowerShell on Windows machines that
  // have a working WSL install (probed once at module load). The
  // model picks whichever shell suits the task; descriptions on each
  // tool make the choice explicit.
  ...(isWslAvailable ? { WSL } : {}),
  Grep: GREP,
  Glob: GLOB,
  TodoWrite: TODOWRITE,
  PlanState: PLAN_STATE,
  WaitForFile: WAIT_FOR_FILE,
  WaitForProcess: WAIT_FOR_PROCESS,
  WaitForTime: WAIT_FOR_TIME,
  WaitForHttp: WAIT_FOR_HTTP,
  recall_memory: RECALL_MEMORY,
  search_conversation: SEARCH_CONVERSATION,
  save_memory: SAVE_MEMORY,
  list_memory: LIST_MEMORY,
  delete_memory: DELETE_MEMORY,
  set_memory_priority: SET_MEMORY_PRIORITY,
  list_skills: LIST_SKILLS,
  read_skill: READ_SKILL,
  Skill: SKILL_TOOL,
  WebSearch: WEB_SEARCH,
  WebFetch: WEB_FETCH,
  // Chrome connector — read/write tools that drive the user's running
  // Chrome via the Guy Code Bridge extension (see
  // electron/chromeBridge.ts → chromeExtBridge.ts). The tools
  // self-error with a clear "not connected" message if the user
  // hasn't connected yet, so they're safe to expose in the global
  // TOOLS map even when no Chrome is running.
  //
  // Tab-ownership policy is enforced at the bridge layer: write
  // tools (Click / Type / Press / Scroll / Eval / Screenshot) only
  // run against tabs the agent itself opened with BrowserOpen, or
  // tabs the user explicitly told the agent to attach to via
  // BrowserAttach. Read tools (List / Extract / WaitFor) can read
  // any tab — passively summarizing a user's open page doesn't
  // hijack focus or mutate state.
  BrowserList: BROWSER_LIST,
  BrowserOpen: BROWSER_OPEN,
  BrowserAttach: BROWSER_ATTACH,
  BrowserExtract: BROWSER_EXTRACT,
  BrowserScreenshot: BROWSER_SCREENSHOT,
  BrowserWaitFor: BROWSER_WAIT_FOR,
  BrowserClick: BROWSER_CLICK,
  BrowserType: BROWSER_TYPE,
  BrowserPress: BROWSER_PRESS,
  BrowserScroll: BROWSER_SCROLL,
  BrowserEval: BROWSER_EVAL,
  ShowImage: SHOW_IMAGE,
  AppLaunch: APP_LAUNCH,
  AppListWindows: APP_LIST_WINDOWS,
  AppScreenshot: APP_SCREENSHOT,
  AppClick: APP_CLICK,
  AppDrag: APP_DRAG,
  AppType: APP_TYPE,
  AppPress: APP_PRESS,
  AppClose: APP_CLOSE,
  WaitForUser: WAIT_FOR_USER,
  Task: TASK,
  Plan: PLAN,
  Execute: EXECUTE,
  Review: REVIEW,
};

export function getToolSchemas(): Anthropic.Tool[] {
  // Native tools sorted alphabetically + MCP tools (also sorted). No
  // server-side Anthropic tools — `web_search_20250305` is gated per
  // organization and trips a 400 for orgs without it; we provide a
  // local equivalent via the `WebSearch` ToolDef registered above.
  // Cache stability matters here: the order must be deterministic
  // across turns within a session. We sort each group individually
  // then concat.
  const native = Object.values(TOOLS)
    .map((t) => t.schema)
    .sort((a, b) => a.name.localeCompare(b.name));
  const mcp = getMcpToolSchemas().sort((a, b) => a.name.localeCompare(b.name));
  return [...native, ...mcp];
}

/**
 * Tool execution result as seen by the agent loop. `content` is what
 * goes into the next `tool_result` block on the wire — either a plain
 * string (the historical case) or an array of Anthropic content blocks
 * (today only used by `BrowserScreenshot` to ship images). `uiSummary`
 * is what the renderer shows in the tool-call card. For plain-string
 * tools the two are equal; for structured tools they differ because
 * the UI can't render an image inline.
 */
export interface ExecutedToolResult {
  content: string | Array<ToolResultTextBlock | ToolResultImageBlock>;
  uiSummary: string;
  isError: boolean;
  /**
   * If present, this tool put the session to sleep until `sleepUntil`
   * (ms-epoch). The agent loop, upon seeing this on a tool result,
   * writes the `tool_result` to JSONL like normal so the conversation
   * history is well-formed, then persists `state=sleeping-tool` +
   * `wake_at_ts=sleepUntil` and exits the loop cleanly without
   * sending another API call. The session resumes via either an
   * in-process timer (snappy when the app stays alive) or the
   * `wakeSleepingToolSweep` (handles app restart while sleeping).
   *
   * Only set by `WaitForTime` today; future tools that need a
   * wall-clock delay without holding a live process can opt in by
   * setting this same field.
   */
  sleepUntil?: number;
}

export async function executeTool(
  name: string,
  input: any,
  ctx: ToolContext
): Promise<ExecutedToolResult> {
  // MCP-namespaced tools route through the MCP client, not our local registry.
  // They only ever return plain strings; widen to the new shape here.
  if (name.startsWith('mcp__')) {
    try {
      log.info(`[tool:${name}] start (mcp)`);
      const r = await invokeMcpTool(name, input);
      if (r)
        return { content: r.content, uiSummary: r.content, isError: r.isError };
      return {
        content: `error: unknown MCP tool ${name}`,
        uiSummary: `error: unknown MCP tool ${name}`,
        isError: true,
      };
    } catch (e: any) {
      const msg = `error: ${e?.message || String(e)}`;
      log.warn(`[tool:${name}] mcp threw`, e);
      return { content: msg, uiSummary: msg, isError: true };
    }
  }
  const tool = TOOLS[name];
  if (!tool)
    return {
      content: `error: unknown tool ${name}`,
      uiSummary: `error: unknown tool ${name}`,
      isError: true,
    };
  try {
    log.info(`[tool:${name}] start`);
    const raw = await tool.execute(input, ctx);
    if (isStructuredToolResult(raw)) {
      return {
        content: raw.modelContent,
        uiSummary: raw.uiSummary,
        isError: false,
        // Forward the persistent-sleep signal if the tool set it. The
        // agent loop inspects this on the ExecutedToolResult side to
        // decide whether to exit cleanly into `sleeping-tool` state.
        ...(typeof raw.sleepUntil === 'number' ? { sleepUntil: raw.sleepUntil } : {}),
      };
    }
    // Plain string — keep historical behavior (content === uiSummary).
    return { content: raw, uiSummary: raw, isError: false };
  } catch (e: any) {
    const msg = `error: ${e?.message || String(e)}`;
    log.warn(`[tool:${name}] threw`, e);
    return { content: msg, uiSummary: msg, isError: true };
  }
}

export function isWaitForUser(name: string): boolean {
  return name === 'WaitForUser';
}
