// Renders a subagent's live activity inline in the conversation: its
// narration + the tools it calls, visually attributed to the subagent so it's
// clearly distinct from the main agent. Streams in as the child works (built
// from subagent_* events in the store), instead of the user seeing a frozen
// window until the child returns.
import { useState } from 'react';
import { ChevronDown, ChevronRight, Bot } from 'lucide-react';
import { RichText } from './RichText';
import type { ContentBlock } from '../types';

type SubagentBlock = Extract<ContentBlock, { type: 'subagent' }>;

const ROLE_LABEL: Record<string, string> = {
  plan: 'Plan',
  execute: 'Execute',
  review: 'Review',
  general: 'Task',
};

function summarizeInput(input: unknown): string {
  if (input == null) return '';
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  } catch {
    return '';
  }
}

export function SubagentActivity({ block }: { block: SubagentBlock }) {
  const [collapsed, setCollapsed] = useState(false);
  const label = ROLE_LABEL[block.role] ?? block.role;

  return (
    <div className="my-2 rounded-md border border-border bg-bg-elevated/40 overflow-hidden">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-text-dim hover:text-text border-l-2 border-accent/60"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <Bot size={12} className="text-accent" />
        <span className="font-medium text-text">{label} subagent</span>
        <span className="truncate text-text-muted">— {block.description}</span>
        <span className="ml-auto shrink-0">
          {block.done ? (
            <span className="text-state-success">done</span>
          ) : (
            <span className="text-accent animate-pulse">working…</span>
          )}
        </span>
      </button>
      {!collapsed && (
        <div className="px-3 py-1.5 pl-4 border-l-2 border-accent/30 ml-1 space-y-1.5">
          {block.items.length === 0 && (
            <div className="text-[11px] text-text-muted italic">starting…</div>
          )}
          {block.items.map((it, idx) => {
            if (it.kind === 'text') {
              return (
                <div key={idx} className="text-[13px] text-text-dim">
                  <RichText text={it.text} />
                </div>
              );
            }
            if (it.kind === 'tool') {
              return (
                <div key={idx} className="text-[11px] font-mono text-text-muted">
                  <span className="text-accent">{it.name}</span>
                  <span className="text-text-muted/70"> {summarizeInput(it.input)}</span>
                </div>
              );
            }
            // tool_result
            return (
              <div
                key={idx}
                className={
                  'text-[11px] font-mono pl-3 truncate ' +
                  (it.isError ? 'text-state-error' : 'text-text-muted/60')
                }
                title={it.content}
              >
                {it.isError ? '✗ ' : '→ '}
                {it.content.split('\n')[0].slice(0, 140)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
