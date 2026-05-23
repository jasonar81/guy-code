import { useEffect, useMemo, useState } from 'react';
import { X, AlertTriangle, CheckCircle2, Clock, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import type { AuditEventRow } from '@/types';
import { absoluteTime, relativeTime } from '@/lib/format';

interface Props {
  open: boolean;
  sessionId: string | null;
  onClose: () => void;
}

export function AuditPanel({ open, sessionId, onClose }: Props) {
  const [rows, setRows] = useState<AuditEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<'session' | 'global'>('session');
  const [tick, setTick] = useState(0);

  const targetSession = scope === 'session' ? sessionId : undefined;

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    let cancelled = false;
    (async () => {
      const res = await window.api.audit.list({
        sessionId: targetSession ?? undefined,
        limit: 200,
      });
      if (!cancelled) {
        setRows(res);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, targetSession, tick]);

  const summary = useMemo(() => {
    const total = rows.length;
    const errors = rows.filter((r) => r.status === 'error').length;
    const totalMs = rows.reduce((s, r) => s + (r.duration_ms ?? 0), 0);
    return { total, errors, totalMs };
  }, [rows]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-stretch justify-end bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[90vw] h-full flex flex-col border-l border-border bg-bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-border flex items-center gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text">Audit log</h2>
            <p className="text-[11px] text-text-dim">
              Every tool call. {summary.total} entries · {summary.errors} errors ·{' '}
              {(summary.totalMs / 1000).toFixed(1)}s total
            </p>
          </div>
          <div className="ml-auto inline-flex items-center rounded-md border border-border overflow-hidden text-[11px]">
            <button
              onClick={() => setScope('session')}
              disabled={!sessionId}
              className={clsx(
                'px-2 py-1 transition-colors',
                scope === 'session'
                  ? 'bg-bg-hover text-text'
                  : 'text-text-dim hover:text-text hover:bg-bg-elevated',
                !sessionId && 'opacity-40 cursor-not-allowed'
              )}
            >
              Session
            </button>
            <button
              onClick={() => setScope('global')}
              className={clsx(
                'px-2 py-1 transition-colors',
                scope === 'global'
                  ? 'bg-bg-hover text-text'
                  : 'text-text-dim hover:text-text hover:bg-bg-elevated'
              )}
            >
              All
            </button>
          </div>
          <button
            onClick={() => setTick((t) => t + 1)}
            className="p-1.5 rounded text-text-dim hover:text-text hover:bg-bg-hover"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-text-dim hover:text-text hover:bg-bg-hover"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loading && rows.length === 0 ? (
            <div className="p-6 text-center text-[12px] text-text-dim">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-[12px] text-text-dim italic">
              No tool calls yet for this {scope}.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <AuditRow key={r.id} row={r} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function AuditRow({ row }: { row: AuditEventRow }) {
  const [expanded, setExpanded] = useState(false);
  const isError = row.status === 'error';
  const Icon = isError ? AlertTriangle : row.status === 'wait' ? Clock : CheckCircle2;
  const iconColor = isError
    ? 'text-state-error'
    : row.status === 'wait'
      ? 'text-state-waiting'
      : 'text-state-running';

  return (
    <li className="px-4 py-2 hover:bg-bg-hover/40">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full text-left flex items-start gap-2"
      >
        <Icon size={14} className={clsx('mt-0.5 shrink-0', iconColor)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 text-[12px]">
            <span className="font-mono font-medium text-text">{row.tool}</span>
            <span className="text-text-dim text-[11px]">
              {row.duration_ms != null ? `${row.duration_ms}ms` : ''}
            </span>
            <span
              className="ml-auto text-[11px] text-text-dim font-mono"
              title={absoluteTime(row.ts)}
            >
              {relativeTime(row.ts)}
            </span>
          </div>
          {row.input_json && (
            <div
              className={clsx(
                'mt-1 text-[11px] font-mono text-text-muted',
                expanded ? 'whitespace-pre-wrap break-words' : 'truncate'
              )}
            >
              {row.input_json}
            </div>
          )}
          {expanded && row.output_ref && (
            <div className="mt-1 text-[11px] font-mono text-text-dim whitespace-pre-wrap break-words border-l border-border pl-2">
              {row.output_ref}
            </div>
          )}
        </div>
      </button>
    </li>
  );
}
