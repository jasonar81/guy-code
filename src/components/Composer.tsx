import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import clsx from 'clsx';
import { Send, Square, AlertTriangle, X, Zap, Paperclip, FileText } from 'lucide-react';
import { useApp } from '@/lib/store';
import { formatUsdMicros, formatTokens } from '@/lib/format';
import type { Attachment, SkillSummary } from '@/types';
import { SlashCommandMenu } from './SlashCommandMenu';
import { detectSlashContext, filterSkills, applySkillPick } from '@/lib/slashMenu';

interface Props {
  sessionId: string;
  /**
   * Whether this pane is currently the visible session. Used to
   * auto-focus the textarea on session switch / new-session creation
   * so the user can start typing immediately without an extra click.
   * Panes stay mounted across switches (hidden via `display:none`),
   * so we need an explicit visibility signal to know when to focus.
   */
  visible: boolean;
}

// Per-attachment caps. Anthropic accepts images up to 5 MB base64 (~3.7 MB
// raw) and PDFs up to 32 MB; we're a touch stricter on images so the JSONL
// doesn't balloon. Plain-text files inline directly into the prompt.
const MAX_IMAGE_BYTES = 4_500_000;
const MAX_PDF_BYTES = 24_000_000;
const MAX_TEXT_BYTES = 200_000;
const MAX_TOTAL_BYTES = 30_000_000;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml',
  'yaml', 'yml', 'toml', 'ini', 'env', 'sh', 'bash', 'zsh',
  'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'sql', 'html', 'css', 'scss',
]);

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function bytesToBase64(buf: ArrayBuffer): string {
  // Chunked btoa: passing a 5 MB Uint8Array straight into String.fromCharCode
  // overflows the JS call stack on some engines. 32 KB chunks is safe.
  const u8 = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

function pickImageMediaType(mime: string, ext: string): ImageMediaType | null {
  if (mime === 'image/png' || ext === 'png') return 'image/png';
  if (mime === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (mime === 'image/gif' || ext === 'gif') return 'image/gif';
  if (mime === 'image/webp' || ext === 'webp') return 'image/webp';
  return null;
}

async function fileToAttachment(file: File): Promise<Attachment | { error: string }> {
  const ext = extOf(file.name);
  const mime = file.type || '';
  const sizeBytes = file.size;

  // Image branch
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    if (sizeBytes > MAX_IMAGE_BYTES) {
      return { error: `${file.name} is ${(sizeBytes / 1_048_576).toFixed(1)} MB; images must be ≤ ${(MAX_IMAGE_BYTES / 1_048_576).toFixed(1)} MB.` };
    }
    const mediaType = pickImageMediaType(mime, ext);
    if (!mediaType) return { error: `Unsupported image format: ${mime || ext}` };
    const buf = await file.arrayBuffer();
    return {
      kind: 'image',
      name: file.name || 'image',
      mediaType,
      dataBase64: bytesToBase64(buf),
      sizeBytes,
    };
  }

  // PDF branch
  if (mime === 'application/pdf' || ext === 'pdf') {
    if (sizeBytes > MAX_PDF_BYTES) {
      return { error: `${file.name} is ${(sizeBytes / 1_048_576).toFixed(1)} MB; PDFs must be ≤ ${(MAX_PDF_BYTES / 1_048_576).toFixed(1)} MB.` };
    }
    const buf = await file.arrayBuffer();
    return { kind: 'pdf', name: file.name, dataBase64: bytesToBase64(buf), sizeBytes };
  }

  // Plain-text branch (md, code, csv, json, …)
  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/')) {
    if (sizeBytes > MAX_TEXT_BYTES) {
      return { error: `${file.name} is ${(sizeBytes / 1024).toFixed(0)} KB; text files inlined into the prompt must be ≤ ${(MAX_TEXT_BYTES / 1024).toFixed(0)} KB.` };
    }
    const text = await file.text();
    return { kind: 'text', name: file.name, text, sizeBytes };
  }

  return {
    error:
      `${file.name}: unsupported type. Images (PNG/JPEG/GIF/WebP), PDFs, and plain-text files are supported. ` +
      `Office documents (Word/Excel) need to be exported as PDF first.`,
  };
}

/** Bottom composer: text input, attachments, send/cancel, pending-question banner, live cost. */
export function Composer({ sessionId, visible }: Props) {
  const chat = useApp((s) => s.chats[sessionId]);
  const sendMessage = useApp((s) => s.sendMessage);
  const cancelTurn = useApp((s) => s.cancelTurn);
  const markIdle = useApp((s) => s.markIdle);
  const hasApiKey = useApp((s) => s.hasApiKey);

  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const streaming = chat?.streaming ?? false;
  const pending = chat?.pendingQuestion ?? null;
  const error = chat?.errorMessage ?? null;
  const liveCost = chat?.liveTurnCostMicros ?? 0;
  const interruptTurn = useApp((s) => s.interruptTurn);
  const queuedCount = chat?.pendingInterrupts.length ?? 0;
  const awaiting = chat?.awaitingResponse ?? null;
  // Tick once per second while we're waiting on the API so the elapsed
  // counter in the status bar updates live. Cheap re-render — only one
  // small text node depends on this state.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!awaiting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [awaiting]);
  // Pull the matching session row so we can detect sleeping-budget state and
  // show the force-resume affordance only when it's actionable.
  const sessionRow = useApp((s) => s.sessions.find((r) => r.id === sessionId));
  const sleeping = sessionRow?.state === 'sleeping-budget';
  const sleepingSince = sessionRow?.sleeping_since ?? null;

  // ---- Slash-command autocomplete --------------------------------------
  //
  // When the user types `/` at the start of the message, we pop a menu
  // listing skills from `~/.guycode/skills` + the imported Claude env.
  // Behavior is meant to feel like the Claude Desktop slash menu:
  //   • Filters live as the user types more letters.
  //   • ↑ / ↓ navigate, Enter / Tab pick, Esc dismisses.
  //   • Disappears the moment the cursor leaves the slash word.
  //
  // The skills list is loaded once per cwd (cheap filesystem scan on
  // the main side) and cached in component state. We do NOT re-fetch
  // on every keystroke — only on cwd change.
  const cwd = sessionRow?.cwd ?? null;
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    window.api.skills
      .list(cwd)
      .then((r) => {
        if (!cancelled) setSkills(r.skills);
      })
      .catch(() => {
        // Skill loading is non-critical. If it fails the menu just
        // stays empty; the user can still type normally.
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Cursor position drives slash detection. We track it via a separate
  // state because React doesn't expose the textarea's selectionStart
  // through a controlled-input pattern — we sample it on every change
  // and selection event.
  const [caret, setCaret] = useState(0);
  const slashCtx = useMemo(() => detectSlashContext(text, caret), [text, caret]);
  const filteredSkills = useMemo(
    () => (slashCtx ? filterSkills(skills, slashCtx.query) : []),
    [slashCtx, skills]
  );
  const menuOpen = slashCtx !== null && skills.length > 0;
  const [menuIndex, setMenuIndex] = useState(0);
  // Reset highlight to the top whenever the filtered list changes —
  // otherwise the highlight could point past the end after a filter
  // that shrinks the list.
  useEffect(() => {
    setMenuIndex(0);
  }, [filteredSkills.length, slashCtx?.query]);

  /** Pick a skill: splice it into the text and refocus the textarea. */
  const pickSkill = (idx: number) => {
    if (!slashCtx) return;
    const skill = filteredSkills[idx];
    if (!skill) return;
    const { newText, newCursor } = applySkillPick(text, slashCtx, skill.name);
    setText(newText);
    // Defer the selection update one tick so React has flushed the
    // new value into the textarea — otherwise setSelectionRange races
    // with the controlled-update and lands at the wrong offset.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(newCursor, newCursor);
      setCaret(newCursor);
    });
  };

  // Auto-grow textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(220, ta.scrollHeight) + 'px';
  }, [text]);

  // Auto-focus the textarea when this pane becomes visible. Matches
  // every other chat app (Slack, Discord, Cursor's chat panel) — open
  // a session and you should be able to start typing immediately
  // without an extra click. Especially important right after
  // `createSession` flips active to the new id; the user clicked "New
  // Session" because they want to type something *now*.
  //
  // Defers one frame so the `hidden` attribute has actually been
  // removed (a hidden textarea can't take focus reliably across
  // browsers).
  useEffect(() => {
    if (!visible) return;
    // Skip focus stealing if the user is currently typing somewhere
    // else (e.g. a settings modal opened on top of us). Checking
    // activeElement is a body or HTML element means nothing else
    // currently owns focus, so taking it is safe.
    const id = requestAnimationFrame(() => {
      const ae = document.activeElement as HTMLElement | null;
      // Block focus theft only when something that genuinely accepts
      // typed input owns focus — input/textarea/contentEditable in a
      // settings modal or similar. Buttons (incl. the "New session"
      // button the user just clicked) and links don't accept text, so
      // grabbing focus from them is exactly what the user expects.
      const tag = ae?.tagName;
      const isTextHost =
        ae != null &&
        (tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          ae.isContentEditable === true) &&
        ae !== taRef.current;
      if (!isTextHost) {
        taRef.current?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [visible, sessionId]);

  const totalBytes = attachments.reduce((sum, a) => sum + a.sizeBytes, 0);

  const addFiles = async (files: FileList | File[]) => {
    setAttachError(null);
    const arr = Array.from(files);
    const accepted: Attachment[] = [];
    let runningTotal = totalBytes;
    for (const f of arr) {
      const r = await fileToAttachment(f);
      if ('error' in r) {
        setAttachError(r.error);
        continue;
      }
      runningTotal += r.sizeBytes;
      if (runningTotal > MAX_TOTAL_BYTES) {
        setAttachError(
          `Total attachment size would exceed ${(MAX_TOTAL_BYTES / 1_048_576).toFixed(0)} MB. Skipped ${r.name}.`
        );
        continue;
      }
      accepted.push(r);
    }
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted]);
    }
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
    setAttachError(null);
  };

  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // Only intercept when the clipboard contains files. Plain-text paste
    // passes through unchanged, so ⌘/Ctrl+V on copied text still works.
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    await addFiles(files);
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    await addFiles(files);
  };

  const submit = async () => {
    const t = text.trim();
    // During streaming we queue the text as an interrupt — the agent picks
    // it up between tool rounds and inlines it into the conversation.
    // Attachments are NOT supported on interrupts (the queue is text-only),
    // so if the user has attachments queued during a turn, we fall through
    // to normal behavior which would error; suppress the submit instead and
    // let the user know via a temporary error.
    if (streaming) {
      if (!t) return;
      if (attachments.length > 0) {
        setAttachError(
          'Attachments can only be sent at the start of a new turn. Send the text now and re-attach when the turn finishes.'
        );
        return;
      }
      setText('');
      await interruptTurn(sessionId, t);
      return;
    }
    if (!t && attachments.length === 0) return;
    setText('');
    const sending = attachments;
    setAttachments([]);
    setAttachError(null);
    await sendMessage(sessionId, t, sending);
  };

  // Esc-to-dismiss state for the slash menu. We don't unmount the menu
  // by clearing the slash context (that would require mutating the
  // textarea); instead we just hide it until the user types again.
  // Reset whenever the slash query changes — typing more letters means
  // the user is still actively engaging with the menu.
  const [menuDismissed, setMenuDismissed] = useState(false);
  useEffect(() => {
    setMenuDismissed(false);
  }, [slashCtx?.query]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ---- Slash-command menu navigation ---------------------------------
    // When the menu is open, we steal a small set of keys for navigation.
    // Everything else (typing letters, backspace) passes through so the
    // textarea updates normally and our useMemo re-filters the list.
    if (menuOpen && !menuDismissed) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuIndex((i) => Math.min(i + 1, Math.max(0, filteredSkills.length - 1)));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (filteredSkills.length > 0) {
          e.preventDefault();
          pickSkill(menuIndex);
          return;
        }
        // Empty list: fall through to the normal Enter (submit) behavior
        // so the user isn't trapped with a useless menu.
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  /**
   * Track caret position. We sample on every event that can move the
   * caret because React's controlled-textarea pattern doesn't expose
   * `selectionStart` as a tracked value. Sampling on `onChange`,
   * `onKeyUp`, `onClick`, and `onSelect` covers typing, arrow-key
   * movement, mouse clicks, and programmatic selection changes.
   */
  const syncCaret = () => {
    const ta = taRef.current;
    if (ta) setCaret(ta.selectionStart ?? 0);
  };

  return (
    <div
      className={clsx(
        'border-t border-border bg-bg-panel relative',
        dragOver && 'ring-2 ring-accent ring-inset'
      )}
      onDragOver={(e) => {
        // Highlight the drop zone only when files are being dragged. Without
        // the type check we'd flicker the ring on every cursor enter from
        // text-only drag operations (e.g. drag-selecting in the textarea).
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {error && (
        <div className="px-4 py-2 bg-state-error/10 border-b border-state-error/30 text-[12px] text-state-error flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="flex-1">{error}</span>
          {sleeping && (
            <button
              onClick={() => window.api.budget.forceResume(sessionId)}
              className="shrink-0 inline-flex items-center gap-1 rounded-md border border-state-error/50 px-2 py-1 text-[11px] font-medium hover:bg-state-error/15"
              title={
                sleepingSince
                  ? `Sleeping since ${new Date(sleepingSince).toLocaleTimeString()}. Force-resume bypasses the budget for one turn.`
                  : 'Force-resume bypasses the budget for one turn.'
              }
            >
              <Zap size={12} />
              Force resume
            </button>
          )}
        </div>
      )}
      {hasApiKey === false && (
        <div className="px-4 py-2 bg-state-error/10 border-b border-state-error/30 text-[12px] text-state-error">
          No API key configured. Set <code className="font-mono">ANTHROPIC_API_KEY</code> or drop
          one at <code className="font-mono">~/.guycode/api-key</code>, then restart.
        </div>
      )}
      {attachError && (
        <div className="px-4 py-1.5 bg-state-attention/10 border-b border-state-attention/30 text-[11px] text-state-attention flex items-center gap-2">
          <AlertTriangle size={12} className="shrink-0" />
          <span className="flex-1">{attachError}</span>
          <button
            onClick={() => setAttachError(null)}
            className="shrink-0 rounded p-0.5 hover:bg-state-attention/15"
            aria-label="Dismiss attachment error"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="px-3 pt-2 pb-1 flex items-center gap-3 text-[10px] text-text-dim font-mono">
        {pending ? (
          <span className="text-state-attention inline-flex items-center gap-1">
            ⚠ needs you
            <button
              onClick={() => markIdle(sessionId)}
              title="Dismiss — mark session idle"
              aria-label="Dismiss and mark session idle"
              className="ml-0.5 rounded p-0.5 text-state-attention/70 hover:text-state-attention hover:bg-state-attention/10"
            >
              <X size={10} />
            </button>
          </span>
        ) : awaiting ? (
          <span
            className="text-state-running"
            title={`Waiting on Anthropic to respond. Sent ${awaiting.messageCount} messages, ~${formatTokens(awaiting.estimatedInputTokens)} tokens. Big contexts have multi-second time-to-first-token; this counter increments every second so you can tell it's not hung.`}
          >
            ● thinking… {Math.max(0, Math.round((now - awaiting.startedAt) / 1000))}s
            {awaiting.estimatedInputTokens > 0 && (
              <span className="ml-1 text-text-dim">
                · ~{formatTokens(awaiting.estimatedInputTokens)} in
              </span>
            )}
          </span>
        ) : streaming ? (
          <span className="text-state-running">● streaming</span>
        ) : (
          <span>idle</span>
        )}
        {liveCost > 0 && (
          <span className="text-text-muted">
            this turn: {formatUsdMicros(liveCost, { precise: true })}
          </span>
        )}
        {queuedCount > 0 && (
          <span
            className="text-state-attention"
            title="Messages you typed during the turn. The agent picks them up between tool rounds."
          >
            queued: {queuedCount}
          </span>
        )}
        <div className="flex-1" />
        <span>
          {streaming
            ? 'Enter = queue for agent · Shift+Enter = newline'
            : 'Enter = send · Shift+Enter = newline · paste / drop / 📎 to attach'}
        </span>
      </div>

      {attachments.length > 0 && (
        <div className="px-3 pb-1 flex flex-wrap gap-1.5">
          {attachments.map((a, i) => (
            <AttachmentPill
              key={`${a.name}-${i}`}
              attachment={a}
              onRemove={() => removeAttachment(i)}
            />
          ))}
        </div>
      )}

      <div className="px-3 pb-3 flex items-end gap-2 relative">
        {menuOpen && !menuDismissed && (
          <SlashCommandMenu
            items={filteredSkills}
            activeIndex={menuIndex}
            query={slashCtx?.query ?? ''}
            onPick={pickSkill}
            onHover={setMenuIndex}
          />
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.json,.csv,.log,.yaml,.yml,.toml,.txt,.py,.js,.ts,.tsx,.jsx,.go,.rs,.java,.c,.cpp,.h,.sh,.html,.css,.sql"
          className="hidden"
          onChange={async (e) => {
            const files = e.target.files;
            if (files) await addFiles(files);
            // Reset input so the user can pick the same file again later.
            if (fileInputRef.current) fileInputRef.current.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="shrink-0 inline-flex items-center justify-center rounded-md bg-bg-elevated hover:bg-bg-hover border border-border h-9 w-9 text-text-muted hover:text-text"
          title="Attach images, PDFs, or text files (or paste / drop into the box)"
          aria-label="Attach files"
        >
          <Paperclip size={14} />
        </button>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // Sample selectionStart from the same event so the slash
            // detector sees the post-update caret position on this
            // tick. Without this we'd be one keystroke behind.
            setCaret(e.target.selectionStart ?? 0);
          }}
          onKeyDown={onKey}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onPaste={onPaste}
          rows={1}
          placeholder={
            pending
              ? 'Reply…'
              : streaming
                ? 'Type to queue for the agent (picked up between tool rounds)…'
                : attachments.length > 0
                  ? 'Add a message (optional)…'
                  : 'Message Guy Code…'
          }
          className={clsx(
            'flex-1 resize-none rounded-md bg-bg border border-border focus:border-accent',
            'px-3 py-2 text-[13px] text-text placeholder:text-text-dim',
            'outline-none transition-colors',
            'min-h-[36px] max-h-[220px]'
          )}
        />
        {/* Stop button is always available during streaming, alongside the
            queue/send button — so the user can either feed the agent more
            context or hard-stop it without hunting through menus. */}
        {streaming && (
          <button
            onClick={() => cancelTurn(sessionId)}
            className="shrink-0 inline-flex items-center gap-1 rounded-md bg-bg-elevated hover:bg-bg-hover border border-border px-3 py-2 text-[12px] text-text"
            title="Cancel turn"
            aria-label="Cancel turn"
          >
            <Square size={14} />
            Stop
          </button>
        )}
        <button
          onClick={submit}
          disabled={!text.trim() && (streaming || attachments.length === 0)}
          className={clsx(
            'shrink-0 inline-flex items-center gap-1 rounded-md px-3 py-2 text-[12px]',
            (text.trim() || (!streaming && attachments.length > 0))
              ? streaming
                ? 'bg-state-attention/80 text-white hover:bg-state-attention'
                : 'bg-accent text-white hover:bg-accent-dim'
              : 'bg-bg-elevated text-text-dim cursor-not-allowed'
          )}
          title={
            streaming
              ? 'Queue this text — the agent will pick it up between tool rounds'
              : 'Send'
          }
        >
          <Send size={14} />
          {streaming ? 'Queue' : 'Send'}
        </button>
      </div>
    </div>
  );
}

/** Inline pill above the textarea showing one attached file. Click X to remove. */
function AttachmentPill({
  attachment: a,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const sizeLabel =
    a.sizeBytes >= 1_048_576
      ? `${(a.sizeBytes / 1_048_576).toFixed(1)} MB`
      : `${(a.sizeBytes / 1024).toFixed(0)} KB`;

  if (a.kind === 'image') {
    return (
      <div className="relative inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-elevated p-1 pr-7 text-[11px] text-text-muted">
        <img
          src={`data:${a.mediaType};base64,${a.dataBase64}`}
          alt={a.name}
          className="h-10 w-10 rounded object-cover"
        />
        <div className="flex flex-col gap-0 min-w-0 max-w-[140px]">
          <span className="truncate text-text">{a.name}</span>
          <span className="text-text-dim font-mono text-[10px]">{sizeLabel}</span>
        </div>
        <button
          onClick={onRemove}
          className="absolute top-0.5 right-0.5 rounded p-0.5 text-text-dim hover:text-text hover:bg-bg-hover"
          aria-label={`Remove ${a.name}`}
          title="Remove attachment"
        >
          <X size={11} />
        </button>
      </div>
    );
  }
  return (
    <div className="relative inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-elevated px-2 py-1.5 pr-7 text-[11px] text-text-muted">
      <FileText size={14} className={a.kind === 'pdf' ? 'text-state-attention' : 'text-text-dim'} />
      <div className="flex flex-col gap-0 min-w-0 max-w-[180px]">
        <span className="truncate text-text">{a.name}</span>
        <span className="text-text-dim font-mono text-[10px]">
          {a.kind === 'pdf' ? 'PDF' : 'text'} · {sizeLabel}
        </span>
      </div>
      <button
        onClick={onRemove}
        className="absolute top-1 right-1 rounded p-0.5 text-text-dim hover:text-text hover:bg-bg-hover"
        aria-label={`Remove ${a.name}`}
        title="Remove attachment"
      >
        <X size={11} />
      </button>
    </div>
  );
}
