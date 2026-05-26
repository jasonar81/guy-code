import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useApp, type SidebarFilter } from '@/lib/store';
import { Section } from './Section';
import { SessionListRow } from './ProjectRow';
import { ThemeToggle } from './ThemeToggle';
import { SettingsModal } from './SettingsModal';
import { AuditPanel } from './AuditPanel';
import {
  formatUsdMicros,
  dateGroupLabel,
  sessionLastTs,
} from '@/lib/format';
import { Loader2, RefreshCw, Plus, Settings, ScrollText, ChevronDown, Check, Star } from 'lucide-react';
import type { SessionRow, ProjectState, BudgetStatus, ApiKey } from '@/types';

const FILTERS: { v: SidebarFilter; label: string; title: string }[] = [
  { v: 'active', label: 'Active', title: 'Hide archived (default)' },
  { v: 'all', label: 'All', title: 'Show every session' },
  { v: 'archived', label: 'Archived', title: 'Show only archived sessions' },
];

const NEEDS_YOU = new Set<ProjectState>(['waiting-on-user', 'error']);
const RUNNING = new Set<ProjectState>([
  'running',
  'waiting-on-system',
  'sleeping-budget',
  // sleeping-tool sessions are persistently paused waiting for their
  // wake_at_ts. They count as "active work" the user is monitoring,
  // not as idle — so they belong in the Running group alongside
  // sleeping-budget (the other "paused but resuming" state).
  'sleeping-tool',
]);
const IDLE = new Set<ProjectState>(['idle']);

/**
 * Group an array of sessions by relative date. Order of groups is preserved
 * by insertion order (most recent first since input is sorted desc).
 */
function groupByDate(rows: SessionRow[]): { label: string; rows: SessionRow[] }[] {
  const map = new Map<string, SessionRow[]>();
  for (const r of rows) {
    const lbl = dateGroupLabel(sessionLastTs(r));
    const list = map.get(lbl);
    if (list) list.push(r);
    else map.set(lbl, [r]);
  }
  return Array.from(map.entries()).map(([label, rows]) => ({ label, rows }));
}

export function Sidebar() {
  const allSessions = useApp((s) => s.sessions);
  const importProgress = useApp((s) => s.importProgress);
  const filter = useApp((s) => s.sidebarFilter);
  const setFilter = useApp((s) => s.setSidebarFilter);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const apiKeys = useApp((s) => s.apiKeys);
  const budgetKeyFilter = useApp((s) => s.budgetKeyFilter);
  const setBudgetKeyFilter = useApp((s) => s.setBudgetKeyFilter);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);

  // Poll budget every 5s, scoped to whichever key the user picked in the
  // dropdown. null = aggregated across all keys (and includes the legacy
  // un-keyed events).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await window.api.budget.status(budgetKeyFilter);
        if (!cancelled) setBudget(r);
      } catch {
        /* ignore */
      }
    };
    tick();
    // Tight enough to feel immediate after a settings save or after a turn
    // finishes spending, slow enough to stay invisible in the network panel.
    const t = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [budgetKeyFilter]);

  const sessions = useMemo(() => {
    if (filter === 'all') return allSessions;
    if (filter === 'archived') return allSessions.filter((s) => s.archived === 1);
    return allSessions.filter((s) => s.archived === 0);
  }, [allSessions, filter]);

  const groups = useMemo(() => {
    const needs: SessionRow[] = [];
    const running: SessionRow[] = [];
    const idle: SessionRow[] = [];
    for (const s of sessions) {
      if (NEEDS_YOU.has(s.state)) needs.push(s);
      else if (RUNNING.has(s.state)) running.push(s);
      else if (IDLE.has(s.state)) idle.push(s);
    }
    needs.sort((a, b) => (sessionLastTs(a) ?? 0) - (sessionLastTs(b) ?? 0));
    running.sort((a, b) => (sessionLastTs(b) ?? 0) - (sessionLastTs(a) ?? 0));
    idle.sort((a, b) => (sessionLastTs(b) ?? 0) - (sessionLastTs(a) ?? 0));
    return { needs, running, idle, idleByDate: groupByDate(idle) };
  }, [sessions]);

  const total24h = useMemo(
    () => sessions.reduce((sum, s) => sum + s.cost_24h_micros, 0),
    [sessions]
  );

  return (
    <aside className="w-[340px] shrink-0 h-full flex flex-col border-r border-border bg-bg-panel">
      <header className="px-3 py-3 border-b border-border">
        <div className="flex items-baseline justify-between">
          <h1 className="text-sm font-semibold tracking-wide text-text">Guy Code</h1>
          <div className="text-[10px] text-text-dim font-mono">
            {sessions.length} of {allSessions.length}
          </div>
        </div>
        <BudgetPill
          budget={budget}
          fallback24h={total24h}
          apiKeys={apiKeys}
          selectedKeyId={budgetKeyFilter}
          onSelectKey={setBudgetKeyFilter}
        />
        <NewSessionButton />
        <div className="mt-2 inline-flex items-center rounded-md border border-border overflow-hidden text-[11px]">
          {FILTERS.map(({ v, label, title }) => (
            <button
              key={v}
              onClick={() => setFilter(v)}
              title={title}
              aria-pressed={filter === v}
              className={clsx(
                'px-2 py-1 transition-colors',
                filter === v
                  ? 'bg-bg-hover text-text'
                  : 'text-text-dim hover:text-text hover:bg-bg-elevated'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {importProgress && importProgress.phase !== 'done' && (
        <div className="px-3 py-2 border-b border-border bg-bg-elevated text-[11px] text-text-muted flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />
          <span className="flex-1 truncate">
            {importProgress.phase === 'scan'
              ? 'Scanning ~/.claude/'
              : 'Indexing sessions'}{' '}
            {importProgress.filesProcessed}/{importProgress.filesTotal}
          </span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        <Section
          label="Needs you"
          count={groups.needs.length}
          emphasis="attention"
          defaultOpen
        >
          {groups.needs.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-text-dim italic">All clear.</div>
          ) : (
            groups.needs.map((s) => <SessionListRow key={s.id} session={s} />)
          )}
        </Section>

        <Section label="Running" count={groups.running.length} defaultOpen>
          {groups.running.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-text-dim italic">Nothing running.</div>
          ) : (
            groups.running.map((s) => <SessionListRow key={s.id} session={s} />)
          )}
        </Section>

        <Section label="Idle" count={groups.idle.length} defaultOpen>
          {groups.idle.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-text-dim italic">No idle sessions.</div>
          ) : (
            groups.idleByDate.map((g) => (
              <div key={g.label} className="select-none">
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-text-dim font-mono">
                  {g.label}
                </div>
                {g.rows.map((s) => (
                  <SessionListRow key={s.id} session={s} />
                ))}
              </div>
            ))
          )}
        </Section>
      </div>

      <footer className="px-3 py-2 border-t border-border flex items-center gap-3 text-[11px] text-text-dim">
        <button
          className="flex items-center gap-1 hover:text-text"
          onClick={() => window.api.imports.run()}
          title="Re-scan ~/.claude/"
        >
          <RefreshCw size={12} />
          Re-import
        </button>
        <button
          className="flex items-center gap-1 hover:text-text"
          onClick={() => setAuditOpen(true)}
          title="Audit log — every tool call"
        >
          <ScrollText size={12} />
          Audit
        </button>
        <div className="flex-1" />
        <button
          className="p-1 rounded hover:bg-bg-hover hover:text-text"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Open settings"
        >
          <Settings size={12} />
        </button>
        <ThemeToggle />
      </footer>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AuditPanel
        open={auditOpen}
        sessionId={activeSessionId}
        onClose={() => setAuditOpen(false)}
      />
    </aside>
  );
}

/**
 * Sidebar budget pill — two lines: "this hour: $X / $Y" (the cap the
 * governor enforces) and "today: $X / $Y" (informational, against the
 * configured daily budget). Color-coded against the hour cap because
 * that's what actually pauses sessions. When the key has no budget
 * configured, falls back to a plain "24h: $X" hint.
 */
function BudgetPill({
  budget,
  fallback24h,
  apiKeys,
  selectedKeyId,
  onSelectKey,
}: {
  budget: BudgetStatus | null;
  fallback24h: number;
  apiKeys: ApiKey[];
  selectedKeyId: string | null;
  onSelectKey: (id: string | null) => void;
}) {
  const hourCap = budget?.hourCapMicros ?? null;
  const dailyCap = budget?.dailyCapMicros ?? null;
  if (!budget || hourCap == null || hourCap <= 0) {
    // Governor disabled for the selected key. Show 24h spend for context.
    const last24h = budget?.last24hSpentMicros ?? fallback24h;
    return (
      <>
        <ApiKeyDropdown
          apiKeys={apiKeys}
          selectedKeyId={selectedKeyId}
          onSelectKey={onSelectKey}
        />
        <div
          className="mt-1.5 text-[11px] text-text-muted font-mono"
          title="Spent in Guy in the last 24h on the selected key (excludes Claude Code history). Set a daily budget for this key in Settings to enable the hourly governor."
        >
          24h: {formatUsdMicros(last24h)}
        </div>
      </>
    );
  }
  const hourSpent = budget.hourSpentMicros;
  const hourPct = hourCap > 0 ? hourSpent / hourCap : 0;
  const hourCls =
    hourPct >= 1
      ? 'text-state-error'
      : hourPct >= 0.8
        ? 'text-state-attention'
        : 'text-text-muted';
  const dayPct = dailyCap && dailyCap > 0 ? budget.daySpentMicros / dailyCap : 0;
  const dayCls =
    dayPct >= 1
      ? 'text-state-error'
      : dayPct >= 0.8
        ? 'text-state-attention'
        : 'text-text-muted';
  return (
    <>
      <ApiKeyDropdown
        apiKeys={apiKeys}
        selectedKeyId={selectedKeyId}
        onSelectKey={onSelectKey}
      />
      <div
        className="mt-1.5 text-[11px] font-mono space-y-0.5"
        title={
          'Headline number is spend in the current clock-hour bucket — that is what the governor enforces. ' +
          'A session whose key has hit the cap pauses until the top of the next clock hour. ' +
          'New sessions get one free turn per hour even when the bucket is exhausted (the min-one-turn-per-session-per-hour exemption).' +
          (dailyCap
            ? ` Daily budget is ${formatUsdMicros(dailyCap)} spread across the key's active-hours window (= daily / N active hours; default N=24).`
            : '')
        }
      >
        <div className={clsx('flex justify-between', hourCls)}>
          <span>this hour</span>
          <span>
            {formatUsdMicros(hourSpent)} / {formatUsdMicros(hourCap)}
          </span>
        </div>
        {dailyCap && dailyCap > 0 && (
          <div className={clsx('flex justify-between', dayCls)}>
            <span>today</span>
            <span>
              {formatUsdMicros(budget.daySpentMicros)} / {formatUsdMicros(dailyCap)}
            </span>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Compact dropdown above the budget pill that switches which API key the
 * pill is scoped to. "All keys" sums across every configured key plus
 * any legacy un-keyed events. Selecting a specific key shows only that
 * key's spend and budget.
 *
 * Renders as a single-line button with a chevron; clicking pops an
 * absolute-positioned panel below it (small list, no portal needed
 * since the sidebar's overflow doesn't clip the header). Closes on
 * outside-click and Escape.
 */
function ApiKeyDropdown({
  apiKeys,
  selectedKeyId,
  onSelectKey,
}: {
  apiKeys: ApiKey[];
  selectedKeyId: string | null;
  onSelectKey: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Only show the dropdown when there's more than one key — with a
  // single key, the pill should just show that key's view without UI
  // noise. The "All keys" view also stops being useful with only one
  // key configured because it equals the single-key view.
  if (apiKeys.length <= 1) return null;

  const selectedKey = apiKeys.find((k) => k.id === selectedKeyId) ?? null;
  const label = selectedKey ? selectedKey.name : 'All keys';

  return (
    <div ref={wrapperRef} className="relative mt-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full inline-flex items-center justify-between gap-1 px-2 py-1 text-[11px] rounded-md border border-border bg-bg/40 hover:bg-bg-hover text-text-muted"
        title="Pick which API key's spend and budget to show in the pill below"
      >
        <span className="truncate text-text">{label}</span>
        <ChevronDown size={11} className="shrink-0" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-md border border-border bg-bg-panel shadow-lg py-1 text-[12px]">
          <DropdownItem
            label="All keys"
            selected={selectedKeyId === null}
            onClick={() => {
              onSelectKey(null);
              setOpen(false);
            }}
          />
          {apiKeys.map((k) => (
            <DropdownItem
              key={k.id}
              label={k.name}
              selected={selectedKeyId === k.id}
              hint={k.preview ?? undefined}
              isDefault={k.is_default}
              onClick={() => {
                onSelectKey(k.id);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DropdownItem({
  label,
  selected,
  hint,
  isDefault,
  onClick,
}: {
  label: string;
  selected: boolean;
  hint?: string;
  isDefault?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-bg-hover"
    >
      <span className="shrink-0 w-3 flex justify-center">
        {selected && <Check size={11} className="text-state-success" />}
      </span>
      <span className="flex-1 min-w-0 truncate text-text">
        {label}
        {isDefault && (
          <Star
            size={9}
            className="inline -mt-0.5 ml-1 text-state-attention"
            fill="currentColor"
            aria-label="default"
          />
        )}
      </span>
      {hint && (
        <span className="text-[10px] font-mono text-text-dim shrink-0">{hint}</span>
      )}
    </button>
  );
}

function NewSessionButton() {
  const createSession = useApp((s) => s.createSession);
  const onClick = async () => {
    // No cwd binding — Guy sessions can read/write/shell anywhere.
    // User tells the agent which machine / directory in natural language.
    await createSession('', null);
  };
  return (
    <button
      onClick={onClick}
      className="mt-2 w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-accent text-white hover:bg-accent-dim px-2 py-1.5 text-[12px] font-medium transition-colors"
      title="Start a new session (no folder binding)"
    >
      <Plus size={14} />
      New session
    </button>
  );
}
