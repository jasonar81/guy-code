/**
 * Minimal WebSocket server for the Chrome extension bridge.
 *
 * Why "minimal" and not the `ws` library:
 *   The only WS client that ever talks to this server is our own
 *   `chrome-extension/service_worker.js`. We control both sides of the
 *   wire, so we only need the subset of RFC 6455 the extension actually
 *   uses: HTTP/1.1 upgrade handshake, single-frame text messages,
 *   server-sent pings, client→server masked frames. Skipping `ws`
 *   means one fewer dependency to bundle / externalize / package on
 *   each Electron release, and one fewer transitive vulnerability
 *   feed to watch.
 *
 * What this DOES handle:
 *   - HTTP Upgrade handshake (Sec-WebSocket-Key → Sec-WebSocket-Accept).
 *   - Inbound masked text frames from the extension.
 *   - Outbound unmasked text frames (server is forbidden to mask).
 *   - Periodic pings (every 25s) to keep the MV3 service worker alive
 *     so the WS connection survives Chrome's 30s SW idle timeout.
 *   - Close-frame echo on disconnect (clean close from either side).
 *   - HTTP `/health` GET handler on the same port for the extension's
 *     popup.js to probe; returns `{"ok":true}` JSON when the server
 *     is up. This avoids needing a separate HTTP server / port for
 *     the popup status check.
 *
 * What this does NOT handle (by design):
 *   - Binary frames (the extension never sends them).
 *   - Fragmented messages (single-frame only; messages > 16MB throw).
 *   - Subprotocols (`Sec-WebSocket-Protocol`); not needed.
 *   - Extensions (`Sec-WebSocket-Extensions` like permessage-deflate);
 *     for our JSON traffic the compression isn't worth the code.
 *   - Multiple concurrent connections: we keep at most ONE active
 *     extension connection. If a second one shows up (e.g. the user
 *     reloaded the extension), we politely close the old one and
 *     adopt the new one. This is the right semantic — there's no
 *     useful meaning to "two extensions both driving the same agent".
 *
 * Threading model: single Node event loop. `WsConnection.send` writes
 * synchronously to the socket; the connection has no internal queue.
 * Callers must NOT call send on a closed connection (we'd throw).
 *
 * Tests live in `tests/chromeWsServer.test.ts` and stand up a real
 * server bound to 127.0.0.1 on an ephemeral port (port 0); a client
 * implemented in the same file (also raw Node net) drives every
 * tested path. No fake / mock layer between the server and the test,
 * which is the only sane way to verify a wire-protocol implementation.
 */
import * as http from 'node:http';
import * as net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * RFC 6455 GUID appended to the client's Sec-WebSocket-Key before the
 * SHA-1+base64 round-trip that produces Sec-WebSocket-Accept. The
 * value is part of the spec and never changes.
 */
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Cap inbound payload size at 16 MiB. Screenshots from the extension
 * are the biggest realistic payload and even a 4K viewport PNG fits
 * comfortably under 8 MiB; doubling that gives headroom without
 * making it easy for a runaway extension to OOM the main process.
 */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Send a ping every 15 seconds. Chrome's MV3 service workers shut
 * down after ~30s of event inactivity, and a received ping (which
 * we auto-pong) counts as event activity and resets the timer.
 *
 * 25s previously left only 5s of margin — empirically, after large
 * RPCs (multi-MB screenshots, big DOM extracts) the SW does some
 * post-handling work and may not register the WS read as "fresh"
 * for the full 25s, causing Chrome to suspend the worker right
 * before the next ping arrives. The connection drops, the SW
 * restarts on the next alarm, and the bridge has to scramble to
 * re-attach. 15s gives a comfortable 2× margin and the wire-chatter
 * cost is negligible (a 6-byte ping frame plus 6-byte pong, once
 * every 15s).
 */
const PING_INTERVAL_MS = 15_000;

/**
 * WebSocket opcodes (4-bit field). See RFC 6455 §11.8.
 */
const enum Opcode {
  Continuation = 0x0,
  Text = 0x1,
  Binary = 0x2,
  Close = 0x8,
  Ping = 0x9,
  Pong = 0xa,
}

/**
 * Public connection handle. One per active extension. Emits `message`
 * (decoded text payload) and `close` (no args). Producers call `send`
 * to write a text frame, or `close` to send a close frame and tear
 * down the underlying socket. `isOpen()` is the source of truth —
 * `send` after close is a no-op (logged, not thrown, because the
 * extension may disconnect mid-RPC and the agent shouldn't crash).
 */
export interface WsConnection extends EventEmitter {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  isOpen(): boolean;
  readonly remoteAddress: string;
}

/**
 * Server lifecycle handle. `start()` binds the port; `stop()` closes
 * the listening socket AND the active connection (if any). `active()`
 * is the current sole connection or null.
 *
 * Events:
 *   - `connect` (conn): a new WS connection became active. If a
 *     prior connection existed, it was already closed before this
 *     event fired (so the consumer only ever has to deal with one
 *     at a time).
 *   - `disconnect`: the active connection went away. The consumer
 *     should mark "not connected"; the next `connect` event will
 *     fire when the extension comes back.
 */
export interface WsServer extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  active(): WsConnection | null;
  /** The port the server is actually listening on (after start). */
  port(): number;
}

export interface CreateWsServerOpts {
  /**
   * TCP port to bind on 127.0.0.1. Pass 0 in tests to get an
   * ephemeral port (use `server.port()` after `start()` to discover
   * which one).
   */
  port: number;
}

export function createWsServer(opts: CreateWsServerOpts): WsServer {
  const server = new WsServerImpl(opts.port);
  return server;
}

// ----- implementation --------------------------------------------------

class WsServerImpl extends EventEmitter implements WsServer {
  private _httpServer: http.Server | null = null;
  private _port: number;
  private _actualPort = 0;
  private _active: WsConnectionImpl | null = null;

  constructor(port: number) {
    super();
    this._port = port;
  }

  port(): number {
    return this._actualPort;
  }

  active(): WsConnection | null {
    return this._active;
  }

  async start(): Promise<void> {
    if (this._httpServer) return; // idempotent
    const httpServer = http.createServer((req, res) => this._handleHttp(req, res));
    httpServer.on('upgrade', (req, sock, head) => this._handleUpgrade(req, sock as net.Socket, head));
    this._httpServer = httpServer;
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => {
        httpServer.removeListener('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        httpServer.removeListener('error', onError);
        const addr = httpServer.address();
        if (addr && typeof addr === 'object') this._actualPort = addr.port;
        else this._actualPort = this._port;
        resolve();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      // Bind to localhost only. We do NOT want this port reachable from
      // other machines on the LAN — the extension protocol gives full
      // tab-reading + click-driving access to whichever Chrome the
      // extension is loaded in. Localhost-only is the security boundary.
      httpServer.listen(this._port, '127.0.0.1');
    });
  }

  async stop(): Promise<void> {
    if (this._active) {
      this._active.close(1001, 'server stopping');
      this._active = null;
    }
    const s = this._httpServer;
    this._httpServer = null;
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      // close() doesn't terminate keep-alive connections; force them.
      s.closeAllConnections?.();
    });
  }

  private _handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    // The only HTTP route is /health, used by the extension's popup.js
    // to indicate whether the desktop app is running. Anything else
    // gets a 404 — we don't expose a UI on this port.
    if (req.method === 'GET' && req.url && req.url.startsWith('/health')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      // CORS: allow any origin so the popup (running in an extension
      // origin like chrome-extension://...) can fetch us. We only
      // expose /health on this CORS allowance; the upgrade handshake
      // is on a different code path.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(
        JSON.stringify({
          ok: true,
          hasActiveConnection: this._active !== null,
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  }

  private _handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    // Reject anything that doesn't look like a WS handshake. Most of
    // these checks are also done by the HTTP parser, but being
    // explicit avoids any cleverness in case a non-WS client wanders
    // onto the port.
    const upgrade = (req.headers.upgrade || '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (upgrade !== 'websocket' || !key || version !== '13') {
      socket.write(
        'HTTP/1.1 400 Bad Request\r\n' +
          'Connection: close\r\n' +
          'Content-Length: 0\r\n\r\n'
      );
      socket.destroy();
      return;
    }

    // RFC 6455 handshake: SHA-1 of `${key}${WS_MAGIC}` in base64.
    const accept = createHash('sha1').update(`${key}${WS_MAGIC}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n'
    );

    // Mute Nagle so small JSON RPC messages don't wait for ACKs to
    // coalesce. WS messages are typically one-shot question-or-answer
    // pairs and we'd rather the wire be chatty than slow.
    socket.setNoDelay(true);

    // Displace any prior connection. There's only ever supposed to be
    // one extension talking to us; if we got a fresh upgrade, the old
    // one is presumed defunct (reload, crash, or duplicate install).
    if (this._active) {
      this._active.close(1000, 'replaced by new connection');
      // Don't null it here — the close handler does that. We do want
      // to be careful not to fire `disconnect` if the close+connect
      // happen in quick succession, but the EventEmitter consumer
      // (chromeExtBridge) should be robust to that anyway.
    }

    const conn = new WsConnectionImpl(socket, head, req.socket.remoteAddress ?? '127.0.0.1');
    this._active = conn;
    conn.on('close', () => {
      if (this._active === conn) {
        this._active = null;
        this.emit('disconnect');
      }
    });
    this.emit('connect', conn);
  }
}

class WsConnectionImpl extends EventEmitter implements WsConnection {
  private _socket: net.Socket;
  private _buf: Buffer = Buffer.alloc(0);
  private _closed = false;
  private _pingTimer: NodeJS.Timeout | null = null;
  /**
   * Per RFC 6455 §5.4 a message can arrive as a sequence of frames:
   * an initial frame with opcode = Text or Binary and `fin=0`,
   * followed by zero or more Continuation frames (opcode = 0x0),
   * the last of which has `fin=1`. Chrome's MV3 WebSocket
   * implementation fragments outbound messages once they pass an
   * internal threshold (empirically ~128 KiB), so anything bigger
   * than a small JSON tool result arrives split. We track the
   * in-progress message here and only emit `message` when the
   * full thing has been reassembled.
   *
   * `_fragOpcode` is the opcode of the FIRST frame (Text or
   * Binary). `_fragChunks` holds the unmasked payloads of every
   * frame received so far. `_fragSize` is the running total
   * (kept separate to avoid an O(n²) `Buffer.concat` on every
   * append for very large messages). Both are nulled when a
   * message is delivered or on connection close.
   */
  private _fragOpcode: Opcode | null = null;
  private _fragChunks: Buffer[] | null = null;
  private _fragSize = 0;
  readonly remoteAddress: string;

  constructor(socket: net.Socket, head: Buffer, remoteAddress: string) {
    super();
    this._socket = socket;
    this.remoteAddress = remoteAddress;
    if (head && head.length > 0) {
      // Any data that arrived in the same TCP packet as the upgrade
      // request belongs to us already. Prime the buffer with it.
      this._buf = Buffer.from(head);
      this._tryParseFrames();
    }
    socket.on('data', (chunk) => {
      this._buf = Buffer.concat([this._buf, chunk]);
      this._tryParseFrames();
    });
    socket.on('close', () => this._finalize());
    socket.on('error', () => this._finalize());
    // Periodic pings keep the extension's MV3 service worker awake.
    // The extension doesn't need to do anything with the ping; just
    // *receiving* it is event activity that resets Chrome's idle timer.
    this._pingTimer = setInterval(() => this._writePing(), PING_INTERVAL_MS);
    // Don't block the event loop from exiting just because a ping is
    // pending — in tests we may shut down before any ping ever fires.
    this._pingTimer.unref?.();
  }

  isOpen(): boolean {
    return !this._closed;
  }

  send(text: string): void {
    if (this._closed) return;
    const payload = Buffer.from(text, 'utf8');
    this._writeFrame(Opcode.Text, payload);
  }

  close(code = 1000, reason = ''): void {
    if (this._closed) return;
    // Encode a close frame: 2-byte big-endian code, optional UTF-8 reason.
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try {
      this._writeFrame(Opcode.Close, payload);
    } catch {
      /* socket may already be torn down */
    }
    this._socket.end();
  }

  // ---- internal: parsing -----------------------------------------------

  private _tryParseFrames(): void {
    // The frame parser is a loop: pull one frame at a time off the
    // head of the buffer until the buffer is empty or has a partial
    // frame. Partial frames stay buffered until the next `data` event
    // delivers the rest.
    while (!this._closed && this._buf.length >= 2) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = (b0 & 0x0f) as Opcode;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let headerLen = 2;

      if (payloadLen === 126) {
        if (this._buf.length < 4) return; // wait for more bytes
        payloadLen = this._buf.readUInt16BE(2);
        headerLen = 4;
      } else if (payloadLen === 127) {
        if (this._buf.length < 10) return;
        // Read as 64-bit big-endian. Reject anything > MAX_PAYLOAD_BYTES.
        const hi = this._buf.readUInt32BE(2);
        const lo = this._buf.readUInt32BE(6);
        if (hi !== 0 || lo > MAX_PAYLOAD_BYTES) {
          this._protocolError(`payload too large (${hi}/${lo})`);
          return;
        }
        payloadLen = lo;
        headerLen = 10;
      }

      if (payloadLen > MAX_PAYLOAD_BYTES) {
        this._protocolError(`payload too large (${payloadLen})`);
        return;
      }

      // RFC 6455 §5.3: client→server frames MUST be masked. Server
      // MUST close on an unmasked client frame.
      if (!masked) {
        this._protocolError('client frame missing mask');
        return;
      }
      const maskOffset = headerLen;
      const payloadOffset = headerLen + 4;
      const totalLen = payloadOffset + payloadLen;
      if (this._buf.length < totalLen) return; // partial frame

      const mask = this._buf.subarray(maskOffset, maskOffset + 4);
      // Slice and copy the payload so we own the buffer (so subsequent
      // reads from the rolling buffer don't mutate it).
      const payload = Buffer.from(this._buf.subarray(payloadOffset, totalLen));
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
      // Advance the rolling buffer past this frame.
      this._buf = this._buf.subarray(totalLen);

      this._handleFrame(fin, opcode, payload);
    }
  }

  private _handleFrame(fin: boolean, opcode: Opcode, payload: Buffer): void {
    // RFC 6455 §5.5: control frames (opcode ≥ 0x8) MUST NOT be
    // fragmented and MUST have payload ≤ 125 bytes. They are
    // allowed to interleave between data frames of a fragmented
    // message, so we handle them inline without touching the
    // fragmentation state.
    const isControl = opcode >= 0x8;
    if (isControl) {
      if (!fin) {
        this._protocolError('control frames must not be fragmented');
        return;
      }
      if (payload.length > 125) {
        this._protocolError('control frame payload exceeds 125 bytes');
        return;
      }
      this._handleControlFrame(opcode, payload);
      return;
    }
    // ---- Data frame (Text / Binary / Continuation) -------------------
    //
    // The state machine here is straight off RFC 6455 §5.4:
    //   • A first frame is Text or Binary with `fin=0`. It opens
    //     a fragmented message; we remember its opcode and start
    //     buffering.
    //   • Subsequent middle frames have opcode=0 (Continuation)
    //     and `fin=0`; we append.
    //   • The final frame has opcode=0 (Continuation) and `fin=1`;
    //     we append, reassemble, and deliver as the original opcode.
    //   • A first frame with `fin=1` is an unfragmented message —
    //     deliver immediately, no buffering.
    //
    // Any other sequence (Continuation without an open message,
    // a new Text/Binary while one is in progress, …) is a §5.4
    // protocol violation → close with 1002.
    if (opcode === Opcode.Continuation) {
      if (this._fragOpcode === null) {
        this._protocolError('continuation frame with no message in progress');
        return;
      }
      this._fragSize += payload.length;
      if (this._fragSize > MAX_PAYLOAD_BYTES) {
        this._protocolError(
          `reassembled message exceeds max payload (${this._fragSize})`
        );
        return;
      }
      this._fragChunks!.push(payload);
      if (fin) {
        const startOpcode = this._fragOpcode;
        const assembled = Buffer.concat(this._fragChunks!, this._fragSize);
        this._fragOpcode = null;
        this._fragChunks = null;
        this._fragSize = 0;
        this._deliverDataMessage(startOpcode, assembled);
      }
      return;
    }
    // Text or Binary opening frame.
    if (this._fragOpcode !== null) {
      // A new message started while a previous fragmented one was
      // still in progress — illegal.
      this._fragOpcode = null;
      this._fragChunks = null;
      this._fragSize = 0;
      this._protocolError(
        'new data frame received before previous fragmented message completed'
      );
      return;
    }
    if (fin) {
      // Unfragmented — fast path, no buffering needed.
      this._deliverDataMessage(opcode, payload);
      return;
    }
    // Start a new fragmented message.
    this._fragOpcode = opcode;
    this._fragChunks = [payload];
    this._fragSize = payload.length;
  }

  private _handleControlFrame(opcode: Opcode, payload: Buffer): void {
    switch (opcode) {
      case Opcode.Ping:
        // Reply with the same payload as a pong. RFC 6455 §5.5.2.
        this._writeFrame(Opcode.Pong, payload);
        return;
      case Opcode.Pong:
        // The extension echoes our keepalive ping. We don't need to
        // do anything; the act of receiving has already reset the
        // socket's read timer.
        return;
      case Opcode.Close:
        // Echo the close frame and tear down. The extension may
        // include a code+reason; we don't bother parsing it.
        this._writeFrame(Opcode.Close, payload);
        this._socket.end();
        return;
      default:
        this._protocolError(`unexpected control opcode: ${opcode}`);
        return;
    }
  }

  private _deliverDataMessage(opcode: Opcode, payload: Buffer): void {
    switch (opcode) {
      case Opcode.Text:
        try {
          const text = payload.toString('utf8');
          this.emit('message', text);
        } catch {
          /* utf-8 decode shouldn't throw, but if it does, drop the frame */
        }
        return;
      case Opcode.Binary:
        // Extension shouldn't send binary. Ignore politely; closing
        // would be heavy-handed.
        return;
      default:
        this._protocolError(`unexpected data opcode: ${opcode}`);
        return;
    }
  }

  private _protocolError(reason: string): void {
    // Send a 1002 (protocol error) close frame and tear down. The
    // extension will see the close and reconnect after its backoff.
    try {
      this.close(1002, reason);
    } catch {
      /* nothing else to do */
    }
  }

  // ---- internal: writing ----------------------------------------------

  private _writeFrame(opcode: Opcode, payload: Buffer): void {
    if (this._closed) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode; // FIN=1, opcode=opcode
      header[1] = len; // MASK=0 (server doesn't mask), len in low 7 bits
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      // 64-bit length: high 32 bits zero (we don't exceed 4GB).
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    // One write per frame keeps the wire output coherent — TCP will
    // coalesce adjacent writes anyway.
    this._socket.write(Buffer.concat([header, payload]));
  }

  private _writePing(): void {
    if (this._closed) return;
    // 4-byte random ping payload — the spec lets it be empty, but
    // a small unique payload makes pong-matching trivially diagnosable
    // if we ever need to debug a flaky keepalive.
    this._writeFrame(Opcode.Ping, randomBytes(4));
  }

  // ---- internal: lifecycle --------------------------------------------

  private _finalize(): void {
    if (this._closed) return;
    this._closed = true;
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    // Drop any half-assembled fragmented message so we don't hold
    // onto the chunk buffers longer than necessary.
    this._fragOpcode = null;
    this._fragChunks = null;
    this._fragSize = 0;
    this.emit('close');
    // Don't keep references to the socket; nothing else to do.
    this._socket.removeAllListeners();
  }
}
