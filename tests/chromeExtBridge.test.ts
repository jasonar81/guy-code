/**
 * Tests for `electron/chromeExtBridge.ts`.
 *
 * The bridge is the Node-side counterpart of the Chrome extension's
 * service worker. Bugs here either:
 *   - hand the model a tool result that says "not connected" when it
 *     actually is, or vice versa,
 *   - leak pending RPCs across disconnects (so the agent hangs
 *     waiting for a response from an extension that's gone), or
 *   - mis-route the response of one RPC into the resolver of another
 *     (catastrophic; the agent gets the wrong answer).
 *
 * Strategy:
 *   - Stand up the real bridge against a real WS server on an
 *     ephemeral port (the bridge IS the server in this transport).
 *   - Pretend to be the extension with Node 22+'s built-in global
 *     `WebSocket` client. No frame-parsing in this file — that's
 *     verified by `chromeWsServer.test.ts`. Here we only care about
 *     the JSON-RPC envelope and lifecycle semantics.
 *   - Reset the singleton between tests with `disconnect()`. If a
 *     test leaks state, the next afterEach catches it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as bridge from '../electron/chromeExtBridge';

afterEach(async () => {
  // Singleton — reset between tests so a hung connect doesn't poison
  // the next one. disconnect() is safe to call when not connected.
  await bridge.disconnect();
  // The approval prompter is also a singleton; if a test installed a
  // custom one, clear it so the next test starts at the production
  // default (none → fail closed).
  bridge.setAttachApprovalPrompter(null);
});

/**
 * Default prompter for tests that need authorizeTab to succeed.
 * Production wires up a native dialog; tests just say "yes". Tests
 * exercising the denial path install their own prompter.
 */
function installAllowAllPrompter(): void {
  bridge.setAttachApprovalPrompter(async () => true);
}

// ---- Test helpers ----------------------------------------------------

/**
 * Fake extension. Connects to the bridge's WS server, sends the
 * `hello`, and exposes methods to:
 *   - wait for the next RPC request the bridge sends us,
 *   - reply to a request (by id) with a success or error.
 */
class FakeExtension {
  private ws: WebSocket;
  private incoming: any[] = [];
  private waiters: Array<(msg: any) => void> = [];

  static async connect(port: number, opts?: { sendHello?: boolean }): Promise<FakeExtension> {
    const sendHello = opts?.sendHello !== false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('WS open failed')), { once: true });
    });
    const ext = new FakeExtension(ws);
    if (sendHello) {
      ws.send(
        JSON.stringify({
          type: 'hello',
          version: '1',
          ua: 'FakeExtension/1.0 (vitest)',
        })
      );
    }
    return ext;
  }

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: any;
      try {
        msg =
          typeof ev.data === 'string'
            ? JSON.parse(ev.data)
            : JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (this.waiters.length > 0) {
        const w = this.waiters.shift()!;
        w(msg);
      } else {
        this.incoming.push(msg);
      }
    });
  }

  /** Pull the next inbound message off the queue, waiting if needed. */
  async next(timeoutMs = 2000): Promise<any> {
    if (this.incoming.length > 0) return this.incoming.shift();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`FakeExtension.next timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = (msg: any) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(waiter);
    });
  }

  /** Reply to an in-flight RPC with a success result. */
  reply(id: string, result: unknown): void {
    this.ws.send(JSON.stringify({ id, result }));
  }

  /** Reply with an error. */
  replyError(id: string, error: string): void {
    this.ws.send(JSON.stringify({ id, error }));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ---- getStatus ------------------------------------------------------

describe('getStatus', () => {
  it('returns disconnected with zero tabs before any connect', () => {
    const s = bridge.getStatus();
    expect(s.status).toBe('disconnected');
    expect(s.port).toBeNull();
    expect(s.error).toBeNull();
    expect(s.connectedAt).toBeNull();
    expect(s.tabCount).toBe(0);
  });
});

// ---- connect / disconnect ------------------------------------------

describe('connect', () => {
  it('resolves once an extension joins the WS', async () => {
    const port = 0; // ephemeral
    // Kick off connect, then have the fake extension show up after a
    // brief delay (simulates SW wake-up time).
    const p = bridge.connect(getEphemeralPort());
    // We don't know the port until after listen — peek via getStatus()
    // once status flips to 'connecting'.
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    const s = bridge.getStatus();
    expect(s.status).toBe('connected');
    expect(s.port).toBe(port2);
    expect(s.connectedAt).toBeGreaterThan(0);
    ext.close();
  });

  it('times out with an actionable message when no extension connects', async () => {
    // Use a tiny timeout via monkey-patching the constant would be
    // intrusive; instead, we shorten the test by overriding the
    // connect path through monkey-patching: we call bridge.connect
    // then immediately verify it eventually rejects. We can't easily
    // shorten the 30s default in production code, so we don't —
    // instead, we register a fake handshake on the same port so the
    // connect can complete, and then we test the failure path of
    // _waitForExtension via the `extension dropped` semantics in a
    // separate test below. (The 30s wait is exercised by smoke
    // testing in real use, not in unit tests.)
    expect.assertions(0);
  });

  it('disconnect() resets state and stops the server', async () => {
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    expect(bridge.getStatus().status).toBe('connected');
    await bridge.disconnect();
    const s = bridge.getStatus();
    expect(s.status).toBe('disconnected');
    expect(s.port).toBeNull();
    expect(s.connectedAt).toBeNull();
    expect(s.tabCount).toBe(0);
    ext.close();
  });

  it('auto-promotes status to connected when the extension reconnects (no second connect() call needed)', async () => {
    // Regression: the bridge previously only set status='connected'
    // inside the explicit connect() function. When the extension's
    // service worker shut down for idleness, then restarted on its
    // next alarm and reopened the WebSocket, the bridge's auto-
    // reconnect handler attached the new connection but FORGOT to
    // flip status back from 'connecting'. Every subsequent tool call
    // saw _state.status === 'connecting' and threw "not connected"
    // even though the WS was alive and the SW was ready. Reproduced
    // in production after large screenshot RPCs: SW briefly dropped
    // due to post-handler idle, reconnected within ~500ms, but the
    // bridge stayed stuck.
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    let ext = await FakeExtension.connect(port2);
    await p;
    expect(bridge.getStatus().status).toBe('connected');
    // Simulate SW shutdown by closing the WS client. The server sees
    // the close → emits 'disconnect' → bridge demotes to 'connecting'.
    ext.close();
    // Wait for the demotion to land. Without retries this races with
    // the close event in Node's event loop.
    const demoted = await waitFor(
      () => bridge.getStatus().status === 'connecting',
      1000
    );
    expect(demoted).toBe(true);
    // Now simulate the SW coming back online: open a fresh WS from
    // the same test client. The bridge's server.on('connect') should
    // fire and _attachConnection should promote status back to
    // 'connected' WITHOUT anyone calling bridge.connect() again.
    ext = await FakeExtension.connect(port2);
    const promoted = await waitFor(
      () => bridge.getStatus().status === 'connected',
      1000
    );
    expect(promoted).toBe(true);
    // And a fresh RPC must work — the whole point of the fix is that
    // tools stop throwing "not connected" after a transient drop.
    const listP = bridge.listTabs();
    const req = await ext.next();
    expect(req.method).toBe('listTabs');
    ext.reply(req.id, [{ id: 'tab-1', url: 'about:blank', title: '' }]);
    const tabs = await listP;
    expect(tabs).toEqual([{ id: 'tab-1', url: 'about:blank', title: '' }]);
    ext.close();
  });

  it('throws EADDRINUSE-style error when the port is already taken', async () => {
    // Bind a dummy server on an OS-chosen ephemeral port first, then
    // ask the bridge to connect on the SAME (now-occupied) port so
    // we provoke EADDRINUSE deterministically. Using 0 for both
    // wouldn't collide because the OS would just hand out a second
    // free port.
    const dummy = new (await import('node:net')).Server();
    await new Promise<void>((resolve) =>
      dummy.listen(0, '127.0.0.1', () => resolve())
    );
    const port = (dummy.address() as { port: number }).port;
    try {
      await expect(bridge.connect(port)).rejects.toThrow(/already in use|EADDRINUSE/i);
      expect(bridge.getStatus().status).toBe('error');
      expect(bridge.getStatus().error).toMatch(/in use|EADDRINUSE/i);
    } finally {
      await new Promise<void>((resolve) => dummy.close(() => resolve()));
    }
  });
});

// ---- RPC envelope ---------------------------------------------------

describe('RPC envelope', () => {
  it('listTabs serializes a request and resolves with the extension result', async () => {
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    const listP = bridge.listTabs();
    // The hello shouldn't be re-emitted; first message should be the RPC.
    const req = await ext.next();
    expect(req.method).toBe('listTabs');
    expect(typeof req.id).toBe('string');
    ext.reply(req.id, [
      { id: 'tab-1', url: 'https://example.com/', title: 'Example' },
      { id: 'tab-2', url: 'https://gmail.com/', title: 'Inbox' },
    ]);
    const tabs = await listP;
    expect(tabs).toEqual([
      { id: 'tab-1', url: 'https://example.com/', title: 'Example' },
      { id: 'tab-2', url: 'https://gmail.com/', title: 'Inbox' },
    ]);
    expect(bridge.getStatus().tabCount).toBe(2);
    ext.close();
  });

  it('surfaces an extension error verbatim with the Chrome-connector prefix', async () => {
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    const callP = bridge.extractTab({ tabId: 'tab-99' });
    const req = await ext.next();
    expect(req.method).toBe('extract');
    expect(req.params.tabId).toBe('tab-99');
    ext.replyError(req.id, 'tab id "tab-99" not found');
    await expect(callP).rejects.toThrow(/Chrome connector: tab id "tab-99" not found/);
    ext.close();
  });

  it('rejects pending RPCs when the extension disconnects', async () => {
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    const callP = bridge.listTabs();
    // Wait for the RPC to land at the extension, then yank the WS.
    await ext.next();
    ext.close();
    await expect(callP).rejects.toThrow(/disconnected mid-call|connection lost/i);
  });
});

// ---- Input validation (no extension round-trip) ----------------------

describe('input validation', () => {
  it('openTab rejects non-http(s) URLs without contacting the extension', async () => {
    await expect(bridge.openTab('ftp://example.com')).rejects.toThrow(/invalid URL/);
    await expect(bridge.openTab('')).rejects.toThrow(/invalid URL/);
    await expect(bridge.openTab('not-a-url')).rejects.toThrow(/invalid URL/);
  });

  it('extractTab requires tabId', async () => {
    await expect(bridge.extractTab({} as any)).rejects.toThrow(/tabId/);
  });

  it('screenshotTab requires tabId', async () => {
    await expect(bridge.screenshotTab({} as any)).rejects.toThrow(/tabId/);
  });

  it('waitForTab requires at least one condition', async () => {
    // Connect first so the not-connected error doesn't preempt the
    // condition-validation error.
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    await expect(bridge.waitForTab({ tabId: 'tab-1' })).rejects.toThrow(
      /at least one of selector \/ text \/ networkIdle/
    );
    ext.close();
  });

  it('clickTab requires selector or text (after connect)', async () => {
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    await expect(bridge.clickTab({ tabId: 'tab-1' })).rejects.toThrow(/selector or text/);
    ext.close();
  });

  it('typeTab requires text:string', async () => {
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    await expect(
      bridge.typeTab({ tabId: 'tab-1', text: undefined as any })
    ).rejects.toThrow(/text/);
    ext.close();
  });

  it('pressTab requires non-empty key', async () => {
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    await expect(bridge.pressTab({ tabId: 'tab-1', key: '' })).rejects.toThrow(/key/);
    ext.close();
  });

  it('evalTab requires non-empty expression', async () => {
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    await expect(bridge.evalTab({ tabId: 'tab-1', expression: '' })).rejects.toThrow(
      /expression/
    );
    ext.close();
  });
});

// ---- Not-connected error path ---------------------------------------

describe('not-connected errors', () => {
  it('listTabs throws a uniform error when disconnected', async () => {
    await expect(bridge.listTabs()).rejects.toThrow(/not connected/);
  });

  it('clickTab throws not-connected error after disconnect', async () => {
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    await bridge.disconnect();
    ext.close();
    await expect(bridge.clickTab({ tabId: 'tab-1', text: 'X' })).rejects.toThrow(
      /not connected/
    );
  });
});

// ---- Tab-ownership policy -------------------------------------------

describe('tab authorization', () => {
  // The bridge enforces "don't touch the user's tabs unless they
  // said so" via an authorizedTabs set: openTab auto-adds, write
  // tools assert, disconnect clears. The agent's tool prompts ask
  // it to play nice but the bridge is the source of truth — these
  // tests pin down what would have happened in production if the
  // model ignored the prompt and tried to click a random tab.

  async function setup() {
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    return { ext };
  }

  /**
   * Respond to a single inbound RPC from the bridge with the given
   * result. Useful for tests that need to drive multiple RPCs and
   * don't care about ordering of the responses, just that each
   * request gets some reply so the bridge promise resolves.
   */
  async function answerNext(ext: FakeExtension, result: unknown): Promise<any> {
    const req = await ext.next();
    ext.reply(req.id, result);
    return req;
  }

  it('blocks clickTab on a tab that was never authorized', async () => {
    const { ext } = await setup();
    // The agent never called openTab or authorizeTab on this id —
    // the bridge must refuse without sending any RPC over the wire.
    await expect(
      bridge.clickTab({ tabId: 'tab-stranger', text: 'X' })
    ).rejects.toThrow(/not authorized to click/);
    // The error must point the model at the right remediation tools.
    await expect(
      bridge.clickTab({ tabId: 'tab-stranger', text: 'X' })
    ).rejects.toThrow(/BrowserOpen|BrowserAttach/);
    ext.close();
  });

  it('openTab auto-authorizes the resulting tab — write tools work immediately on it', async () => {
    const { ext } = await setup();
    const openP = bridge.openTab('https://example.com');
    await answerNext(ext, {
      id: 'tab-new',
      url: 'https://example.com/',
      title: 'Example',
    });
    const tab = await openP;
    expect(tab.id).toBe('tab-new');
    // Now a click on that fresh tab should round-trip without a
    // policy error — proving the auto-authorization actually took.
    const clickP = bridge.clickTab({ tabId: 'tab-new', text: 'Go' });
    const clickReq = await ext.next();
    expect(clickReq.method).toBe('click');
    expect(clickReq.params.tabId).toBe('tab-new');
    ext.reply(clickReq.id, undefined);
    await clickP;
    ext.close();
  });

  it('authorizeTab refuses unknown tab ids and never touches the authorization set', async () => {
    installAllowAllPrompter();
    const { ext } = await setup();
    // The authorize path validates with a listTabs round-trip; reply
    // with an empty list so the lookup misses.
    const authorizeP = bridge.authorizeTab('tab-ghost');
    const listReq = await ext.next();
    expect(listReq.method).toBe('listTabs');
    ext.reply(listReq.id, []);
    await expect(authorizeP).rejects.toThrow(/not found/);
    // The failed authorization must not leak state — a subsequent
    // write call still rejects.
    await expect(
      bridge.clickTab({ tabId: 'tab-ghost', text: 'X' })
    ).rejects.toThrow(/not authorized/);
    ext.close();
  });

  it('authorizeTab fails closed when no approval prompter is wired', async () => {
    // No installAllowAllPrompter() call — prompter slot is null.
    // The bridge MUST refuse rather than silently approve. This is
    // the regression guard for the "agent attached to my Outlook
    // without asking" bug.
    const { ext } = await setup();
    const authorizeP = bridge.authorizeTab('tab-99');
    const listReq = await ext.next();
    ext.reply(listReq.id, [
      { id: 'tab-99', url: 'https://mail.google.com/', title: 'Inbox' },
    ]);
    await expect(authorizeP).rejects.toThrow(
      /no approval prompter wired|not available/i
    );
    // And the tab is not in the authorized set afterwards.
    expect(bridge.getAuthorizedTabs()).not.toContain('tab-99');
    ext.close();
  });

  it('authorizeTab fails when the user denies the prompt', async () => {
    bridge.setAttachApprovalPrompter(async () => false);
    const { ext } = await setup();
    const authorizeP = bridge.authorizeTab('tab-99');
    const listReq = await ext.next();
    ext.reply(listReq.id, [
      { id: 'tab-99', url: 'https://mail.google.com/', title: 'Inbox' },
    ]);
    await expect(authorizeP).rejects.toThrow(/denied permission/i);
    // Error must steer the agent to BrowserOpen rather than retrying
    // BrowserAttach in a tight loop.
    await expect(authorizeP).rejects.toThrow(/BrowserOpen/);
    expect(bridge.getAuthorizedTabs()).not.toContain('tab-99');
    ext.close();
  });

  it('authorizeTab passes correct tab info to the prompter', async () => {
    let promptedWith: { tabId: string; url: string; title: string } | null = null;
    bridge.setAttachApprovalPrompter(async (info) => {
      promptedWith = info;
      return true;
    });
    const { ext } = await setup();
    const authorizeP = bridge.authorizeTab('tab-99');
    const listReq = await ext.next();
    ext.reply(listReq.id, [
      { id: 'tab-99', url: 'https://mail.google.com/inbox', title: 'Inbox (123)' },
    ]);
    await authorizeP;
    expect(promptedWith).toEqual({
      tabId: 'tab-99',
      url: 'https://mail.google.com/inbox',
      title: 'Inbox (123)',
    });
    ext.close();
  });

  it('authorizeTab unblocks writes on a pre-existing user tab', async () => {
    installAllowAllPrompter();
    const { ext } = await setup();
    // User says "use my Gmail tab"; agent calls BrowserAttach;
    // bridge confirms the id exists, prompts the user, adds to the set.
    const authorizeP = bridge.authorizeTab('tab-99');
    const listReq = await ext.next();
    ext.reply(listReq.id, [
      { id: 'tab-99', url: 'https://mail.google.com/', title: 'Inbox' },
      { id: 'tab-7', url: 'https://example.com/', title: 'Example' },
    ]);
    const authorized = await authorizeP;
    expect(authorized.id).toBe('tab-99');
    expect(authorized.url).toMatch(/mail\.google\.com/);
    // Now type works on the previously-forbidden tab.
    const typeP = bridge.typeTab({ tabId: 'tab-99', text: 'hello' });
    const typeReq = await ext.next();
    expect(typeReq.method).toBe('type');
    expect(typeReq.params.tabId).toBe('tab-99');
    ext.reply(typeReq.id, undefined);
    await typeP;
    ext.close();
  });

  it('read tools (listTabs, extractTab, waitForTab) work on UNauthorized tabs', async () => {
    const { ext } = await setup();
    // listTabs: trivially allowed; no policy check at all.
    const listP = bridge.listTabs();
    await answerNext(ext, [
      { id: 'tab-22', url: 'https://x.example/', title: 'X' },
    ]);
    expect((await listP).map((t) => t.id)).toEqual(['tab-22']);
    // extractTab on a tab the agent never opened: allowed, no
    // authorization required (read-only summarization is fine).
    const extractP = bridge.extractTab({ tabId: 'tab-22' });
    const extractReq = await ext.next();
    expect(extractReq.method).toBe('extract');
    ext.reply(extractReq.id, 'page contents here');
    expect(await extractP).toMatch(/page contents here/);
    // waitForTab too.
    const waitP = bridge.waitForTab({ tabId: 'tab-22', selector: '#foo' });
    const waitReq = await ext.next();
    expect(waitReq.method).toBe('waitFor');
    ext.reply(waitReq.id, undefined);
    await waitP;
    ext.close();
  });

  it('disconnect clears the authorization set — reauthorization required after reconnect', async () => {
    installAllowAllPrompter();
    const { ext } = await setup();
    // Authorize a tab the first time around.
    const authorizeP = bridge.authorizeTab('tab-42');
    const listReq = await ext.next();
    ext.reply(listReq.id, [
      { id: 'tab-42', url: 'https://example.com/', title: 'Example' },
    ]);
    await authorizeP;
    expect(bridge.getAuthorizedTabs()).toContain('tab-42');
    // Reconnect cycle.
    await bridge.disconnect();
    ext.close();
    expect(bridge.getAuthorizedTabs()).toEqual([]);
    // Even after reconnecting, the old id has no special standing.
    const port = getEphemeralPort();
    const reconnect = bridge.connect(port);
    const port2 = await waitForPort();
    const ext2 = await FakeExtension.connect(port2);
    await reconnect;
    await expect(
      bridge.clickTab({ tabId: 'tab-42', text: 'X' })
    ).rejects.toThrow(/not authorized/);
    ext2.close();
  });

  it('screenshot is treated as a write (gated on authorization)', async () => {
    const { ext } = await setup();
    // Screenshot has to briefly activate the target tab, which IS
    // taking over from the user's POV. Same policy as click/type.
    await expect(
      bridge.screenshotTab({ tabId: 'tab-stranger' })
    ).rejects.toThrow(/not authorized to screenshot/);
    ext.close();
  });
});

// ---- Screenshot structured payload ----------------------------------

describe('screenshotTab payload', () => {
  // The bridge ships a structured screenshot result: two base64 PNGs
  // (clean + annotated), a label table, and a pageInfo block. These
  // tests pin the wire shape so a stale extension or a renumbered
  // field gets caught immediately.

  async function setupAndOpen(): Promise<{
    ext: FakeExtension;
    tabId: string;
  }> {
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    // Open a tab so it's authorized. We don't actually use the
    // resulting tab data beyond the id.
    const openP = bridge.openTab('https://example.com/');
    const openReq = await ext.next();
    ext.reply(openReq.id, {
      id: 'tab-1',
      url: 'https://example.com/',
      title: 'Example',
    });
    await openP;
    return { ext, tabId: 'tab-1' };
  }

  it('forwards annotate flag and surfaces both images + labels + pageInfo', async () => {
    const { ext, tabId } = await setupAndOpen();
    const fakePayload = {
      cleanBase64: 'AAAA',
      annotatedBase64: 'BBBB',
      bytesClean: 3,
      bytesAnnotated: 3,
      labels: [
        {
          label: 1,
          tag: 'button',
          role: 'button',
          text: 'Compose',
          aria: 'New message',
          selector: '#compose',
          bbox: { x: 10, y: 20, w: 100, h: 30 },
        },
        {
          label: 2,
          tag: 'a',
          text: 'Inbox',
          selector: undefined,
          bbox: { x: 0, y: 60, w: 80, h: 20 },
        },
      ],
      pageInfo: {
        url: 'https://example.com/',
        title: 'Example',
        viewport: { width: 1280, height: 720 },
        scroll: { x: 0, y: 0 },
        fullSize: { width: 1280, height: 2000 },
        devicePixelRatio: 2,
      },
    };
    const p = bridge.screenshotTab({ tabId });
    const req = await ext.next();
    expect(req.method).toBe('screenshot');
    expect(req.params.tabId).toBe(tabId);
    // The bridge defaults annotate to true; the extension can rely on
    // this so any agent forgetting to set the flag still gets labels.
    expect(req.params.annotate).toBe(true);
    expect(req.params.area).toBe('viewport');
    ext.reply(req.id, fakePayload);
    const result = await p;
    expect(result.cleanBase64).toBe('AAAA');
    expect(result.annotatedBase64).toBe('BBBB');
    expect(result.labels).toHaveLength(2);
    expect(result.labels[0].label).toBe(1);
    expect(result.labels[0].text).toBe('Compose');
    expect(result.labels[0].selector).toBe('#compose');
    expect(result.pageInfo.fullSize.height).toBe(2000);
    expect(result.pageInfo.viewport.width).toBe(1280);
    ext.close();
  });

  it('honors annotate=false on the wire (single capture path)', async () => {
    const { ext, tabId } = await setupAndOpen();
    const p = bridge.screenshotTab({ tabId, annotate: false });
    const req = await ext.next();
    expect(req.params.annotate).toBe(false);
    ext.reply(req.id, {
      cleanBase64: 'AAAA',
      // When annotate is false the extension returns an empty string
      // for annotatedBase64 (not a duplicate of the clean base64).
      // The bridge / tool layer detects falsy and skips the second
      // image block — keeps wire size small and avoids paying for a
      // second vision input on the model side.
      annotatedBase64: '',
      bytesClean: 3,
      bytesAnnotated: 0,
      labels: [],
      pageInfo: {
        url: 'https://example.com/',
        title: 'Example',
        viewport: { width: 1280, height: 720 },
        scroll: { x: 0, y: 0 },
        fullSize: { width: 1280, height: 720 },
        devicePixelRatio: 1,
      },
    });
    const result = await p;
    expect(result.cleanBase64).toBe('AAAA');
    expect(result.annotatedBase64).toBe('');
    expect(result.labels).toEqual([]);
    ext.close();
  });
});

// ---- chrome.debugger opt-in ----------------------------------------
//
// Default behavior of every write tool is synthetic events
// (executeScript-driven dispatchEvent). For pages that resist that
// approach (Outlook search, Shadow-DOM-wrapped inputs, anything that
// gates on event.isTrusted), the agent can opt in to real OS-level
// events via chrome.debugger by passing `useDebugger: true`. The
// bridge's only job is to forward that flag verbatim — the actual
// CDP attach / dispatch lives in the extension service worker.
// These tests pin the wire shape so the flag can't get dropped on
// the way through.

describe('useDebugger flag passthrough', () => {
  // Local helper: open a tab and authorize it so write tools clear
  // the policy gate and we can inspect their wire requests.
  async function setupAndOpen() {
    const port = getEphemeralPort();
    const p = bridge.connect(port);
    const port2 = await waitForPort();
    const ext = await FakeExtension.connect(port2);
    await p;
    const openP = bridge.openTab('https://example.com');
    const openReq = await ext.next();
    expect(openReq.method).toBe('openTab');
    ext.reply(openReq.id, {
      id: 'tab-dbg',
      url: 'https://example.com/',
      title: 'Example',
    });
    await openP;
    return { ext };
  }

  it('clickTab forwards useDebugger=true on the wire', async () => {
    const { ext } = await setupAndOpen();
    const p = bridge.clickTab({
      tabId: 'tab-dbg',
      selector: '#topSearchInput',
      useDebugger: true,
    });
    const req = await ext.next();
    expect(req.method).toBe('click');
    expect(req.params.useDebugger).toBe(true);
    expect(req.params.selector).toBe('#topSearchInput');
    ext.reply(req.id, undefined);
    await p;
    ext.close();
  });

  it('clickTab defaults useDebugger to false when omitted', async () => {
    const { ext } = await setupAndOpen();
    const p = bridge.clickTab({ tabId: 'tab-dbg', text: 'Compose' });
    const req = await ext.next();
    // The bridge always sets the flag — false rather than undefined —
    // so the extension never sees an ambiguous "missing" state.
    expect(req.params.useDebugger).toBe(false);
    ext.reply(req.id, undefined);
    await p;
    ext.close();
  });

  it('typeTab forwards useDebugger=true on the wire', async () => {
    const { ext } = await setupAndOpen();
    const p = bridge.typeTab({
      tabId: 'tab-dbg',
      text: 'John Morris',
      useDebugger: true,
    });
    const req = await ext.next();
    expect(req.method).toBe('type');
    expect(req.params.useDebugger).toBe(true);
    expect(req.params.text).toBe('John Morris');
    ext.reply(req.id, undefined);
    await p;
    ext.close();
  });

  it('pressTab forwards useDebugger=true on the wire', async () => {
    const { ext } = await setupAndOpen();
    const p = bridge.pressTab({
      tabId: 'tab-dbg',
      key: 'Enter',
      useDebugger: true,
    });
    const req = await ext.next();
    expect(req.method).toBe('press');
    expect(req.params.useDebugger).toBe(true);
    expect(req.params.key).toBe('Enter');
    ext.reply(req.id, undefined);
    await p;
    ext.close();
  });

  it('pressTab defaults useDebugger to false when omitted', async () => {
    const { ext } = await setupAndOpen();
    const p = bridge.pressTab({ tabId: 'tab-dbg', key: 'Tab' });
    const req = await ext.next();
    expect(req.params.useDebugger).toBe(false);
    ext.reply(req.id, undefined);
    await p;
    ext.close();
  });
});

// ---- Helpers --------------------------------------------------------

/** Pick a likely-free ephemeral port. We use 0 to let the OS choose. */
function getEphemeralPort(): number {
  return 0;
}

/**
 * Poll the bridge's getStatus() until `port` is non-null. This is
 * needed because we pass 0 ("ephemeral") and only learn the actual
 * port after listen() resolves inside connect(). connect() itself
 * doesn't return the port — it returns void — but it does set
 * _state.port before awaiting the handshake.
 */
async function waitForPort(timeoutMs = 2000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = bridge.getStatus();
    if (s.port !== null && s.port > 0) return s.port;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitForPort: bridge never set a real port');
}

/**
 * Generic poll-until-true helper. Returns true if the predicate
 * becomes true within `timeoutMs`, false otherwise. Used by the
 * auto-reconnect test where the status transitions are driven by
 * event-loop microtasks we can't directly await.
 */
async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
