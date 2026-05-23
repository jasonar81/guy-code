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
import { setSessionState } from './db';
import {
  listClaudeSkills,
  recallFromBundle,
  saveMemory,
  listGuyMemory,
  deleteGuyMemory,
} from './memory';
import type { MemoryBundle } from './memory';
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
}

export interface ToolDef {
  schema: Anthropic.Tool;
  /** Returns the string content that goes into the tool_result. */
  execute: (input: any, ctx: ToolContext) => Promise<string>;
  /** If true, the agent loop ends after this tool with no follow-up. */
  endsTurn?: boolean;
}

const isWin = process.platform === 'win32';

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
      const p = spawn(cmd, args, { cwd, env: process.env });
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
      'Set the current todo list for this session. Each todo has content, status (pending|in_progress|completed), and id. Display only — does not affect execution.',
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
            },
            required: ['id', 'content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  async execute(input) {
    return `noted ${input.todos.length} todo(s)`;
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
      'Pause the turn for a fixed duration in milliseconds (max 1 hour). Use sparingly — prefer WaitForFile/Process/Http when possible. Session shows waiting-on-system.',
    input_schema: {
      type: 'object',
      properties: { duration_ms: { type: 'integer' } },
      required: ['duration_ms'],
    },
  },
  async execute(input, ctx) {
    const ms = clampWait(input.duration_ms, 1000);
    return await withWaitingState(ctx, async () => {
      try {
        await sleep(ms, ctx.signal);
        return `WaitForTime: slept ${ms}ms`;
      } catch {
        return `WaitForTime: aborted`;
      }
    });
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
      'Search the project memory (CLAUDE.md / MEMORY.md leaves loaded at session start) for a substring. Returns matching paragraphs with their source path. Use this when you need to look something up without re-quoting the entire memory tree.',
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
    if (!ctx.memory) return '(no memory loaded for this session)';
    return recallFromBundle(ctx.memory, String(input.query), input.max_results ?? 8);
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
      },
      required: ['scope', 'key', 'content'],
    },
  },
  async execute(input, ctx) {
    const scope = String(input.scope) as 'global' | 'project';
    const r = saveMemory({
      scope,
      key: String(input.key),
      content: String(input.content ?? ''),
      mode: input.mode === 'append' ? 'append' : 'replace',
      projectId: ctx.projectId,
    });
    if (!r.ok) return `error: ${r.error}`;
    return `Saved ${scope} memory (${r.bytes}b) at ${r.path}. Will be loaded into context at the start of every future session.`;
  },
};

const LIST_MEMORY: ToolDef = {
  schema: {
    name: 'list_memory',
    description:
      'List Guy-owned writable memory leaves. Only shows files under ~/.guycode (not the imported Claude memory). Use this to discover what you have saved before adding more.',
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['global', 'project', 'all'],
          description: "Default 'all'.",
        },
      },
    },
  },
  async execute(input, ctx) {
    const scope = (input.scope as 'global' | 'project' | 'all' | undefined) ?? 'all';
    const rows = listGuyMemory({ scope, projectId: ctx.projectId });
    if (rows.length === 0) return '(no Guy-owned memory saved yet)';
    return rows
      .map(
        (r) =>
          `[${r.scope}] ${r.path}\n    ${r.bytes}b, last modified ${new Date(r.mtime).toISOString()}`
      )
      .join('\n');
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

// ---- Registry ----

export const TOOLS: Record<string, ToolDef> = {
  Read: READ,
  Write: WRITE,
  Edit: EDIT,
  [SHELL.schema.name]: SHELL,
  Grep: GREP,
  Glob: GLOB,
  TodoWrite: TODOWRITE,
  WaitForFile: WAIT_FOR_FILE,
  WaitForProcess: WAIT_FOR_PROCESS,
  WaitForTime: WAIT_FOR_TIME,
  WaitForHttp: WAIT_FOR_HTTP,
  recall_memory: RECALL_MEMORY,
  search_conversation: SEARCH_CONVERSATION,
  save_memory: SAVE_MEMORY,
  list_memory: LIST_MEMORY,
  delete_memory: DELETE_MEMORY,
  list_skills: LIST_SKILLS,
  read_skill: READ_SKILL,
  WaitForUser: WAIT_FOR_USER,
};

export function getToolSchemas(): Anthropic.Tool[] {
  // Native tools sorted alphabetically + MCP tools (also sorted) appended.
  // Cache stability matters here: the order must be deterministic across
  // turns within a session. We sort both groups individually then concat.
  const native = Object.values(TOOLS)
    .map((t) => t.schema)
    .sort((a, b) => a.name.localeCompare(b.name));
  const mcp = getMcpToolSchemas().sort((a, b) => a.name.localeCompare(b.name));
  return [...native, ...mcp];
}

export async function executeTool(
  name: string,
  input: any,
  ctx: ToolContext
): Promise<{ content: string; isError: boolean }> {
  // MCP-namespaced tools route through the MCP client, not our local registry.
  if (name.startsWith('mcp__')) {
    try {
      log.info(`[tool:${name}] start (mcp)`);
      const r = await invokeMcpTool(name, input);
      if (r) return r;
      return { content: `error: unknown MCP tool ${name}`, isError: true };
    } catch (e: any) {
      log.warn(`[tool:${name}] mcp threw`, e);
      return { content: `error: ${e?.message || String(e)}`, isError: true };
    }
  }
  const tool = TOOLS[name];
  if (!tool) return { content: `error: unknown tool ${name}`, isError: true };
  try {
    log.info(`[tool:${name}] start`);
    const content = await tool.execute(input, ctx);
    return { content, isError: false };
  } catch (e: any) {
    log.warn(`[tool:${name}] threw`, e);
    return { content: `error: ${e?.message || String(e)}`, isError: true };
  }
}

export function isWaitForUser(name: string): boolean {
  return name === 'WaitForUser';
}
