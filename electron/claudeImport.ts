import {
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import log from 'electron-log';
import {
  upsertProject,
  upsertSession,
  insertUsageEvent,
  getImportedFile,
  setImportedFile,
  listSessionsForTitleBackfill,
  setSessionTitle,
} from './db';
import { computeCostMicros } from './pricing';

export interface ImportProgress {
  phase: 'scan' | 'parse' | 'done' | 'error';
  filesTotal: number;
  filesProcessed: number;
  bytesProcessed: number;
  newUsageEvents: number;
  newSessions: number;
  newProjects: number;
  currentPath?: string;
  error?: string;
}

export function getClaudeProjectsDir(): string | null {
  const home = app.getPath('home');
  const dir = join(home, '.claude', 'projects');
  return existsSync(dir) ? dir : null;
}

/**
 * Decode a Claude project slug back into its cwd.
 * Slugs encode `:` and `\` (or `/`) as `-`. The mapping is lossy — `C--Users-jarnold-Downloads`
 * could mean either `C:\Users\jarnold\Downloads` or `C:/Users/jarnold/Downloads`.
 * Since the JSONL itself contains the canonical `cwd` field, we read the first event of the first
 * JSONL in the project dir to get the real cwd. Slug decoding is a fallback if that fails.
 */
function fallbackDecodeCwd(slug: string): string {
  // First "--" usually = ":\". Subsequent "-" = "\".
  let s = slug.replace(/^([A-Za-z])--/, '$1:\\');
  s = s.replace(/-/g, '\\');
  return s;
}

interface SessionAccumulator {
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  endedAt?: number;
  messageCount: number;
  lastPreview?: string;
  firstUserPreview?: string;
  /** Latest user-set custom title (`{type:'custom-title',customTitle}` event). */
  customTitle?: string;
  /** Latest auto-generated AI title (`{type:'ai-title',aiTitle}` event). */
  aiTitle?: string;
}

/** Cap titles short enough to fit in the sidebar without wrapping. */
const TITLE_MAX_CHARS = 80;

function makeTitle(s: string | undefined): string | undefined {
  if (!s) return undefined;
  // Collapse whitespace, strip markdown noise, then truncate.
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  if (oneLine.length <= TITLE_MAX_CHARS) return oneLine;
  return oneLine.slice(0, TITLE_MAX_CHARS - 1) + '…';
}

/** Read the first non-blank line of a JSONL to extract project cwd. */
function readFirstJsonObject(path: string): any | null {
  try {
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const head = buf.subarray(0, bytes).toString('utf8');
    const nl = head.indexOf('\n');
    const line = nl === -1 ? head : head.slice(0, nl);
    if (!line.trim()) return null;
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function previewFromContent(content: any): string | undefined {
  if (typeof content === 'string') return content.slice(0, 200);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        return block.text.slice(0, 200);
      }
      if (block?.type === 'tool_use' && block.name) {
        return `[tool_use: ${block.name}]`.slice(0, 200);
      }
    }
  }
  return undefined;
}

function tsToMs(ts: any): number | undefined {
  if (typeof ts === 'string') {
    const t = Date.parse(ts);
    return Number.isNaN(t) ? undefined : t;
  }
  if (typeof ts === 'number') return ts;
  return undefined;
}

/**
 * Parse a JSONL file from `startOffset` byte to end. Returns parse stats and updates DB.
 * Resilient to corrupted lines (logs and skips).
 */
function parseJsonl(args: {
  projectId: string;
  filePath: string;
  startOffset: number;
}): { newUsageEvents: number; newSession: boolean; bytesProcessed: number; lastByteOffset: number; sessionAccum: SessionAccumulator } {
  const { projectId, filePath, startOffset } = args;
  const fd = openSync(filePath, 'r');
  let newUsageEvents = 0;
  let newSession = false;
  let bytesProcessed = 0;
  const sessionAccum: SessionAccumulator = {
    sessionId: '',
    messageCount: 0,
  };

  try {
    const stat = statSync(filePath);
    const totalSize = stat.size;
    const chunkSize = 1024 * 1024; // 1MB chunks
    const buf = Buffer.alloc(chunkSize);
    let offset = startOffset;
    let leftover = '';

    while (offset < totalSize) {
      const want = Math.min(chunkSize, totalSize - offset);
      const got = readSync(fd, buf, 0, want, offset);
      if (got === 0) break;
      offset += got;
      bytesProcessed += got;
      const chunk = leftover + buf.subarray(0, got).toString('utf8');
      const lastNl = chunk.lastIndexOf('\n');
      let processable: string;
      if (lastNl === -1) {
        leftover = chunk;
        continue;
      }
      processable = chunk.slice(0, lastNl);
      leftover = chunk.slice(lastNl + 1);

      const lines = processable.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt: any;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        const sessionId = evt.sessionId;
        if (typeof sessionId === 'string' && sessionId) {
          sessionAccum.sessionId = sessionId;
        }
        const cwd = evt.cwd;
        if (typeof cwd === 'string') sessionAccum.cwd = cwd;

        const tsMs = tsToMs(evt.timestamp);
        if (tsMs && (!sessionAccum.startedAt || tsMs < sessionAccum.startedAt)) {
          sessionAccum.startedAt = tsMs;
        }
        if (tsMs && (!sessionAccum.endedAt || tsMs > sessionAccum.endedAt)) {
          sessionAccum.endedAt = tsMs;
        }

        if (evt.type === 'user' || evt.type === 'assistant') {
          sessionAccum.messageCount += 1;
          const p = previewFromContent(evt?.message?.content);
          if (p) sessionAccum.lastPreview = p;
          // Capture the very first human user message as the session title source.
          if (
            evt.type === 'user' &&
            !sessionAccum.firstUserPreview &&
            evt?.message?.role === 'user'
          ) {
            // Skip messages that are tool_result envelopes (synthetic user turns)
            const c = evt?.message?.content;
            const isToolResultOnly =
              Array.isArray(c) && c.every((b) => b?.type === 'tool_result');
            if (!isToolResultOnly && p) sessionAccum.firstUserPreview = p;
          }
        }
        // Claude's auto title — we keep the LAST one we see (it regenerates).
        if (evt?.type === 'ai-title' && typeof evt.aiTitle === 'string') {
          sessionAccum.aiTitle = evt.aiTitle;
        }
        // User-set custom title (rename in Claude Code) — LAST wins.
        if (evt?.type === 'custom-title' && typeof evt.customTitle === 'string') {
          sessionAccum.customTitle = evt.customTitle;
        }

        // Cost extraction from assistant turns
        if (evt.type === 'assistant' && evt.message?.usage) {
          const u = evt.message.usage;
          const inputTokens = u.input_tokens ?? 0;
          const cacheReadTokens = u.cache_read_input_tokens ?? 0;
          const cacheCreateTotal = u.cache_creation_input_tokens ?? 0;
          const cacheCreate1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
          const cacheCreate5m =
            u.cache_creation?.ephemeral_5m_input_tokens ??
            Math.max(0, cacheCreateTotal - cacheCreate1h);
          const outputTokens = u.output_tokens ?? 0;
          const model = evt.message.model || 'unknown';
          const cost = computeCostMicros(model, {
            inputTokens,
            cacheReadTokens,
            cacheWrite5mTokens: cacheCreate5m,
            cacheWrite1hTokens: cacheCreate1h,
            outputTokens,
          });
          insertUsageEvent({
            ts: tsMs ?? Date.now(),
            projectId,
            sessionId: sessionAccum.sessionId || sessionId || 'unknown',
            turnId: evt.uuid || null,
            model,
            inputTokens,
            cacheReadTokens,
            cacheWrite5mTokens: cacheCreate5m,
            cacheWrite1hTokens: cacheCreate1h,
            outputTokens,
            costUsdMicros: cost,
            source: 'imported',
          });
          newUsageEvents += 1;
        }
      }
    }

    // Handle trailing leftover line (no newline at EOF)
    if (leftover.trim()) {
      try {
        JSON.parse(leftover); // validate; we don't process here in case file is still being written
      } catch {
        /* discard */
      }
    }

    if (sessionAccum.sessionId) {
      newSession = true;
    }

    return {
      newUsageEvents,
      newSession,
      bytesProcessed,
      lastByteOffset: offset,
      sessionAccum,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan ~/.claude/projects/ and incrementally import all sessions into our DB.
 * Sends progress updates to all renderer windows over IPC channel `import:progress`.
 */
export async function importClaudeProjects(window?: BrowserWindow | null): Promise<ImportProgress> {
  const projectsDir = getClaudeProjectsDir();
  const progress: ImportProgress = {
    phase: 'scan',
    filesTotal: 0,
    filesProcessed: 0,
    bytesProcessed: 0,
    newUsageEvents: 0,
    newSessions: 0,
    newProjects: 0,
  };
  const send = (p: ImportProgress) => {
    const payload = { ...p };
    if (window && !window.isDestroyed()) {
      window.webContents.send('import:progress', payload);
    }
    BrowserWindow.getAllWindows().forEach((w) => {
      if (w !== window && !w.isDestroyed()) {
        w.webContents.send('import:progress', payload);
      }
    });
  };

  if (!projectsDir) {
    progress.phase = 'done';
    send(progress);
    return progress;
  }

  // Scan project dirs and JSONL files
  const projectSlugs = readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  type Job = { projectId: string; cwd: string; filePath: string; size: number; mtime: number };
  const jobs: Job[] = [];

  for (const slug of projectSlugs) {
    const projDir = join(projectsDir, slug);
    let files: string[];
    try {
      files = readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
    } catch (e) {
      log.warn(`[import] cannot read ${projDir}: ${e}`);
      continue;
    }

    // Resolve cwd by reading first event of first jsonl (most reliable)
    let cwd: string | undefined;
    for (const f of files) {
      const fp = join(projDir, f);
      const first = readFirstJsonObject(fp);
      if (first?.cwd && typeof first.cwd === 'string') {
        cwd = first.cwd;
        break;
      }
    }
    if (!cwd) cwd = fallbackDecodeCwd(slug);

    upsertProject({
      id: slug,
      cwd,
      lastActivityTs: null,
      createdAt: Date.now(),
    });
    progress.newProjects += 1;

    for (const f of files) {
      const fp = join(projDir, f);
      try {
        const stat = statSync(fp);
        jobs.push({
          projectId: slug,
          cwd,
          filePath: fp,
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      } catch {
        /* skip */
      }
    }
  }

  progress.filesTotal = jobs.length;
  progress.phase = 'parse';
  send(progress);

  for (const job of jobs) {
    progress.currentPath = job.filePath;
    send(progress);

    const prior = getImportedFile(job.filePath);
    let startOffset = 0;
    if (prior) {
      // If size hasn't grown and mtime hasn't changed, skip.
      if (prior.size === job.size && prior.mtime === job.mtime) {
        progress.filesProcessed += 1;
        send(progress);
        continue;
      }
      // If size grew, resume from last offset; otherwise re-import (probably truncated/rewritten).
      if (job.size > prior.size) {
        startOffset = prior.last_byte_offset;
      } else {
        startOffset = 0;
      }
    }

    try {
      const r = parseJsonl({
        projectId: job.projectId,
        filePath: job.filePath,
        startOffset,
      });
      progress.newUsageEvents += r.newUsageEvents;
      progress.bytesProcessed += r.bytesProcessed;

      if (r.sessionAccum.sessionId) {
        upsertSession({
          id: r.sessionAccum.sessionId,
          projectId: job.projectId,
          jsonlPath: job.filePath,
          jsonlMtime: job.mtime,
          jsonlSize: job.size,
          startedAt: r.sessionAccum.startedAt ?? null,
          endedAt: r.sessionAccum.endedAt ?? null,
          messageCount: r.sessionAccum.messageCount,
          lastMessagePreview: r.sessionAccum.lastPreview ?? null,
          title: bestTitle(r.sessionAccum) ?? null,
        });
        progress.newSessions += 1;
      }

      setImportedFile({
        path: job.filePath,
        size: job.size,
        mtime: job.mtime,
        lastByteOffset: r.lastByteOffset,
      });
    } catch (e: any) {
      log.error(`[import] failed for ${job.filePath}: ${e?.message || e}`);
    }

    progress.filesProcessed += 1;
    if (progress.filesProcessed % 10 === 0) send(progress);
  }

  // Backfill / upgrade titles for ALL sessions — we want to pick up
  // `custom-title` / `ai-title` events for rows imported earlier with the
  // crude first-user-message heuristic.
  try {
    const backfilled = backfillTitles();
    if (backfilled > 0) log.info(`[import] upgraded ${backfilled} session titles`);
  } catch (e) {
    log.error('[import] title backfill failed', e);
  }

  progress.phase = 'done';
  progress.currentPath = undefined;
  send(progress);
  return progress;
}

/** Pick the best title from accumulated sources (priority: custom > ai > first-user). */
function bestTitle(s: {
  customTitle?: string;
  aiTitle?: string;
  firstUserPreview?: string;
}): string | undefined {
  return makeTitle(s.customTitle) ?? makeTitle(s.aiTitle) ?? makeTitle(s.firstUserPreview);
}

/**
 * Scan EVERY known session JSONL and upgrade its `title` to the best
 * available signal: latest `custom-title` event (user rename) > latest
 * `ai-title` event (Claude's own auto title) > first user message.
 *
 * Returns the count of rows whose title actually changed.
 */
export function backfillTitles(): number {
  const targets = listSessionsForTitleBackfill();
  let count = 0;
  for (const t of targets) {
    if (!existsSync(t.jsonl_path)) continue;
    try {
      // Read whole file as text so we can pick up `custom-title` / `ai-title`
      // events which may appear anywhere (the user can rename mid-conversation).
      const text = readFileSync(t.jsonl_path, 'utf8');
      const lines = text.split('\n');
      let firstUserPreview: string | undefined;
      let aiTitle: string | undefined;
      let customTitle: string | undefined;
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt: any;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt?.type === 'custom-title' && typeof evt.customTitle === 'string') {
          customTitle = evt.customTitle;
          continue;
        }
        if (evt?.type === 'ai-title' && typeof evt.aiTitle === 'string') {
          aiTitle = evt.aiTitle;
          continue;
        }
        if (firstUserPreview) continue;
        if (evt?.type !== 'user') continue;
        if (evt?.message?.role !== 'user') continue;
        const c = evt?.message?.content;
        const isToolResultOnly =
          Array.isArray(c) && c.every((b) => b?.type === 'tool_result');
        if (isToolResultOnly) continue;
        const p = previewFromContent(c);
        if (p) firstUserPreview = p;
      }
      const title = bestTitle({ customTitle, aiTitle, firstUserPreview });
      if (title && title !== t.title) {
        setSessionTitle(t.id, title);
        count += 1;
      }
    } catch (e) {
      log.warn(`[backfillTitles] ${t.jsonl_path}: ${(e as Error).message}`);
    }
  }
  return count;
}
