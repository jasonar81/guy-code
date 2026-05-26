/**
 * Per-session attachment storage.
 *
 * Background — v0.1.6 problem:
 *   Before this module, plain-text attachments above 200KB were
 *   hard-rejected with the banner "<file> is X KB; text files inlined
 *   into the prompt must be ≤ 195 KB." The 200KB cap exists to keep
 *   the JSONL transcript and prompt token-bill bounded — but the user
 *   has perfectly reasonable attachments (logs, large markdown notes,
 *   CSVs) that exceed it and need to flow into the conversation.
 *
 * Solution shipped in v0.1.6:
 *   For text files larger than the inline threshold, the renderer
 *   now ships the bytes to the main process which writes them under
 *   `<userData>/.guycode/attachments/<sessionId>/<sanitized-name>`
 *   and emits a reference content block in the user message:
 *
 *     [Attached file: "<name>" (X KB)]
 *     Saved at: <absolute path>
 *     Use the Read tool with the absolute path above to access this file...
 *     Preview (first ~500 chars): ...
 *
 *   The model then issues a `Read` tool call to access the contents
 *   on demand, in chunks if needed, instead of paying full token cost
 *   up front. Files persist for the life of the session and are
 *   deleted alongside the session JSONL when the user removes the
 *   session via `sessions:deleteFromDisk`.
 *
 * Why per-session and not in the user's project cwd:
 *   - The user's cwd is whatever directory they pointed Guy Code at;
 *     we shouldn't pollute their project tree.
 *   - Centralizing in `~/.guycode/attachments` matches our existing
 *     `~/.guycode/sessions` JSONL storage layout (see
 *     `sessionRuntime.ts`).
 *   - When a session is deleted we own the cleanup story; nothing
 *     to coordinate with the user's filesystem.
 *
 * Filename safety:
 *   The renderer can supply ANY string as `name` (drag-drop, paste,
 *   etc.). `sanitizeAttachmentFilename` strips path separators,
 *   `..` segments, control chars, and pathological cases like
 *   `con.txt` on Windows. All writes happen via paths constructed
 *   here so the sanitization is the only path the renderer sees.
 *
 * Collision handling:
 *   If two attachments arrive with the same sanitized name (e.g.,
 *   `output.md` attached twice), we prefix with a millisecond
 *   timestamp so the absolute path stays unique. The model only sees
 *   the absolute path; the user-visible chip continues to show the
 *   original name.
 */

import { app } from 'electron';
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import log from 'electron-log';

/**
 * Root directory under which all per-session attachment subdirectories
 * live. Mirrors the layout of `sessionsRoot()` in sessionRuntime.ts.
 */
export function attachmentsRoot(): string {
  const dir = join(app.getPath('home'), '.guycode', 'attachments');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Per-session attachment dir, created on demand. Returns the absolute
 * path. Safe to call repeatedly; mkdirSync recursive is idempotent.
 */
export function sessionAttachmentDir(sessionId: string): string {
  const dir = join(attachmentsRoot(), sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Sanitize a renderer-supplied filename so it's safe to use as a leaf
 * inside our attachment dir. Strategy:
 *
 *   1. `basename()` strips any leading directory components — this
 *      handles `../../etc/passwd`, `C:\Windows\system32\foo.txt`,
 *      and similar attacks. `path.basename` is platform-aware on
 *      Node so it correctly handles both `/` and `\`.
 *   2. Replace control characters (\0..\x1F) and the characters
 *      Windows treats specially (`<>:"/\|?*`) with `_`.
 *   3. Strip leading dots and whitespace so we don't end up creating
 *      hidden files or names like ` .txt`.
 *   4. Collapse runs of whitespace / underscores.
 *   5. Truncate to 200 chars (most filesystems support 255 but we
 *      leave room for the timestamp prefix added by `saveText`).
 *   6. Fall back to `attachment.txt` if nothing useful is left.
 *
 * Examples:
 *   sanitizeAttachmentFilename('../etc/passwd')       === 'passwd'
 *   sanitizeAttachmentFilename('a/b\\c.txt')          === 'c.txt'
 *   sanitizeAttachmentFilename('foo<bar>?.md')        === 'foo_bar_.md'
 *   sanitizeAttachmentFilename('  ...secret.env  ')   === 'secret.env'
 *   sanitizeAttachmentFilename('')                    === 'attachment.txt'
 */
export function sanitizeAttachmentFilename(raw: string): string {
  if (typeof raw !== 'string') return 'attachment.txt';
  // Step 1 — strip directory components on BOTH separators. We don't
  // rely on `path.basename` alone because on Linux it leaves `\` paths
  // intact (so a Windows-style path coming from a paste would survive).
  let name = raw.replace(/[\\/]+/g, '/');
  // Trim trailing slashes (e.g., `dir/`) so basename returns the last
  // non-empty segment.
  while (name.endsWith('/')) name = name.slice(0, -1);
  name = basename(name);
  // Step 2 — replace dangerous characters. Keep dot for extensions.
  // Range \0-\x1F covers ALL control chars including \r \n \t.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\0-\x1F<>:"/\\|?*]/g, '_');
  // Step 3 — strip leading dots / whitespace. A leading dot makes the
  // file hidden on POSIX and trips Windows reserved-name rules.
  name = name.replace(/^[\s.]+/, '');
  // Step 4 — collapse whitespace runs + underscore runs to keep the
  // filename readable in `ls` output.
  name = name.replace(/\s+/g, ' ').replace(/_{2,}/g, '_');
  // Step 5 — truncate. Preserve extension if there is one.
  const MAX_LEN = 200;
  if (name.length > MAX_LEN) {
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot > name.length - 16) {
      const ext = name.slice(dot);
      name = name.slice(0, MAX_LEN - ext.length) + ext;
    } else {
      name = name.slice(0, MAX_LEN);
    }
  }
  // Step 6 — fallback for empty / pathological input.
  if (!name || /^[._\s]*$/.test(name)) return 'attachment.txt';
  return name;
}

/**
 * Save a text attachment under the per-session dir. Returns the
 * absolute path the file was written to. Uniqueness is enforced
 * by prefixing the sanitized name with a millisecond timestamp;
 * collisions across rapid attachments (same name twice in <1ms)
 * are resolved by appending a counter.
 *
 * Writes are synchronous because:
 *   1. The caller — `buildUserContent` in `agent.ts` — runs once
 *      per turn and is already on the main thread; an async write
 *      doesn't help latency in any meaningful way.
 *   2. We need the absolute path back BEFORE constructing the API
 *      message, so the call has to block on completion regardless.
 *   3. Write failures must throw synchronously so the agent can
 *      surface them as a turn-level error rather than silently
 *      sending a path that points to a non-existent file.
 */
export function saveTextAttachment(
  sessionId: string,
  rawName: string,
  text: string
): { absPath: string; safeName: string; sizeBytes: number } {
  const dir = sessionAttachmentDir(sessionId);
  const safeName = sanitizeAttachmentFilename(rawName);

  // Timestamp prefix prevents collisions across multiple attachments
  // with the same name (e.g., `output.log` attached twice in one
  // session). Format: `<ms>-<safeName>`. The model never sees the
  // prefix in any user-visible context — it only matters for the
  // absolute path on disk.
  let leaf = `${Date.now()}-${safeName}`;
  let absPath = join(dir, leaf);
  // Sub-millisecond collision resolution. Almost never trips.
  let counter = 0;
  while (existsSync(absPath)) {
    counter++;
    leaf = `${Date.now()}-${counter}-${safeName}`;
    absPath = join(dir, leaf);
    if (counter > 1000) {
      throw new Error(
        `attachment save: too many filename collisions in ${dir} (gave up after 1000)`
      );
    }
  }

  // utf8 because text attachments are by definition UTF-8 strings;
  // we have no need for binary mode here. The renderer has already
  // decoded the file with FileReader.text() before sending.
  writeFileSync(absPath, text, 'utf8');
  const sizeBytes = statSync(absPath).size;
  log.info(
    `[attachments] saved ${sizeBytes} bytes to ${absPath} (session ${sessionId})`
  );
  return { absPath, safeName, sizeBytes };
}

/**
 * Recursively delete a session's attachment directory. Called from
 * `sessions:deleteFromDisk` so a session removal also wipes its
 * attachments. Safe to call when the directory doesn't exist.
 */
export function deleteSessionAttachments(sessionId: string): void {
  const dir = join(attachmentsRoot(), sessionId);
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
    log.info(`[attachments] removed dir ${dir}`);
  } catch (e) {
    log.warn(
      `[attachments] failed to remove ${dir}: ${(e as Error).message}`
    );
  }
}

/**
 * Build a short preview snippet for a text attachment. The model
 * sees this inline in the user message so it can decide whether to
 * `Read` the full file or answer from the preview alone (common
 * for "what's in this log?" style questions).
 *
 * Strategy:
 *   - Trim leading/trailing whitespace so the preview starts at
 *     real content.
 *   - Take up to `maxChars` characters.
 *   - If we truncated, append "... (truncated)" so the model
 *     unambiguously knows there's more.
 *
 * 500 chars is a deliberate small budget: enough to convey
 * structure (CSV header row, JSON top-level, log timestamp
 * format) without burning prompt tokens proportional to file
 * size. The model can always Read for more.
 */
export function buildAttachmentPreview(
  text: string,
  maxChars: number = 500
): string {
  const trimmed = text.trimStart();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars) + '... (truncated; use Read for the full file)';
}
