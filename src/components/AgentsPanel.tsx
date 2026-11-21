/**
 * Agents panel (A2A design 6.7): who we are paired with and how much we trust
 * them, the requests waiting for the user's approval, every A2A task in both
 * directions, and the A2A audit log.
 *
 * Trust escalation is the one place in Guy Code where a careless click could
 * let another person's agent drive this one, so raising a peer to
 * "collaborate" or "full" asks twice: a dialog here that spells out the
 * consequence (and offers an expiry), then a native confirm from the main
 * process, which is the one a compromised renderer cannot skip.
 *
 * Refreshes on the `a2a_changed` agent event and every 15 seconds (to keep
 * last-seen times and expiry countdowns honest).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { X, RefreshCw, Check, Ban, Copy, PauseCircle, PlayCircle, AlertTriangle } from 'lucide-react';
import type { A2APanelPeer, A2APanelSnapshot, A2APanelTask, A2ATrust } from '@/types';
import { relativeTime } from '@/lib/format';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
}

type Tab = 'inbox' | 'peers' | 'tasks' | 'audit';

const TRUSTS: A2ATrust[] = ['blocked', 'inform', 'collaborate', 'full'];

const EXPIRY_CHOICES: Array<{ label: string; ms: number | null }> = [
  { label: 'No expiry', ms: null },
  { label: '1 hour', ms: 3_600_000 },
  { label: '8 hours', ms: 8 * 3_600_000 },
  { label: '1 day', ms: 24 * 3_600_000 },
  { label: '1 week', ms: 7 * 24 * 3_600_000 },
];

export function stateChipClass(state: string): string {
  const s = state.replace(/^TASK_STATE_/, '');
  if (s === 'COMPLETED') return 'bg-green-500/15 text-green-600 dark:text-green-400';
  if (s === 'FAILED' || s === 'REJECTED') return 'bg-red-500/15 text-red-600 dark:text-red-400';
  if (s === 'CANCELED') return 'bg-bg-hover text-text-dim';
  if (s === 'INPUT_REQUIRED' || s === 'AUTH_REQUIRED') return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
  return 'bg-blue-500/15 text-blue-600 dark:text-blue-400';
}

function StateChip({ state }: { state: string }) {
  return (
    <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide', stateChipClass(state))}>
      {state.replace(/^TASK_STATE_/, '').replace('_', ' ')}
    </span>
  );
}

function countdown(ts: number | null): string {
  if (!ts) return '';
  const left = ts - Date.now();
  if (left <= 0) return 'expiring';
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h left` : h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

/** Text for the escalation confirm. Exported for tests. */
export function escalationWarning(who: string, level: A2ATrust): string {
  return level === 'full'
    ? `${who}'s agent will be able to make your agent run commands, edit files, and change shared systems without asking you.`
    : `${who}'s agent's requests will reach your agent without asking you first. It may act on reasonable ones but must still ask before destructive or shared-resource actions.`;
}

export function AgentsPanel({ open, onClose, onOpenSession }: Props) {
  const [snap, setSnap] = useState<A2APanelSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>('inbox');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [escalate, setEscalate] = useState<{ peer: A2APanelPeer; level: A2ATrust } | null>(null);
  const [invite, setInvite] = useState<{ code: string; expires: number } | null>(null);
  const [audit, setAudit] = useState<Array<Record<string, unknown>>>([]);
  const [auditFilter, setAuditFilter] = useState('');

  const refresh = useCallback(async () => {
    try {
      setSnap(await window.api.a2a.snapshot());
    } catch (e) {
      setNote((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const off = window.api.agent.onEvent((e: any) => {
      if (e?.type === 'a2a_changed') void refresh();
    });
    const t = setInterval(() => void refresh(), 15_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [open, refresh]);

  useEffect(() => {
    if (open && tab === 'audit') void window.api.a2a.audit(500).then(setAudit);
  }, [open, tab, snap]);

  const run = async (fn: () => Promise<{ ok: boolean; message: string } | void>) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fn();
      if (r && r.message) setNote(r.message);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const onTrust = (peer: A2APanelPeer, level: A2ATrust) => {
    if (level === peer.trust) return;
    const raising = TRUSTS.indexOf(level) > TRUSTS.indexOf(peer.trust) && TRUSTS.indexOf(level) >= 2;
    if (raising) setEscalate({ peer, level });
    else void run(() => window.api.a2a.setTrust(peer.peerId, level, null));
  };

  const filteredAudit = useMemo(() => {
    const q = auditFilter.trim().toLowerCase();
    const rows = [...audit].reverse();
    return q ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)) : rows;
  }, [audit, auditFilter]);

  if (!open) return null;
  const pending = snap?.pending ?? [];

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[720px] max-w-[92vw] h-full flex flex-col border-l border-border bg-bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Agents"
      >
        <header className="px-4 py-3 border-b border-border flex items-center gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text">Agents (A2A)</h2>
            <p className="text-[11px] text-text-dim">
              {snap?.running ? `${snap.peers.length} peer${snap.peers.length === 1 ? '' : 's'}` : 'A2A is off (Settings -> Agent-to-agent)'}
              {snap?.paused ? ' - paused: every peer is capped at inform' : ''}
            </p>
          </div>
          {snap?.running && (
            <button
              className={clsx(
                'ml-auto flex items-center gap-1 px-2 py-1 rounded text-[11px] border',
                snap.paused ? 'border-amber-500 text-amber-600' : 'border-border text-text-dim hover:text-text'
              )}
              disabled={busy}
              onClick={() => run(() => window.api.a2a.setPaused(!snap.paused))}
              title="Pause all A2A: every peer is treated as inform (nothing acts without your approval). Configured levels are kept."
            >
              {snap.paused ? <PlayCircle size={12} /> : <PauseCircle size={12} />}
              {snap.paused ? 'Resume A2A' : 'Pause all A2A'}
            </button>
          )}
          <button onClick={() => void refresh()} className={clsx('p-1.5 rounded text-text-dim hover:text-text hover:bg-bg-hover', !snap?.running && 'ml-auto')} title="Refresh">
            <RefreshCw size={14} />
          </button>
          <button onClick={onClose} className="p-1.5 rounded text-text-dim hover:text-text hover:bg-bg-hover" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <nav className="px-4 pt-2 flex gap-1 text-[12px] border-b border-border">
          {(['inbox', 'peers', 'tasks', 'audit'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx('px-3 py-1.5 rounded-t capitalize', tab === t ? 'bg-bg-hover text-text' : 'text-text-dim hover:text-text')}
            >
              {t}
              {t === 'inbox' && pending.length > 0 && (
                <span className="ml-1.5 px-1.5 rounded-full bg-amber-500 text-white text-[10px]" data-testid="a2a-pending-badge">
                  {pending.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        {note && <div className="px-4 py-2 text-[11px] text-text-muted border-b border-border">{note}</div>}

        <div className="flex-1 overflow-y-auto">
          {tab === 'inbox' && (
            <section className="p-4 space-y-3">
              {pending.length === 0 ? (
                <p className="text-[12px] text-text-dim italic">
                  Nothing is waiting for you. Requests from peers at "inform" trust appear here before they reach a session.
                </p>
              ) : (
                pending.map((t) => (
                  <div key={t.taskId} className="border border-border rounded p-3">
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="font-medium text-text">{t.peerId}'s agent</span>
                      <span className="text-text-dim">{t.kind === 'notify' ? 'asks to be told when' : 'asks'}</span>
                      <span className="ml-auto font-mono text-[10px] text-text-dim">{t.taskId.slice(0, 8)}</span>
                    </div>
                    <p className="mt-1 text-[12px] text-text-muted whitespace-pre-wrap break-words">{t.summary}</p>
                    <p className="mt-1 text-[10px] text-text-dim">
                      Accept delivers it to the routed session. It is another person's agent: your agent is told to treat it as a
                      request from a colleague, not from you.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        disabled={busy}
                        className="flex items-center gap-1 px-2 py-1 rounded bg-accent text-white text-[11px]"
                        onClick={() => run(() => window.api.a2a.accept(t.taskId))}
                      >
                        <Check size={12} /> Accept
                      </button>
                      <button
                        disabled={busy}
                        className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[11px] text-text-dim hover:text-text"
                        onClick={() => run(() => window.api.a2a.decline(t.taskId))}
                      >
                        <Ban size={12} /> Decline
                      </button>
                    </div>
                  </div>
                ))
              )}
            </section>
          )}

          {tab === 'peers' && (
            <section className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <button
                  disabled={busy || !snap?.running}
                  className="flex items-center gap-1 px-2 py-1 rounded border border-border text-[11px] text-text-dim hover:text-text"
                  onClick={() => run(async () => setInvite(await window.api.a2a.invite()))}
                >
                  <Copy size={12} /> Get my pairing code
                </button>
                {invite && (
                  <button
                    className="text-[11px] font-mono truncate max-w-[440px] text-text-muted"
                    title="Click to copy. Single use, valid 15 minutes. Send it to your colleague directly."
                    onClick={() => void navigator.clipboard?.writeText(invite.code).then(() => setNote('Pairing code copied.'))}
                  >
                    {invite.code}
                  </button>
                )}
              </div>
              {(snap?.peers ?? []).length === 0 && <p className="text-[12px] text-text-dim italic">No paired peers yet.</p>}
              {(snap?.peers ?? []).map((p) => (
                <div key={p.peerId} className="border border-border rounded p-3 text-[12px]">
                  <div className="flex items-center gap-2">
                    <span
                      className={clsx('w-2 h-2 rounded-full', p.lastSeenTs && Date.now() - p.lastSeenTs < 10 * 60_000 ? 'bg-green-500' : 'bg-text-dim/40')}
                      title={p.lastSeenTs ? `last seen ${relativeTime(p.lastSeenTs)}` : 'never seen'}
                    />
                    <span className="font-medium text-text">{p.displayName ?? p.peerId}</span>
                    <span className="text-text-dim">({p.peerId}, {p.agentKind === 'claude-code' ? 'Claude Code' : p.agentKind === 'guycode' ? 'Guy Code' : 'A2A agent'})</span>
                    {p.effectiveTrust === 'full' && <span className="px-1.5 rounded bg-red-600 text-white text-[10px]">FULL TRUST</span>}
                    {p.queued > 0 && <span className="text-[10px] text-amber-600">{p.queued} queued</span>}
                    <span className="ml-auto text-[10px] text-text-dim">{p.lastSeenTs ? relativeTime(p.lastSeenTs) : 'never seen'}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <label className="text-text-dim text-[11px]">Trust</label>
                    <select
                      aria-label={`Trust for ${p.peerId}`}
                      className="bg-bg-elevated border border-border rounded px-1 py-0.5 text-[11px]"
                      value={p.trust}
                      disabled={busy}
                      onChange={(e) => onTrust(p, e.target.value as A2ATrust)}
                    >
                      {TRUSTS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    {p.effectiveTrust !== p.trust && <span className="text-[10px] text-amber-600">effective: {p.effectiveTrust}</span>}
                    {p.trustExpiresTs && (
                      <span className="text-[10px] text-text-dim">
                        {countdown(p.trustExpiresTs)}, then {p.trustPrev ?? 'inform'}
                      </span>
                    )}
                    <button
                      disabled={busy}
                      className="ml-auto text-[11px] text-text-dim hover:text-red-500"
                      onClick={() => {
                        if (window.confirm(`Unpair from ${p.displayName ?? p.peerId}? Their agent will no longer be able to reach yours.`)) {
                          void run(() => window.api.a2a.revoke(p.peerId));
                        }
                      }}
                    >
                      Unpair
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {tab === 'tasks' && <TaskList tasks={snap?.tasks ?? []} onOpenSession={onOpenSession} />}

          {tab === 'audit' && (
            <section className="p-4">
              <input
                className="w-full mb-2 bg-bg-elevated border border-border rounded px-2 py-1 text-[12px]"
                placeholder="Filter (peer, event, task id, text)"
                value={auditFilter}
                onChange={(e) => setAuditFilter(e.target.value)}
              />
              <ul className="divide-y divide-border">
                {filteredAudit.map((r, i) => (
                  <li key={i} className="py-1 text-[11px] font-mono text-text-muted break-words">
                    <span className="text-text-dim">{String(r.ts ?? '').replace('T', ' ').slice(0, 19)}</span>{' '}
                    <span className="text-text">{String(r.event)}</span> {r.peer ? <span>{String(r.peer)} </span> : null}
                    {r.taskId ? <span className="text-text-dim">{String(r.taskId).slice(0, 8)} </span> : null}
                    {r.state ? <span>{String(r.state).replace(/^TASK_STATE_/, '')} </span> : null}
                    {r.text ? <span className="text-text-dim">"{String(r.text).slice(0, 160)}"</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {escalate && (
          <EscalateDialog
            peer={escalate.peer}
            level={escalate.level}
            onCancel={() => setEscalate(null)}
            onConfirm={(ms) => {
              const { peer, level } = escalate;
              setEscalate(null);
              void run(() => window.api.a2a.setTrust(peer.peerId, level, ms));
            }}
          />
        )}
      </div>
    </div>
  );
}

function TaskList({ tasks, onOpenSession }: { tasks: A2APanelTask[]; onOpenSession?: (id: string) => void }) {
  if (!tasks.length) return <p className="p-4 text-[12px] text-text-dim italic">No A2A tasks yet.</p>;
  return (
    <ul className="divide-y divide-border">
      {tasks.map((t) => (
        <li key={t.taskId} className="px-4 py-2 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="text-text-dim">{t.direction === 'out' ? 'to' : 'from'}</span>
            <span className="font-medium text-text">{t.peerId}</span>
            <span className="text-text-dim">{t.kind}</span>
            <StateChip state={t.state} />
            {t.approval === 'pending' && <span className="text-[10px] text-amber-600">needs your approval</span>}
            <span className="ml-auto font-mono text-[10px] text-text-dim">{t.taskId.slice(0, 8)}</span>
            {t.sessionId && onOpenSession && (
              <button className="text-[10px] text-accent hover:underline" onClick={() => onOpenSession(t.sessionId!)}>
                session
              </button>
            )}
          </div>
          <div className="text-text-muted truncate">{t.summary}</div>
          {t.lastText && <div className="text-[11px] text-text-dim truncate">-&gt; {t.lastText}</div>}
        </li>
      ))}
    </ul>
  );
}

function EscalateDialog({ peer, level, onCancel, onConfirm }: { peer: A2APanelPeer; level: A2ATrust; onCancel: () => void; onConfirm: (ms: number | null) => void }) {
  const who = peer.displayName ?? peer.peerId;
  // design 4.2.3: suggest a day for `full`, unless the user picks otherwise.
  const [ms, setMs] = useState<number | null>(level === 'full' ? 24 * 3_600_000 : null);
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" role="alertdialog" aria-label="Confirm trust change">
      <div className="w-[440px] rounded border border-border bg-bg-panel p-4 shadow-xl">
        <div className="flex items-center gap-2 text-sm font-semibold text-text">
          <AlertTriangle size={16} className={level === 'full' ? 'text-red-500' : 'text-amber-500'} />
          Give {who} "{level}" trust?
        </div>
        <p className="mt-2 text-[12px] text-text-muted">{escalationWarning(who, level)}</p>
        <p className="mt-2 text-[11px] text-text-dim">
          Guidance plus gating, not a sandbox: your own tool permissions still apply, and everything is audited.
        </p>
        <label className="mt-3 flex items-center gap-2 text-[12px] text-text-dim">
          Expires
          <select
            className="bg-bg-elevated border border-border rounded px-1 py-0.5 text-[11px]"
            value={ms === null ? '' : String(ms)}
            onChange={(e) => setMs(e.target.value ? Number(e.target.value) : null)}
          >
            {EXPIRY_CHOICES.map((c) => (
              <option key={c.label} value={c.ms === null ? '' : String(c.ms)}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button className="px-3 py-1 rounded border border-border text-[12px]" onClick={onCancel}>
            Cancel
          </button>
          <button className={clsx('px-3 py-1 rounded text-white text-[12px]', level === 'full' ? 'bg-red-600' : 'bg-amber-600')} onClick={() => onConfirm(ms)}>
            Give {level} trust
          </button>
        </div>
      </div>
    </div>
  );
}
