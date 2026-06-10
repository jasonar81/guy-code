import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  KeyRound,
  Cpu,
  Save,
  Plug,
  LogIn,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Plus,
  Star,
  Trash2,
  Edit3,
  RotateCcw,
  Globe,
  Copy,
  Check,
  Terminal,
} from 'lucide-react';
import clsx from 'clsx';
import type { McpServerStatus, ApiKey } from '@/types';
import { useApp } from '@/lib/store';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Keep this in sync with `electron/anthropic.ts` DEFAULT_MODEL. The `[1m]`
// suffix is the Claude Code convention for opting into the 1M-context
// window — at sub-1M sizes the 200K cap forces aggressive compaction.
const DEFAULT_MODEL = 'claude-fable-5[1m]';

export function SettingsModal({ open, onClose }: Props) {
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [memoryRetrieval, setMemoryRetrieval] = useState<boolean>(true);
  const [routing, setRouting] = useState<boolean>(false);
  const [cheapModel, setCheapModel] = useState<string>('claude-sonnet-4-6');
  const [routingFloor, setRoutingFloor] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // `mcpMsg` reuses the previous reset-banner area to surface MCP
  // sign-in / sign-out failures so the user has somewhere to see them.
  const [mcpMsg, setMcpMsg] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  // App version, fetched from main once when the modal opens. Sourced
  // from `app.getVersion()`, which in release builds is rewritten from
  // the GitHub release tag by the CI workflow — so there's no risk
  // package.json's checked-in version drifts from what the user sees.
  // null while loading / on IPC failure (kept silent — the footer
  // just shows nothing in that case rather than a broken "v???").
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Multi-key support lives in the global store so the Sidebar's budget pill
  // and the SessionContextMenu can share the same source of truth without an
  // extra IPC round-trip.
  const apiKeys = useApp((s) => s.apiKeys);
  const refreshApiKeys = useApp((s) => s.refreshApiKeys);

  // Track whether the current "click" started inside the modal panel. If so,
  // we don't dismiss on backdrop click. Without this, dragging a text
  // selection from an input out into the backdrop area causes the modal to
  // close mid-edit (the `click` event lands on the backdrop, not the panel).
  const mouseDownInside = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const m = await window.api.settings.get('model');
      if (cancelled) return;
      setModel(m && m.trim() ? m : DEFAULT_MODEL);
      const mr = await window.api.settings.get('memory_retrieval');
      if (cancelled) return;
      setMemoryRetrieval(mr !== 'off'); // default on
      const rt = await window.api.settings.get('routing');
      if (cancelled) return;
      setRouting(rt === 'on'); // default off (opt-in)
      const cm = await window.api.settings.get('routing.cheapModel');
      if (cancelled) return;
      setCheapModel(cm && cm.trim() ? cm : 'claude-sonnet-4-6');
      const rf = await window.api.settings.get('routing.floor');
      if (cancelled) return;
      setRoutingFloor(rf || '');
      setSavedAt(null);
      setMcpMsg(null);
      // Make sure the keys list is fresh whenever the user opens
      // Settings (a key may have been added/removed via another path).
      refreshApiKeys();
      // Fetch the running app version. Cheap one-shot (no polling —
      // the version doesn't change while the app is open) and best-
      // effort — a missing IPC handler in an older preload build
      // just leaves the footer chip hidden.
      try {
        const v = await window.api.app.version();
        if (!cancelled && typeof v === 'string' && v) setAppVersion(v);
      } catch {
        /* ignore: footer chip stays hidden when IPC is unavailable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, refreshApiKeys]);

  // Pull MCP status while open, poll every 3s in case a sign-in completes.
  const refreshMcp = useCallback(async () => {
    try {
      const r = await window.api.mcp.list();
      setMcpServers(r);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    refreshMcp();
    const t = setInterval(refreshMcp, 3000);
    return () => clearInterval(t);
  }, [open, refreshMcp]);

  if (!open) return null;

  const onSave = async () => {
    // The Settings modal only persists the model now. Per-key budgets and
    // the keys themselves are stored as the user edits them via the
    // ApiKeysSection (each row's save button), so they're already on disk
    // by the time the user clicks the modal's Save. Keeping a single Save
    // for the model preserves the previous "edit-then-commit" feel for
    // the one global setting that still works that way.
    setSaving(true);
    try {
      await window.api.settings.set('model', model.trim() || DEFAULT_MODEL);
      // Legacy fallback values exist in the old settings table — if the
      // user landed here from a pre-migration build we want any in-flight
      // single-budget config to be cleared so the new per-key values are
      // the only source of truth going forward. This is idempotent.
      await window.api.settings.set('budget.rollingHourCapUsd', '');
      setSavedAt(Date.now());
      // Settings saved successfully — dismiss the modal. The user expects a
      // single click to commit-and-close; sticking around forces a second click.
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const onSignIn = async (name: string) => {
    setSigningIn(name);
    try {
      const r = await window.api.mcp.signIn(name);
      if (!r.ok) {
        setMcpMsg(`Sign-in to ${name} failed: ${r.error ?? 'unknown error'}`);
      }
    } finally {
      setSigningIn(null);
      refreshMcp();
    }
  };

  const onSignOut = async (name: string) => {
    if (
      !window.confirm(
        `Sign out of ${name}?\n\nThis clears the saved OAuth tokens and disconnects the server. You'll need to sign in again to use it (which is the right flow after editing scope in your .mcp.json).`
      )
    ) {
      return;
    }
    try {
      const r = await window.api.mcp.signOut(name);
      if (!r.ok) {
        setMcpMsg(`Sign-out of ${name} failed: ${r.error ?? 'unknown error'}`);
      }
    } finally {
      refreshMcp();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Only treat clicks that BEGAN on the backdrop as dismiss intent.
        // Clicks that began inside the panel (e.g. drag-selecting text out
        // of an input) should not close the modal.
        if (e.target === e.currentTarget) mouseDownInside.current = false;
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        if (mouseDownInside.current) {
          mouseDownInside.current = false;
          return;
        }
        onClose();
      }}
    >
      <div
        className="w-[520px] max-w-[90vw] max-h-[90vh] flex flex-col rounded-lg border border-border bg-bg-panel shadow-xl"
        onMouseDown={() => {
          mouseDownInside.current = true;
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-text">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 rounded text-text-dim hover:text-text hover:bg-bg-hover"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="px-4 py-4 space-y-5 flex-1 min-h-0 overflow-y-auto">
          <Field
            icon={<Cpu size={14} />}
            label="Model"
            hint="Anthropic model id. Append [1m] for 1M-context (e.g. claude-opus-4-8[1m]) - strongly recommended for agentic work; the 200K cap forces lots of compaction. Server-side micro-compaction is enabled regardless. Default is Claude Fable 5 at xhigh effort. Smart memory retrieval keeps unrelated (e.g. security) notes out of benign prompts so it does not over-refuse; simple turns can route to a cheaper model; and any residual refusal auto-retries on Opus 4.8. Switch models here anytime."
          >
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] font-mono text-text outline-none focus:border-accent"
              placeholder={DEFAULT_MODEL}
            />
          </Field>

          <Field
            icon={<Cpu size={14} />}
            label="Smart memory retrieval"
            hint="Instead of loading your entire saved-memory tree into every prompt, a cheap model picks the notes relevant to each message and loads only those (plus a small always-on core). Cuts cost, sharpens focus, and avoids unrelated content (e.g. security notes) triggering refusals on safety-stricter models. Recommended on."
          >
            <label className="flex items-center gap-2 text-[13px] text-text cursor-pointer">
              <input
                type="checkbox"
                checked={memoryRetrieval}
                onChange={async (e) => {
                  setMemoryRetrieval(e.target.checked);
                  await window.api.settings.set('memory_retrieval', e.target.checked ? 'on' : 'off');
                }}
              />
              {memoryRetrieval ? 'On (relevance-filtered memory)' : 'Off (load all memory every turn)'}
            </label>
          </Field>

          <Field
            icon={<Cpu size={14} />}
            label="Smart model routing"
            hint="When on, a cheap model first classifies each turn and routes clearly-simple turns (lookups, small edits, questions) to a cheaper model, keeping the strong model for complex/agentic/correctness-critical work. Biased to the strong model when uncertain, and a refusal/empty result still escalates back to the strong model. Off by default."
          >
            <label className="flex items-center gap-2 text-[13px] text-text cursor-pointer">
              <input
                type="checkbox"
                checked={routing}
                onChange={async (e) => {
                  setRouting(e.target.checked);
                  await window.api.settings.set('routing', e.target.checked ? 'on' : 'off');
                }}
              />
              {routing ? 'On (route simple turns to a cheaper model)' : 'Off (always use your selected model)'}
            </label>
            {routing && (
              <div className="mt-2 space-y-2">
                <div>
                  <div className="text-[11px] text-text-dim mb-1">Cheap model (for simple turns)</div>
                  <input
                    type="text"
                    value={cheapModel}
                    onChange={(e) => setCheapModel(e.target.value)}
                    onBlur={async () =>
                      await window.api.settings.set('routing.cheapModel', cheapModel.trim() || 'claude-sonnet-4-6')
                    }
                    className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] font-mono text-text outline-none focus:border-accent"
                    placeholder="claude-sonnet-4-6"
                  />
                </div>
                <div>
                  <div className="text-[11px] text-text-dim mb-1">
                    Minimum model floor (optional - routing never goes below this)
                  </div>
                  <input
                    type="text"
                    value={routingFloor}
                    onChange={(e) => setRoutingFloor(e.target.value)}
                    onBlur={async () => await window.api.settings.set('routing.floor', routingFloor.trim())}
                    className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] font-mono text-text outline-none focus:border-accent"
                    placeholder="(none)"
                  />
                </div>
              </div>
            )}
          </Field>

          <ApiKeysSection keys={apiKeys} />

          <ChromeConnectorSection open={open} />

          <LinuxAutomationSection open={open} />

          {mcpMsg && (
            <div className="pt-2 border-t border-border">
              <p className="text-[11px] text-text-dim leading-snug">{mcpMsg}</p>
            </div>
          )}

          <McpServersSection
            servers={mcpServers}
            signingIn={signingIn}
            onSignIn={onSignIn}
            onSignOut={onSignOut}
          />
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          {/* Version chip on the LEFT. We want it always visible (so the
              user can read off the version when filing a bug) but
              visually subordinate to the Save / Cancel actions, hence
              the muted color + monospace + small font. Hidden silently
              while the IPC fetch is in flight or fails. */}
          {appVersion && (
            <span
              className="text-[10px] font-mono text-text-dim select-text"
              title={`Guy Code v${appVersion} — embedded at build time from the GitHub release tag. Reference this when filing issues.`}
            >
              v{appVersion}
            </span>
          )}
          {savedAt && (
            <span className="text-[11px] text-text-dim mr-auto">Saved.</span>
          )}
          {/* When no "Saved." badge is showing, push the buttons to the
              right so the version chip alone doesn't leave them
              hugging the version. The empty spacer keeps layout
              consistent regardless of whether the user has just
              saved. */}
          {!savedAt && <span className="mr-auto" aria-hidden="true" />}
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-[12px] rounded-md text-text-dim hover:text-text hover:bg-bg-hover"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className={clsx(
              'inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md font-medium transition-colors',
              saving
                ? 'bg-bg-hover text-text-dim'
                : 'bg-accent text-white hover:bg-accent-dim'
            )}
          >
            <Save size={12} />
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function McpServersSection({
  servers,
  signingIn,
  onSignIn,
  onSignOut,
}: {
  servers: McpServerStatus[];
  signingIn: string | null;
  onSignIn: (name: string) => void;
  onSignOut: (name: string) => void;
}) {
  // Sort: needs-auth first (action items), then connected, then disabled, then errors.
  const order: Record<McpServerStatus['status'], number> = {
    'needs-auth': 0,
    connecting: 1,
    connected: 2,
    error: 3,
    disabled: 4,
  };
  const sorted = [...servers].sort(
    (a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name)
  );

  return (
    <div className="pt-2 border-t border-border">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-text mb-1.5">
        <Plug size={14} className="text-text-dim" />
        Integrations
      </div>
      <p className="text-[11px] text-text-dim leading-snug mb-2">
        MCP servers from <code className="font-mono">~/.claude.json</code> and
        installed Claude Code plugins. Enable a plugin by adding its name to{' '}
        <code className="font-mono">~/.guycode/mcp.json</code> under{' '}
        <code className="font-mono">enabledPlugins</code>, or set{' '}
        <code className="font-mono">autoEnableAllPlugins: true</code> to load
        every installed plugin. Restart to apply.
      </p>
      <p className="text-[11px] text-text-dim leading-snug mb-2">
        <strong className="text-text-muted">Can't write to Confluence / Jira?</strong> The
        Atlassian MCP server defaults to read-only scopes. Add an explicit{' '}
        <code className="font-mono">oauth.scope</code> to its entry in{' '}
        <code className="font-mono">~/.guycode/mcp.json</code> — e.g.{' '}
        <code className="font-mono break-all">
          "read:jira-work write:jira-work read:confluence-content.all
          write:confluence-content write:confluence-space offline_access"
        </code>{' '}
        — then click "Sign out" below and "Sign in" again. The granted scopes
        are logged when tokens are saved (check the Electron logs).
      </p>
      {sorted.length === 0 ? (
        <p className="text-[11px] text-text-dim italic">
          No MCP servers detected. Add one to{' '}
          <code className="font-mono">~/.guycode/mcp.json</code>.
        </p>
      ) : (
        <div className="space-y-1">
          {sorted.map((s) => (
            <McpRow
              key={s.name}
              s={s}
              busy={signingIn === s.name}
              onSignIn={() => onSignIn(s.name)}
              onSignOut={() => onSignOut(s.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Linux app automation (WSL on Windows) setup.
 *
 * Lets the agent run Linux apps - games/emulators, drawing apps, anything that
 * needs real input - inside an isolated Linux VM (WSL2), where the native
 * Windows hidden-desktop path can't reach. One-time setup: ensure WSL is
 * installed, install the Linux tools + apps, and (optionally) remember the WSL
 * sudo password used during that setup (it isn't needed afterwards).
 */
function LinuxAutomationSection({ open }: { open: boolean }) {
  const [status, setStatus] = useState<{
    installed: boolean;
    depsInstalled: boolean;
    defaultDistro?: string | null;
    reason?: string;
    sudoStored?: boolean;
    platform: string;
  } | null>(null);
  const [pw, setPw] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const s = await window.api.wsl.status();
      setStatus(s);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open]);

  // On Linux the host automates natively (no setup here). On macOS we show the
  // QEMU-guest setup instead of the WSL flow.
  if (status && status.platform === 'linux') return null;
  if (status && status.platform === 'darwin') return <MacAutomationSection />;

  const installWsl = async () => {
    setBusy('wsl');
    setMsg(null);
    try {
      const r = await window.api.wsl.installWsl();
      setMsg(r.message);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const installDeps = async () => {
    setBusy('deps');
    setMsg('Installing Linux tools + apps (this can take a couple minutes)...');
    try {
      const r = await window.api.wsl.installDeps(pw || undefined, remember);
      setMsg(r.message);
      if (r.ok) setPw('');
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const savePw = async () => {
    setBusy('pw');
    setMsg(null);
    try {
      const r = await window.api.wsl.setSudoPassword(pw, remember);
      setMsg(r.message);
      if (r.ok && remember) setPw('');
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const ready = status?.installed && status?.depsInstalled;

  return (
    <div className="pt-2 border-t border-border">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-text mb-1.5">
        <Terminal size={14} className="text-text-dim" />
        Linux app automation (WSL)
        {ready && <span className="text-[10px] text-state-success ml-1">ready</span>}
      </div>
      <p className="text-[11px] text-text-dim leading-snug mb-2">
        Lets the agent run Linux apps — games/emulators (e.g. an NES game),
        drawing apps, anything needing real input — inside an isolated Linux VM,
        without touching your screen. Needed for app automation the native
        Windows path can't do (modern Store apps, games). One-time setup.
      </p>

      {!status ? (
        <p className="text-[11px] text-text-dim">Checking…</p>
      ) : !status.installed ? (
        <div className="space-y-2">
          <p className="text-[11px] text-text-dim leading-snug">{status.reason}</p>
          <button
            onClick={installWsl}
            disabled={busy !== null}
            className="px-3 py-1.5 text-[12px] rounded border border-border bg-bg-elevated text-text hover:border-border-strong disabled:opacity-50"
          >
            {busy === 'wsl' ? 'Starting…' : 'Install WSL for me'}
          </button>
          <p className="text-[10px] text-text-muted leading-snug">
            This needs admin rights and a one-time reboot. After it finishes,
            reopen Settings to install the Linux tools.
          </p>
        </div>
      ) : !status.depsInstalled ? (
        <div className="space-y-2">
          <p className="text-[11px] text-text-dim leading-snug">
            WSL is installed ({status.defaultDistro}). Now install the Linux
            tools + apps. This needs your WSL sudo password (only for setup —
            not afterwards).
          </p>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="WSL sudo password"
            className="w-full px-2 py-1 text-[12px] rounded border border-border bg-bg text-text"
          />
          <label className="flex items-center gap-1.5 text-[11px] text-text-dim">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember it (encrypted) so I'm not asked again
          </label>
          <button
            onClick={installDeps}
            disabled={busy !== null || !pw}
            className="px-3 py-1.5 text-[12px] rounded border border-border bg-bg-elevated text-text hover:border-border-strong disabled:opacity-50"
          >
            {busy === 'deps' ? 'Installing…' : 'Install Linux tools + apps'}
          </button>
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[11px] text-state-success leading-snug">
            Ready ({status.defaultDistro}). The agent can run Linux apps with
            mode "linux-vm".
          </p>
          {!status.sudoStored && (
            <div className="space-y-1.5">
              <p className="text-[10px] text-text-muted leading-snug">
                Optionally save your WSL sudo password (encrypted) for future
                maintenance so you aren't asked again:
              </p>
              <div className="flex gap-1.5">
                <input
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="WSL sudo password"
                  className="flex-1 px-2 py-1 text-[12px] rounded border border-border bg-bg text-text"
                />
                <button
                  onClick={savePw}
                  disabled={busy !== null || !pw}
                  className="px-2 py-1 text-[11px] rounded border border-border text-text-dim hover:text-text disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
          )}
          {status.sudoStored && (
            <button
              onClick={async () => {
                await window.api.wsl.clearSudoPassword();
                refresh();
              }}
              className="text-[10px] text-text-muted hover:text-text underline"
            >
              Forget saved sudo password
            </button>
          )}
        </div>
      )}
      {msg && (
        <div className="mt-2 text-[10px] text-text-dim leading-snug bg-bg-elevated border border-border rounded px-2 py-1">
          {msg}
        </div>
      )}
    </div>
  );
}

/** macOS Linux-guest (QEMU) setup. */
function MacAutomationSection() {
  const [status, setStatus] = useState<{
    ready: boolean;
    qemu: boolean;
    image: boolean;
    reason: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setStatus(await window.api.macvm.status());
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const setup = async () => {
    setBusy(true);
    setMsg('Setting up the Linux guest...');
    try {
      const r = await window.api.macvm.setup();
      setMsg(r.message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className="pt-2 border-t border-border">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-text mb-1.5">
        <Terminal size={14} className="text-text-dim" />
        Linux app automation (VM)
        {status?.ready && <span className="text-[10px] text-state-success ml-1">ready</span>}
      </div>
      <p className="text-[11px] text-text-dim leading-snug mb-2">
        On macOS, app automation runs Linux apps inside a lightweight VM (the
        only way to drive apps without taking over your screen). Needs QEMU
        (`brew install qemu`) and a one-time Linux guest image.
      </p>
      {status && (
        <p className="text-[11px] text-text-dim leading-snug mb-2">{status.reason}</p>
      )}
      {status && !status.ready && (
        <button
          onClick={setup}
          disabled={busy || !status.qemu}
          className="px-3 py-1.5 text-[12px] rounded border border-border bg-bg-elevated text-text hover:border-border-strong disabled:opacity-50"
        >
          {busy ? 'Setting up…' : 'Set up Linux guest'}
        </button>
      )}
      {msg && (
        <div className="mt-2 text-[10px] text-text-dim leading-snug bg-bg-elevated border border-border rounded px-2 py-1">
          {msg}
        </div>
      )}
    </div>
  );
}

/**
 * Browser connector controls (Chrome and Edge) — extension transport.
 *
 * Previously this section walked the user through launching Chrome
 * with `--remote-debugging-port`. Chrome 136+ silently disables that
 * flag on default signed-in profiles (anti-cookie-theft measure) so
 * the CDP approach no longer works for the primary use case (driving
 * the user's already-logged-in browser).
 *
 * The replacement: a small unpacked WebExtension at
 * `chrome-extension/` in the repo, which connects out to a WebSocket
 * server we run in the Electron main process on port 9223. Once the
 * extension is loaded into Chrome OR Edge (one-time setup), the user
 * clicks Connect here and our server waits for the extension to
 * attach. The extension uses standard MV3 APIs (`chrome.tabs.*`,
 * `chrome.scripting.*`, `chrome.debugger`) which are identical in
 * Chrome and Edge — same package, same code, two browsers.
 *
 * Polling: when the modal is open, we re-fetch status every 3s so the
 * UI catches out-of-band changes (the user disables the extension →
 * the WS server sees the close and resets state). We do NOT poll
 * while closed so a backgrounded modal doesn't keep IPC noise high.
 */
function ChromeConnectorSection({ open }: { open: boolean }) {
  const [status, setStatus] = useState<{
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    port: number | null;
    error: string | null;
    connectedAt: number | null;
    tabCount: number;
    extensionBuild?: number | null;
    expectedExtensionBuild?: number;
    extensionStale?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // Local error message — Chrome connector errors are user-actionable
  // (port already in use, extension not loaded, etc.) and we want
  // them inline with the controls, not dumped into the shared mcpMsg.
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // Stored separately from `status.port` so the user can edit the
  // textbox even when not connected. Default 9223 = our WS server's
  // listen port; the extension's service worker has the same default
  // baked in, so 99% of users never touch this input.
  const [portInput, setPortInput] = useState<string>('9223');
  // Brief "Copied!" affordance on the per-browser extensions URL Copy
  // buttons. Tracked per-key so each row has its own state — clicking
  // Chrome's Copy doesn't briefly flash "Copied" on the Edge row.
  const [copiedKey, setCopiedKey] = useState<'chrome' | 'edge' | null>(
    null
  );

  const onCopyExtensionsUrl = async (
    key: 'chrome' | 'edge',
    url: string
  ) => {
    // chrome:// / edge:// URLs can't be opened from a non-privileged
    // origin (Chromium security policy), so the best the app can do
    // is put the URL on the clipboard and tell the user to paste it.
    try {
      await navigator.clipboard.writeText(url);
      setCopiedKey(key);
      setTimeout(
        () => setCopiedKey((k) => (k === key ? null : k)),
        1500
      );
    } catch {
      // Clipboard API can fail when the window isn't focused — rare
      // in an Electron modal but the fallback is cheap. Same approach
      // as the old launch-command copy.
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopiedKey(key);
        setTimeout(
          () => setCopiedKey((k) => (k === key ? null : k)),
          1500
        );
      } catch {
        /* nothing else to try; the user can paste from the visible code box */
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  const refresh = useCallback(async () => {
    try {
      const r = await window.api.chrome.status();
      setStatus(r);
    } catch {
      /* ignore — keep last good */
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [open, refresh]);

  const onConnect = async () => {
    setBusy(true);
    setErrMsg(null);
    try {
      const portNum = Number(portInput.trim());
      const port = Number.isFinite(portNum) && portNum > 0 ? portNum : 9223;
      const r = await window.api.chrome.connect(port);
      setStatus(r.status ?? null);
      if (!r.ok && r.error) setErrMsg(r.error);
    } finally {
      setBusy(false);
    }
  };
  const onDisconnect = async () => {
    setBusy(true);
    setErrMsg(null);
    try {
      const r = await window.api.chrome.disconnect();
      setStatus(r.status ?? null);
    } finally {
      setBusy(false);
    }
  };

  const s = status?.status ?? 'disconnected';
  let pillIcon: React.ReactNode;
  let pillLabel: string;
  let pillCls = 'text-text-dim';
  switch (s) {
    case 'connected':
      pillIcon = <CheckCircle2 size={12} className="text-state-success" />;
      pillLabel = `Connected · ${status?.tabCount ?? 0} tab${
        status?.tabCount === 1 ? '' : 's'
      }`;
      pillCls = 'text-state-success';
      break;
    case 'connecting':
      // "Connecting" in the new flow really means "WS server is up,
      // waiting for the extension to call in". User-facing copy
      // reflects that — they need to know to load/enable the extension.
      pillIcon = <Loader2 size={12} className="text-text-dim animate-spin" />;
      pillLabel = 'Waiting for extension…';
      break;
    case 'error':
      pillIcon = <AlertCircle size={12} className="text-state-error" />;
      pillLabel = 'Error';
      pillCls = 'text-state-error';
      break;
    default:
      pillIcon = <X size={12} className="text-text-dim" />;
      pillLabel = 'Disconnected';
      break;
  }

  return (
    <div className="pt-2 border-t border-border">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-text mb-1.5">
        <Globe size={14} className="text-text-dim" />
        Browser connector (Chrome / Edge)
      </div>
      <p className="text-[11px] text-text-dim leading-snug mb-2">
        Drive your existing logged-in Chrome or Edge (Gmail, Slack,
        Outlook, etc.) from the agent via a small browser extension.
        One-time setup; the extension reconnects automatically
        afterwards. The same extension works in either browser — load
        it into whichever one you actually use.
      </p>
      <ol className="text-[11px] text-text-dim leading-snug mb-2 list-decimal pl-4 space-y-0.5">
        <li>
          Open <code className="font-mono">chrome://extensions/</code>{' '}
          in Chrome <em>or</em>{' '}
          <code className="font-mono">edge://extensions/</code> in
          Edge (these URLs can't be opened from here — use Copy and
          paste into your browser's address bar).
        </li>
        <li>
          Turn on <strong>Developer mode</strong> (toggle; top-right
          in Chrome, bottom-left in Edge).
        </li>
        <li>
          Click <strong>Load unpacked</strong> and pick the{' '}
          <code className="font-mono">chrome-extension</code> folder
          inside your Guy Code checkout.
        </li>
        <li>Come back here and click Connect.</li>
      </ol>
      {/* Per-browser extensions-URL display + Copy. Two rows because
          there's no way for us to know which browser the user wants
          to use, and asking would add a click. Each Copy has its own
          flash state so feedback is local to the button you pressed. */}
      <div className="space-y-1 mb-2">
        {(
          [
            { key: 'chrome', label: 'Chrome', url: 'chrome://extensions/' },
            { key: 'edge', label: 'Edge', url: 'edge://extensions/' },
          ] as const
        ).map(({ key, label, url }) => {
          const isCopied = copiedKey === key;
          return (
            <div key={key} className="flex items-stretch gap-1.5">
              <span className="w-12 self-center text-[10px] font-medium text-text-dim shrink-0">
                {label}
              </span>
              <code
                className="flex-1 select-text text-[10px] font-mono bg-bg border border-border rounded p-1.5 overflow-x-auto whitespace-nowrap"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {url}
              </code>
              <button
                onClick={() => onCopyExtensionsUrl(key, url)}
                className={clsx(
                  'shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border transition-colors',
                  isCopied
                    ? 'border-state-success/50 text-state-success bg-state-success/10'
                    : 'border-border text-text-muted hover:text-text hover:border-border-strong'
                )}
                title={`Copy ${url} to the clipboard`}
              >
                {isCopied ? <Check size={11} /> : <Copy size={11} />}
                {isCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border bg-bg/40">
        <div className="shrink-0">{pillIcon}</div>
        <div className="flex-1 min-w-0">
          <div className={clsx('text-[12px] truncate', pillCls)}>{pillLabel}</div>
          {status?.error && (
            <div className="text-[10px] text-state-error truncate" title={status.error}>
              {status.error}
            </div>
          )}
          {s === 'connected' && status?.extensionStale && (
            <div
              className="text-[10px] text-state-attention leading-snug mt-0.5"
              title="The Chrome extension is loaded unpacked and does not auto-update. Reload it to pick up the latest fixes."
            >
              ⚠ Extension out of date (build {status.extensionBuild ?? 'unknown'}, expected{' '}
              {status.expectedExtensionBuild}). Reload it at{' '}
              <code className="font-mono">chrome://extensions/</code> (↻) to get the latest
              fixes — e.g. screenshots of minimized/background windows.
            </div>
          )}
        </div>
        <input
          type="text"
          inputMode="numeric"
          value={portInput}
          onChange={(e) => setPortInput(e.target.value)}
          disabled={s === 'connected' || s === 'connecting' || busy}
          className="w-16 rounded border border-border bg-bg px-1.5 py-0.5 text-[11px] font-mono text-text disabled:opacity-50 focus:outline-none focus:border-accent"
          title="WebSocket port. Default 9223. The extension uses the same default."
          placeholder="9223"
        />
        {s === 'connected' ? (
          <button
            onClick={onDisconnect}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-border text-text-dim hover:text-text hover:border-border-strong"
          >
            {busy ? <Loader2 size={10} className="animate-spin" /> : null}
            Disconnect
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={busy || s === 'connecting'}
            className={clsx(
              'shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border',
              busy || s === 'connecting'
                ? 'border-border text-text-dim'
                : 'border-state-attention/50 text-state-attention hover:bg-state-attention/10'
            )}
          >
            {busy || s === 'connecting' ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Plug size={10} />
            )}
            {s === 'connecting' || busy ? 'Waiting…' : 'Connect'}
          </button>
        )}
      </div>
      {errMsg && (
        <p className="mt-1.5 text-[10px] text-state-error leading-snug">
          {errMsg}
        </p>
      )}
    </div>
  );
}

function McpRow({
  s,
  busy,
  onSignIn,
  onSignOut,
}: {
  s: McpServerStatus;
  busy: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  // Expandable details panel: tool names, configured scope, source path.
  // Collapsed by default; the user opens it when investigating something
  // (typical case: "why doesn't this server have write tools?").
  const [expanded, setExpanded] = useState(false);
  let icon: React.ReactNode;
  let label: string;
  let labelCls = 'text-text-muted';
  switch (s.status) {
    case 'connected':
      icon = <CheckCircle2 size={12} className="text-state-success" />;
      label = `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}`;
      break;
    case 'needs-auth':
      icon = <LogIn size={12} className="text-state-attention" />;
      label = 'Sign-in required';
      labelCls = 'text-state-attention';
      break;
    case 'connecting':
      icon = <Loader2 size={12} className="text-text-dim animate-spin" />;
      label = 'Connecting…';
      break;
    case 'error':
      icon = <AlertCircle size={12} className="text-state-error" />;
      label = s.error ? s.error.slice(0, 60) : 'Error';
      labelCls = 'text-state-error';
      break;
    case 'disabled':
      icon = <X size={12} className="text-text-dim" />;
      label = 'Disabled';
      labelCls = 'text-text-dim';
      break;
  }
  // Probe for write tools — used to color the diagnostics hint when a
  // server has read tools but no write tools (the classic Atlassian
  // read-only-scope symptom).
  const hasWriteTools = s.toolNames.some((t) => /write|create|update|delete|post|put|patch/i.test(t));
  const showWriteHint =
    s.status === 'connected' &&
    s.toolNames.length > 0 &&
    !hasWriteTools &&
    s.needsOAuth;
  return (
    <div className="rounded-md border border-border bg-bg/50 text-[12px]">
      <div
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-bg-hover/40"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <div className="shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-text truncate">{s.name}</div>
          <div className={clsx('text-[10px] truncate', labelCls)}>{label}</div>
        </div>
        {/* Sign in (retry-able) button is shown for any state where signing
            in makes sense: needs-auth (no tokens yet) and error (last
            sign-in attempt failed). For error we surface BOTH Sign in and
            Sign out — Sign in is the natural retry, Sign out is the
            "nuke saved state" escape hatch. The previous build was hiding
            the Sign in button on error, leaving the user stuck with only
            Sign out (which wipes tokens that might already be gone) and
            no way to retry the flow without restarting the app. */}
        {(s.status === 'needs-auth' || s.status === 'error') && s.needsOAuth && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSignIn();
            }}
            disabled={busy}
            className={clsx(
              'shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border',
              busy
                ? 'border-border text-text-dim'
                : 'border-state-attention/50 text-state-attention hover:bg-state-attention/10'
            )}
            title={
              s.status === 'error'
                ? `Retry sign-in for ${s.name}. The last attempt failed: ${s.error ?? 'unknown error'}.`
                : `Open your browser to sign in to ${s.name}. Tokens are saved locally.`
            }
          >
            {busy ? <Loader2 size={10} className="animate-spin" /> : <LogIn size={10} />}
            {busy ? 'Signing in…' : s.status === 'error' ? 'Retry' : 'Sign in'}
          </button>
        )}
        {(s.status === 'connected' || s.status === 'error') && s.needsOAuth && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSignOut();
            }}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-border text-text-dim hover:text-text hover:border-border-strong"
            title={`Clear saved OAuth tokens for ${s.name}. Use after editing scope in your .mcp.json so the next sign-in requests the new scopes, or after a failed sign-in to wipe stale state before retrying.`}
          >
            Sign out
          </button>
        )}
      </div>
      {expanded && (
        <div className="px-2 pb-2 pt-1 border-t border-border/60 space-y-1.5">
          <div className="text-[10px] text-text-dim">
            <span className="text-text-muted">source:</span>{' '}
            <code className="font-mono">{s.source}</code>
          </div>
          {s.needsOAuth && (
            <div className="text-[10px] text-text-dim">
              <span className="text-text-muted">configured scope:</span>{' '}
              {s.configuredScope ? (
                <code className="font-mono break-all">{s.configuredScope}</code>
              ) : (
                <span className="italic">
                  (none — using server defaults, may be read-only)
                </span>
              )}
            </div>
          )}
          {s.toolNames.length > 0 && (
            <div className="text-[10px] text-text-dim">
              <span className="text-text-muted">tools ({s.toolNames.length}):</span>{' '}
              <span className="font-mono">{s.toolNames.join(', ')}</span>
            </div>
          )}
          {showWriteHint && (
            <div className="text-[10px] text-state-attention bg-state-attention/5 border border-state-attention/30 rounded p-1.5">
              <strong>No write-looking tools exposed.</strong> If you expected
              to be able to write/create/update, the OAuth tokens may have
              been granted read-only scopes. Edit{' '}
              <code className="font-mono">~/.guycode/mcp.json</code> to add an
              explicit <code className="font-mono">oauth.scope</code>, then
              click "Sign out" and re-sign in.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  icon,
  label,
  hint,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-[12px] font-medium text-text mb-1">
        <span className="text-text-dim">{icon}</span>
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-[11px] text-text-dim leading-snug">{hint}</p>
      )}
    </div>
  );
}

/**
 * Multi-API-key management UI. Each key is an editable row with its own
 * daily budget. One row is the "Default" (marked with a Star) — that's
 * what new sessions inherit. Sessions can override their key via the
 * sidebar's right-click context menu.
 *
 * Adding a key reveals an inline form (key string, name, optional budget
 * caps). Editing a row toggles it into the same form layout. The same
 * keystroke-stopPropagation that the SessionContextMenu uses isn't
 * required here since the modal already swallows keyboard events at the
 * panel boundary.
 */
function ApiKeysSection({ keys }: { keys: ApiKey[] }) {
  const createKey = useApp((s) => s.createApiKey);
  const updateKey = useApp((s) => s.updateApiKey);
  const deleteKey = useApp((s) => s.deleteApiKey);
  const setDefault = useApp((s) => s.setDefaultApiKey);
  const resetAdjustment = useApp((s) => s.resetApiKeyBudgetAdjustment);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  return (
    <div className="pt-1 border-t border-border">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-text">
          <KeyRound size={14} className="text-text-dim" />
          API keys & budgets
        </div>
        <button
          onClick={() => {
            setAdding(true);
            setEditingId(null);
          }}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border border-border text-text-muted hover:text-text hover:bg-bg-hover"
          title="Add a new Anthropic API key"
        >
          <Plus size={12} />
          Add key
        </button>
      </div>
      <p className="text-[11px] text-text-dim leading-snug mb-2">
        Each key has its own daily budget. The
        <Star size={10} className="inline -mt-0.5 mx-0.5 text-state-attention" />
        is the default — new sessions inherit it. Right-click any
        session in the sidebar to switch which key it uses.
      </p>

      {keys.length === 0 && !adding && (
        <div className="text-[11px] text-text-dim italic px-2 py-3 border border-dashed border-border rounded-md">
          No API keys configured yet. Click <strong>Add key</strong> to
          paste your first sk-ant-... key.
        </div>
      )}

      <div className="space-y-1.5">
        {keys.map((k) =>
          editingId === k.id ? (
            <KeyEditor
              key={k.id}
              initial={k}
              busy={busyId === k.id}
              onCancel={() => setEditingId(null)}
              onSave={async (patch) => {
                setBusyId(k.id);
                try {
                  const ok = await updateKey(k.id, patch);
                  if (ok) setEditingId(null);
                  return ok;
                } finally {
                  setBusyId(null);
                }
              }}
            />
          ) : (
            <KeyRow
              key={k.id}
              k={k}
              busy={busyId === k.id}
              onEdit={() => {
                setEditingId(k.id);
                setAdding(false);
              }}
              onMakeDefault={async () => {
                setBusyId(k.id);
                try {
                  await setDefault(k.id);
                } finally {
                  setBusyId(null);
                }
              }}
              onDelete={async () => {
                if (
                  !window.confirm(
                    `Delete API key "${k.name}"?\n\nThis is irreversible. Sessions currently bound to this key will fall back to the default key on their next turn.`
                  )
                ) {
                  return;
                }
                setBusyId(k.id);
                try {
                  await deleteKey(k.id);
                } finally {
                  setBusyId(null);
                }
              }}
              onResetAdjustment={async () => {
                if (
                  !window.confirm(
                    `Reset accumulated overages/underages for "${k.name}"?\n\nThis zeros out the carry-over adjustment that rolls unused or overspent budget between hours. Historical spend totals are NOT deleted — only the rolling adjustment is cleared, so the next hour starts fresh at exactly daily / 24.`
                  )
                ) {
                  return;
                }
                setBusyId(k.id);
                try {
                  await resetAdjustment(k.id);
                } finally {
                  setBusyId(null);
                }
              }}
            />
          )
        )}
        {adding && (
          <KeyEditor
            initial={null}
            busy={false}
            onCancel={() => setAdding(false)}
            onSave={async (patch) => {
              if (!patch.plain || !patch.plain.trim()) return false;
              const id = await createKey({
                name: patch.name ?? 'API key',
                plain: patch.plain,
                dailyBudgetUsd: patch.dailyBudgetUsd ?? null,
                setDefault: keys.length === 0,
                activeHourStart: patch.activeHourStart,
                activeHourEnd: patch.activeHourEnd,
              });
              if (id) setAdding(false);
              return !!id;
            }}
          />
        )}
      </div>
    </div>
  );
}

function KeyRow({
  k,
  busy,
  onEdit,
  onMakeDefault,
  onDelete,
  onResetAdjustment,
}: {
  k: ApiKey;
  busy: boolean;
  onEdit: () => void;
  onMakeDefault: () => void;
  onDelete: () => void;
  onResetAdjustment: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border bg-bg/40">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[12px] text-text">
          {k.is_default && (
            <Star
              size={11}
              className="text-state-attention shrink-0"
              fill="currentColor"
              aria-label="default key"
            />
          )}
          <span className="truncate font-medium">{k.name}</span>
          {k.preview && (
            <span className="text-[10px] font-mono text-text-dim truncate">
              {k.preview}
            </span>
          )}
        </div>
        <div className="text-[10px] font-mono text-text-dim">
          {k.daily_budget_usd != null
            ? `daily $${k.daily_budget_usd.toFixed(2)}`
            : 'no daily cap'}
          {formatActiveHoursSuffix(
            k.active_hour_start,
            k.active_hour_end
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {!k.is_default && (
          <button
            onClick={onMakeDefault}
            disabled={busy}
            className="px-1.5 py-0.5 text-[10px] rounded border border-border text-text-dim hover:text-state-attention hover:border-state-attention/40"
            title="Make this the default for new sessions"
          >
            Set default
          </button>
        )}
        <button
          onClick={onResetAdjustment}
          disabled={busy}
          className="p-1 rounded text-text-dim hover:text-text hover:bg-bg-hover"
          title="Reset accumulated hourly overages/underages (clean slate; spend history untouched)"
        >
          <RotateCcw size={11} />
        </button>
        <button
          onClick={onEdit}
          disabled={busy}
          className="p-1 rounded text-text-dim hover:text-text hover:bg-bg-hover"
          title="Edit name / budget / key"
        >
          <Edit3 size={11} />
        </button>
        <button
          onClick={onDelete}
          disabled={busy}
          className="p-1 rounded text-text-dim hover:text-state-error hover:bg-state-error/10"
          title="Delete this key"
        >
          {busy ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Trash2 size={11} />
          )}
        </button>
      </div>
    </div>
  );
}

interface KeyEditorPatch {
  name?: string;
  plain?: string;
  dailyBudgetUsd?: number | null;
  /**
   * Active-hours window. Integers in [0..23]. Both undefined leaves
   * the row untouched. Both equal (including 0/0) = all-day default.
   * Sent on every Save — the renderer doesn't try to figure out if
   * the value changed; the DB UPDATE is a cheap no-op when it didn't.
   */
  activeHourStart?: number;
  activeHourEnd?: number;
}

/**
 * Format the active-hours window for display next to the daily budget,
 * e.g. "  ·  9–17" or "  ·  22–6 (overnight)". Returns empty string
 * for the all-day default (start == end) so existing keys with the
 * 0/0 migration default don't grow a noisy badge.
 */
function formatActiveHoursSuffix(start: number, end: number): string {
  if (start === end) return '';
  const wraps = start > end;
  return `  ·  ${start}–${end}${wraps ? ' (overnight)' : ''}`;
}

/**
 * Parse a hour-of-day input string into an integer in [0..23].
 * Empty / whitespace returns 0 (= the all-day default sentinel).
 * Non-numeric / out-of-range returns null so the caller can surface
 * a validation error instead of silently clamping.
 */
function parseHourInput(raw: string): number | null {
  const t = raw.trim();
  if (!t) return 0;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < 0 || i > 23) return null;
  return i;
}

function KeyEditor({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  /** Null for an Add form, an ApiKey row for an Edit form. */
  initial: ApiKey | null;
  busy: boolean;
  onSave: (patch: KeyEditorPatch) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [plain, setPlain] = useState('');
  const [daily, setDaily] = useState<string>(
    initial?.daily_budget_usd != null ? String(initial.daily_budget_usd) : ''
  );
  // Active-hours window inputs. Stored as strings so the user can
  // freely backspace / type; we parse + validate in `onClickSave`.
  // Default of empty maps to 0 (the "all-day" sentinel) when both
  // ends are blank — see `parseHourInput`.
  const [activeStart, setActiveStart] = useState<string>(
    initial && initial.active_hour_start !== 0
      ? String(initial.active_hour_start)
      : ''
  );
  const [activeEnd, setActiveEnd] = useState<string>(
    initial && initial.active_hour_end !== 0
      ? String(initial.active_hour_end)
      : ''
  );
  const [err, setErr] = useState<string | null>(null);

  const isAdd = initial === null;

  const onClickSave = async () => {
    setErr(null);
    const patch: KeyEditorPatch = {};
    if (name.trim() && name.trim() !== initial?.name) patch.name = name.trim();
    if (plain.trim()) {
      if (!plain.trim().startsWith('sk-')) {
        setErr("API key must start with 'sk-'.");
        return;
      }
      patch.plain = plain.trim();
    } else if (isAdd) {
      setErr('Paste an sk-ant-... key to create.');
      return;
    }
    // Empty input means "no cap" (null). Otherwise parse as a positive
    // number. NaN / negative falls back to null with a friendly message
    // rather than silently storing garbage.
    const dailyTrim = daily.trim();
    if (dailyTrim) {
      const n = Number(dailyTrim);
      if (!Number.isFinite(n) || n < 0) {
        setErr('Daily budget must be a positive number (or blank).');
        return;
      }
      patch.dailyBudgetUsd = n > 0 ? n : null;
    } else {
      patch.dailyBudgetUsd = null;
    }
    // Active-hours validation. Both inputs must be integer hours in
    // [0..23] (or blank — blank means 0 = the all-day sentinel). If
    // only one end is filled out, that's almost certainly a user
    // error (window with a single endpoint is meaningless), so we
    // surface an error rather than silently substituting 0 for the
    // other end.
    const aStart = parseHourInput(activeStart);
    const aEnd = parseHourInput(activeEnd);
    if (aStart === null || aEnd === null) {
      setErr('Active hours must each be an integer 0–23 (or blank).');
      return;
    }
    if (
      (activeStart.trim() !== '' && activeEnd.trim() === '') ||
      (activeStart.trim() === '' && activeEnd.trim() !== '')
    ) {
      setErr(
        'Set BOTH active-hours start and end, or leave both blank for all-day.'
      );
      return;
    }
    patch.activeHourStart = aStart;
    patch.activeHourEnd = aEnd;
    const ok = await onSave(patch);
    if (!ok) {
      setErr(
        isAdd
          ? 'Could not create the key — see DevTools console for details.'
          : 'Could not update the key — see DevTools console for details.'
      );
    }
  };

  return (
    <div className="rounded-md border border-accent/40 bg-bg-elevated/50 px-2.5 py-2 space-y-1.5">
      <div className="text-[10px] uppercase tracking-wider text-text-dim font-mono">
        {isAdd ? 'Add API key' : `Edit "${initial?.name ?? ''}"`}
      </div>
      <div className="flex gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (e.g. Work)"
          className="flex-1 rounded border border-border bg-bg px-2 py-1 text-[12px] text-text focus:outline-none focus:border-accent"
        />
      </div>
      <input
        type="password"
        value={plain}
        onChange={(e) => setPlain(e.target.value)}
        placeholder={isAdd ? 'sk-ant-...' : 'Leave blank to keep current key, or paste a new one'}
        className="w-full rounded border border-border bg-bg px-2 py-1 text-[12px] font-mono text-text focus:outline-none focus:border-accent"
      />
      <div className="flex gap-1.5">
        <input
          inputMode="decimal"
          value={daily}
          onChange={(e) => setDaily(e.target.value)}
          placeholder="Daily $ (blank = no cap)"
          className="flex-1 rounded border border-border bg-bg px-2 py-1 text-[12px] font-mono text-text focus:outline-none focus:border-accent"
          title="Daily budget in USD for this key. When today's spend on this key hits the cap, new turns pause until the next local-day rollover (or until you raise the cap). Blank = no governor (unlimited)."
        />
      </div>
      {/* Active-hours window. The daily budget gets redistributed
          across the configured window instead of being spread evenly
          over 24 hours — useful when the user only wants the agent
          to spend during business hours, or only overnight, etc.
          Leaving both fields blank keeps v0.1.3 behavior (daily / 24
          per hour, all day). The help text below the inputs
          enumerates the worked examples so the wrap-around case
          (start > end) isn't surprising. */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-text-dim font-mono mb-1">
          Active hours
        </div>
        <div className="flex items-center gap-1.5">
          <input
            inputMode="numeric"
            value={activeStart}
            onChange={(e) => setActiveStart(e.target.value)}
            placeholder="start"
            className="w-16 rounded border border-border bg-bg px-2 py-1 text-[12px] font-mono text-text focus:outline-none focus:border-accent"
            title="Hour-of-day [0..23] when the active window begins (local time)."
          />
          <span className="text-[11px] text-text-dim">to</span>
          <input
            inputMode="numeric"
            value={activeEnd}
            onChange={(e) => setActiveEnd(e.target.value)}
            placeholder="end"
            className="w-16 rounded border border-border bg-bg px-2 py-1 text-[12px] font-mono text-text focus:outline-none focus:border-accent"
            title="Hour-of-day [0..23] when the active window ends (half-open: this hour is the first INACTIVE one)."
          />
          <span className="text-[10px] text-text-dim leading-snug">
            blank = all day (default)
          </span>
        </div>
        <div className="mt-1 text-[10px] text-text-dim leading-snug">
          Spreads the daily budget over the hours from{' '}
          <span className="font-mono">start</span> to{' '}
          <span className="font-mono">end</span> instead of all 24
          hours. Outside the window the per-hour base is $0 (but any
          banked underspend is still usable, and Force Resume still
          works). Half-open: the
          <span className="font-mono"> end</span> hour itself is the
          first inactive one. Examples:{' '}
          <span className="font-mono">9–17</span> = 9am–5pm (8h),{' '}
          <span className="font-mono">22–6</span> = 10pm–6am wraps
          midnight (8h).
        </div>
      </div>
      {err && (
        <div className="text-[10px] text-state-error">{err}</div>
      )}
      <div className="flex justify-end gap-1">
        <button
          onClick={onCancel}
          className="px-2 py-0.5 text-[11px] text-text-muted hover:text-text rounded hover:bg-bg-hover"
        >
          Cancel
        </button>
        <button
          onClick={onClickSave}
          disabled={busy}
          className={clsx(
            'px-2 py-0.5 text-[11px] rounded inline-flex items-center gap-1',
            busy
              ? 'bg-bg-hover text-text-dim'
              : 'bg-accent text-white hover:bg-accent-dim'
          )}
        >
          {busy && <Loader2 size={10} className="animate-spin" />}
          {isAdd ? 'Add' : 'Save'}
        </button>
      </div>
    </div>
  );
}
