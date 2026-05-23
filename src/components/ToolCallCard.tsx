import { useState } from 'react';
import clsx from 'clsx';
import { ChevronRight, ChevronDown, Wrench, AlertCircle, Check, Loader2 } from 'lucide-react';
import type { ContentBlock } from '@/types';
import { truncate } from '@/lib/format';
import { ToolResultBody } from './ToolResultBody';

interface Props {
  toolUse: Extract<ContentBlock, { type: 'tool_use' }>;
  result?: Extract<ContentBlock, { type: 'tool_result' }>;
  /** True while streaming partial JSON for tool input. */
  streaming?: boolean;
}

function formatInputPreview(input: unknown, partial?: string): string {
  if (partial && (!input || Object.keys(input as object).length === 0)) return partial;
  if (!input || typeof input !== 'object') return JSON.stringify(input ?? null);
  const obj = input as Record<string, unknown>;
  // Pick the most identifying field
  const head =
    obj.file_path ??
    obj.path ??
    obj.command ??
    obj.pattern ??
    obj.question ??
    obj.url ??
    null;
  if (typeof head === 'string') return head;
  return JSON.stringify(obj);
}

export function ToolCallCard({ toolUse, result, streaming }: Props) {
  const [open, setOpen] = useState(false);
  const isError = result?.is_error;
  const running = !result && !streaming;
  const stillStreamingInput = streaming && !result;
  const preview = formatInputPreview(toolUse.input, toolUse.partialInput);

  return (
    <div
      className={clsx(
        'my-1 rounded border text-[12px] font-mono transition-colors',
        isError
          ? 'border-state-error/40 bg-state-error/5'
          : result
            ? 'border-border bg-bg-elevated'
            : 'border-state-running/40 bg-state-running/5'
      )}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-bg-hover/50 rounded text-left"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} className="text-text-dim shrink-0" />
        <span className="font-semibold text-text shrink-0">{toolUse.name}</span>
        <span className="text-text-dim truncate flex-1">{truncate(preview, 80)}</span>
        {stillStreamingInput && (
          <Loader2 size={12} className="text-state-running animate-spin shrink-0" />
        )}
        {running && !stillStreamingInput && (
          <Loader2 size={12} className="text-state-running animate-spin shrink-0" />
        )}
        {result &&
          (isError ? (
            <AlertCircle size={12} className="text-state-error shrink-0" />
          ) : (
            <Check size={12} className="text-state-running shrink-0" />
          ))}
        {result?.ms !== undefined && (
          <span className="text-text-dim shrink-0 text-[10px]">{result.ms}ms</span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-2 space-y-2">
          {result ? (
            <ToolResultBody toolUse={toolUse} result={result} />
          ) : (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-dim mb-0.5">
                input
              </div>
              <pre className="text-[11px] whitespace-pre-wrap break-all text-text-muted">
                {JSON.stringify(toolUse.input ?? {}, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
