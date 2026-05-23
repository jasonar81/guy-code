// Tool-result renderers, dispatched on tool name. Each one takes the raw
// tool_use input + tool_result content and returns a tailored React tree.
//
// Goal: make Read / Edit / Write / Bash output legible at a glance, so the
// user doesn't have to read raw text dumps to understand what happened.

import clsx from 'clsx';
import { useMemo } from 'react';
import type { ContentBlock } from '@/types';

interface Props {
  toolUse: Extract<ContentBlock, { type: 'tool_use' }>;
  result: Extract<ContentBlock, { type: 'tool_result' }>;
}

/** Strip ANSI color codes so terminal output is legible in plain HTML. */
function stripAnsi(s: string): string {
  // Standard CSI sequences: ESC[...m, ESC[...K, etc.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

export function ToolResultBody({ toolUse, result }: Props) {
  const name = toolUse.name;
  const input = (toolUse.input ?? {}) as Record<string, unknown>;
  const content = result.content;
  const isError = !!result.is_error;

  if (name === 'Edit') return <EditBody input={input} content={content} isError={isError} />;
  if (name === 'Write') return <WriteBody input={input} content={content} isError={isError} />;
  if (name === 'Read') return <ReadBody input={input} content={content} isError={isError} />;
  if (name === 'Bash' || name === 'PowerShell')
    return <ShellBody input={input} content={content} isError={isError} />;
  if (name === 'Grep') return <GrepBody input={input} content={content} isError={isError} />;
  if (name === 'Glob') return <GlobBody content={content} isError={isError} />;
  if (name === 'TodoWrite') return <TodoBody input={input} />;
  if (name === 'list_skills') return <SkillsBody content={content} />;
  if (name === 'recall_memory') return <MemoryRecallBody content={content} />;
  if (name.startsWith('WaitFor')) return <WaitBody name={name} content={content} />;

  // Default
  return (
    <pre className="text-[11px] whitespace-pre-wrap break-all text-text font-mono">
      {content}
    </pre>
  );
}

// ---- Edit: side-by-side old/new, line-aligned --------------------------

function EditBody({
  input,
  content,
  isError,
}: {
  input: Record<string, unknown>;
  content: string;
  isError: boolean;
}) {
  const oldStr = String(input.old_string ?? '');
  const newStr = String(input.new_string ?? '');
  const filePath = String(input.file_path ?? '');
  const replaceAll = !!input.replace_all;

  return (
    <div className="space-y-1.5">
      <FileHeader path={filePath} subtitle={replaceAll ? 'replace_all' : undefined} />
      {isError ? (
        <ResultBanner content={content} isError />
      ) : (
        <DiffBlock oldStr={oldStr} newStr={newStr} />
      )}
    </div>
  );
}

function DiffBlock({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  return (
    <div className="rounded border border-border bg-bg overflow-hidden text-[11px] font-mono">
      {oldLines.map((l, i) => (
        <div
          key={`o${i}`}
          className="flex items-start gap-2 px-2 py-0.5 bg-state-error/8"
        >
          <span className="select-none text-state-error/70 w-3 shrink-0 text-center">
            -
          </span>
          <span className="text-state-error whitespace-pre-wrap break-all">{l || ' '}</span>
        </div>
      ))}
      {newLines.map((l, i) => (
        <div
          key={`n${i}`}
          className="flex items-start gap-2 px-2 py-0.5 bg-state-running/8"
        >
          <span className="select-none text-state-running/70 w-3 shrink-0 text-center">
            +
          </span>
          <span className="text-state-running whitespace-pre-wrap break-all">{l || ' '}</span>
        </div>
      ))}
    </div>
  );
}

// ---- Write: full content in a fenced block -----------------------------

function WriteBody({
  input,
  content,
  isError,
}: {
  input: Record<string, unknown>;
  content: string;
  isError: boolean;
}) {
  const filePath = String(input.file_path ?? '');
  const body = String(input.content ?? '');
  return (
    <div className="space-y-1.5">
      <FileHeader path={filePath} subtitle={`${body.length} chars`} />
      {isError ? (
        <ResultBanner content={content} isError />
      ) : (
        <CodeBlock text={body} />
      )}
    </div>
  );
}

// ---- Read: numbered code block -----------------------------------------

function ReadBody({
  input,
  content,
  isError,
}: {
  input: Record<string, unknown>;
  content: string;
  isError: boolean;
}) {
  const filePath = String(input.file_path ?? '');
  return (
    <div className="space-y-1.5">
      <FileHeader path={filePath} />
      {isError ? (
        <ResultBanner content={content} isError />
      ) : (
        <pre className="rounded border border-border bg-bg p-2 text-[11px] font-mono whitespace-pre overflow-x-auto text-text-muted">
          {content}
        </pre>
      )}
    </div>
  );
}

// ---- Shell: terminal-styled --------------------------------------------

function ShellBody({
  input,
  content,
  isError,
}: {
  input: Record<string, unknown>;
  content: string;
  isError: boolean;
}) {
  const cmd = String(input.command ?? '');
  const cwd = input.cwd ? String(input.cwd) : null;
  const cleaned = useMemo(() => stripAnsi(content), [content]);
  // First line is usually `[exit N]` or `[timed out ...]`.
  const m = /^\[([^\]]+)\]\n?/.exec(cleaned);
  const status = m ? m[1] : null;
  const body = m ? cleaned.slice(m[0].length) : cleaned;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] font-mono">
        <span className="text-text-dim">$</span>
        <span className={clsx('text-text', isError && 'text-state-error')}>
          {cmd}
        </span>
        {cwd && (
          <span className="text-text-dim ml-auto" title="Override cwd">
            in {cwd}
          </span>
        )}
      </div>
      <div className="rounded border border-border bg-[#0b0b0d] text-[11px] font-mono overflow-hidden">
        {status && (
          <div
            className={clsx(
              'px-2 py-0.5 text-[10px] uppercase tracking-wider border-b',
              isError
                ? 'bg-state-error/15 text-state-error border-state-error/30'
                : 'bg-state-running/15 text-state-running border-state-running/30'
            )}
          >
            {status}
          </div>
        )}
        <pre className="px-2 py-1.5 text-[#d4d4d4] whitespace-pre-wrap break-all">
          {body || '(no output)'}
        </pre>
      </div>
    </div>
  );
}

// ---- Grep: matching lines ----------------------------------------------

function GrepBody({
  input,
  content,
  isError,
}: {
  input: Record<string, unknown>;
  content: string;
  isError: boolean;
}) {
  const pattern = String(input.pattern ?? '');
  const path = input.path ? String(input.path) : null;
  if (isError) {
    return (
      <div className="space-y-1.5">
        <div className="text-[11px] font-mono text-text-dim">
          grep <code className="text-text">{pattern}</code>
          {path && <span className="ml-1">in {path}</span>}
        </div>
        <ResultBanner content={content} isError />
      </div>
    );
  }
  const lines = content.split('\n');
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-mono text-text-dim">
        grep <code className="text-text">{pattern}</code>
        {path && <span className="ml-1">in {path}</span>}
        <span className="ml-2">— {lines.filter(Boolean).length} matches</span>
      </div>
      <pre className="rounded border border-border bg-bg p-2 text-[11px] font-mono whitespace-pre overflow-x-auto text-text-muted">
        {content}
      </pre>
    </div>
  );
}

// ---- Glob: file list ---------------------------------------------------

function GlobBody({ content, isError }: { content: string; isError: boolean }) {
  if (isError) return <ResultBanner content={content} isError />;
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length === 0)
    return <div className="text-[11px] font-mono text-text-dim italic">no matches</div>;
  return (
    <ul className="text-[11px] font-mono text-text-muted space-y-0.5">
      {lines.slice(0, 200).map((l, i) => (
        <li key={i} className="truncate" title={l}>
          {l}
        </li>
      ))}
      {lines.length > 200 && (
        <li className="text-text-dim italic">
          (+{lines.length - 200} more not shown)
        </li>
      )}
    </ul>
  );
}

// ---- TodoWrite: render the list ---------------------------------------

function TodoBody({ input }: { input: Record<string, unknown> }) {
  const todos = (input.todos ?? []) as { id: string; content: string; status: string }[];
  if (!Array.isArray(todos)) return null;
  return (
    <ul className="text-[12px] space-y-0.5">
      {todos.map((t) => (
        <li key={t.id} className="flex items-center gap-1.5">
          <span
            className={clsx(
              'inline-block w-3 text-center text-[10px]',
              t.status === 'completed'
                ? 'text-state-running'
                : t.status === 'in_progress'
                  ? 'text-state-attention'
                  : 'text-text-dim'
            )}
          >
            {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}
          </span>
          <span
            className={clsx(
              t.status === 'completed' && 'text-text-dim line-through',
              t.status === 'in_progress' && 'text-text font-medium'
            )}
          >
            {t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---- list_skills / recall_memory --------------------------------------

function SkillsBody({ content }: { content: string }) {
  return (
    <pre className="text-[11px] font-mono whitespace-pre-wrap text-text-muted">
      {content}
    </pre>
  );
}

function MemoryRecallBody({ content }: { content: string }) {
  return (
    <pre className="text-[11px] font-mono whitespace-pre-wrap text-text-muted border-l-2 border-accent/40 pl-2">
      {content}
    </pre>
  );
}

// ---- WaitFor* ---------------------------------------------------------

function WaitBody({ name, content }: { name: string; content: string }) {
  const waiting = !content;
  return (
    <div className="text-[11px] font-mono text-text-muted">
      <span className="text-text-dim">{name}: </span>
      {waiting ? <span className="italic text-text-dim">waiting…</span> : content}
    </div>
  );
}

// ---- Shared bits -------------------------------------------------------

function FileHeader({ path, subtitle }: { path: string; subtitle?: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px] font-mono">
      <span className="text-text" title={path}>
        {path}
      </span>
      {subtitle && <span className="text-text-dim">— {subtitle}</span>}
    </div>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="rounded border border-border bg-bg p-2 text-[11px] font-mono whitespace-pre overflow-x-auto text-text-muted">
      {text}
    </pre>
  );
}

function ResultBanner({ content, isError }: { content: string; isError: boolean }) {
  return (
    <pre
      className={clsx(
        'rounded border p-2 text-[11px] font-mono whitespace-pre-wrap break-all',
        isError
          ? 'border-state-error/40 bg-state-error/5 text-state-error'
          : 'border-border bg-bg-elevated text-text'
      )}
    >
      {content}
    </pre>
  );
}
