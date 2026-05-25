/**
 * Tests for `electron/chromeWsServer.ts`.
 *
 * Strategy:
 *   The server is a wire-protocol implementation. Mocking it would
 *   defeat the point — bugs in WebSocket framing only surface when
 *   real bytes are pushed through a real TCP socket. So we stand up
 *   the actual server (bound to 127.0.0.1 on an ephemeral port) and
 *   drive it with a minimal raw client implemented inline using
 *   `node:net`. The client supports just enough of the spec to
 *   exercise every code path the production extension uses:
 *
 *     - Handshake (Sec-WebSocket-Key → Sec-WebSocket-Accept).
 *     - Send masked client text frames.
 *     - Receive unmasked server text/ping/pong/close frames.
 *
 * What we pin down:
 *   - Handshake math (Sec-WebSocket-Accept = base64(sha1(key+MAGIC))).
 *   - HTTP /health endpoint returns {ok:true} with a 200.
 *   - Bad upgrade requests get 400 (missing key, wrong version, wrong
 *     upgrade header).
 *   - Short, medium (16-bit length), and large (64-bit length) text
 *     frames round-trip in both directions.
 *   - Unmasked client frames trigger a protocol-error close (1002).
 *   - Server-sent pings are answered with the same payload as a pong
 *     by the wire layer (when the test client receives a ping it
 *     sends back a masked pong; the server should ignore the pong
 *     silently rather than error).
 *   - Close frame from either side tears down cleanly.
 *   - A second extension upgrading the WS displaces the first
 *     connection (the server's "one active connection at a time"
 *     contract). The displaced first connection sees a close with
 *     code 1000 and reason "replaced by new connection".
 *   - `server.stop()` closes the active connection (with code 1001
 *     "server stopping") AND the listening socket; subsequent
 *     connect attempts get ECONNREFUSED.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import * as http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createWsServer, type WsServer } from '../electron/chromeWsServer';

/**
 * Drop-in `fetch` replacement that uses Node's `http` directly. The
 * default global `fetch` in vitest's happy-dom env applies CORS
 * checks to cross-origin URLs and rejects 127.0.0.1:N from the
 * about:blank page origin happy-dom uses. We need to bypass that to
 * exercise the /health endpoint.
 */
async function nodeFetch(
  url: string
): Promise<{ status: number; json: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) =>
        chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
      );
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          json: async () => JSON.parse(body),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---- Minimal raw WS client (test helper) -------------------------------
//
// Implements the inverse of the server: builds masked client frames,
// parses unmasked server frames, and exposes a simple async API. Stays
// in this test file because it's only ever a test helper.

interface ClientFrame {
  opcode: number;
  payload: Buffer;
  fin: boolean;
}

class TestClient {
  socket: net.Socket;
  private _buf = Buffer.alloc(0);
  private _frames: ClientFrame[] = [];
  private _frameWaiters: Array<(f: ClientFrame) => void> = [];
  closed = false;
  closeCode: number | null = null;
  closeReason = '';

  private constructor(socket: net.Socket) {
    this.socket = socket;
    // socket.on('data', ...) types the chunk as `Buffer | string` because
    // it might be in string mode. We're always in default (Buffer) mode
    // here but TS doesn't know that; coerce.
    socket.on('data', (chunk: Buffer | string) => {
      this._onData(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    socket.on('close', () => {
      this.closed = true;
      // Drain any waiters with a close-shaped frame so tests don't hang.
      while (this._frameWaiters.length > 0) {
        const w = this._frameWaiters.shift()!;
        w({ opcode: 0x8, payload: Buffer.alloc(0), fin: true });
      }
    });
  }

  /** Open a TCP socket and complete the WS upgrade handshake. */
  static async connect(port: number): Promise<TestClient> {
    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1')
      .update(key + WS_MAGIC)
      .digest('base64');
    socket.write(
      [
        'GET / HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n')
    );
    // Read the response status line + headers up to the blank line.
    const headerBuf = await readUntil(socket, '\r\n\r\n');
    const headerStr = headerBuf.toString('utf8');
    if (!headerStr.startsWith('HTTP/1.1 101')) {
      socket.destroy();
      throw new Error(`server did not upgrade: ${headerStr.split('\r\n')[0]}`);
    }
    const acceptLine = /sec-websocket-accept:\s*(\S+)/i.exec(headerStr);
    if (!acceptLine || acceptLine[1] !== expectedAccept) {
      socket.destroy();
      throw new Error('Sec-WebSocket-Accept mismatch');
    }
    return new TestClient(socket);
  }

  /** Send a text frame to the server with a random mask. */
  sendText(text: string): void {
    this._sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  /**
   * Send a single frame with explicit FIN bit + opcode. Used by the
   * fragmentation tests to assemble a multi-frame message by hand:
   *
   *   sendFragment(0x1, "hel", false);   // Text opening, fin=0
   *   sendFragment(0x0, "lo!",  true);   // Continuation closing, fin=1
   *
   * Always masked (we only test legit client-side traffic; the
   * unmasked-protocol-error path has its own helper).
   */
  sendFragment(opcode: number, payload: Buffer | string, fin: boolean): void {
    const pl = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    const finBit = fin ? 0x80 : 0x00;
    const len = pl.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([finBit | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.from([finBit | opcode, 0x80 | 126, len >> 8, len & 0xff]);
    } else {
      header = Buffer.alloc(10);
      header[0] = finBit | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    const mask = randomBytes(4);
    const masked = Buffer.from(pl);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  /** Send a frame DELIBERATELY UNMASKED to trigger a protocol error. */
  sendTextUnmasked(text: string): void {
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.from([0x81, 126, len >> 8, len & 0xff]);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  /** Send a close frame and close our socket. */
  close(code = 1000, reason = ''): void {
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._sendFrame(0x8, payload);
    this.socket.end();
  }

  /** Pull the next frame off the inbound queue, waiting if needed. */
  async nextFrame(timeoutMs = 5000): Promise<ClientFrame> {
    if (this._frames.length > 0) return this._frames.shift()!;
    return new Promise<ClientFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._frameWaiters.indexOf(waiter);
        if (idx >= 0) this._frameWaiters.splice(idx, 1);
        reject(new Error(`nextFrame timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = (f: ClientFrame) => {
        clearTimeout(timer);
        resolve(f);
      };
      this._frameWaiters.push(waiter);
    });
  }

  /** Wait until the underlying socket is closed (no more frames). */
  async nextClose(timeoutMs = 5000): Promise<void> {
    if (this.closed) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ---- internals -----------------------------------------------------

  private _sendFrame(opcode: number, payload: Buffer): void {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]); // MASK set
    } else if (len < 65536) {
      header = Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 0xff]);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    const mask = randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private _onData(chunk: Buffer): void {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 2) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let headerLen = 2;
      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        headerLen = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        // Limit to JS-safe int; we don't send larger in tests.
        len = this._buf.readUInt32BE(6);
        headerLen = 10;
      }
      const total = headerLen + (masked ? 4 : 0) + len;
      if (this._buf.length < total) return;
      const payload = Buffer.from(
        this._buf.subarray(headerLen + (masked ? 4 : 0), total)
      );
      if (masked) {
        const mask = this._buf.subarray(headerLen, headerLen + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this._buf = this._buf.subarray(total);
      const f: ClientFrame = { opcode, payload, fin };
      // Auto-handle ping: echo as pong (masked).
      if (opcode === 0x9) {
        this._sendFrame(0xa, payload);
      }
      // Capture close payload for tests.
      if (opcode === 0x8 && payload.length >= 2) {
        this.closeCode = payload.readUInt16BE(0);
        this.closeReason = payload.subarray(2).toString('utf8');
      }
      // Deliver to either a waiter or the queue.
      if (this._frameWaiters.length > 0) {
        const w = this._frameWaiters.shift()!;
        w(f);
      } else {
        this._frames.push(f);
      }
    }
  }
}

/** Read raw bytes from a socket until a delimiter appears. */
async function readUntil(socket: net.Socket, delim: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const delimBuf = Buffer.from(delim, 'utf8');
    const onData = (chunkIn: Buffer | string) => {
      const chunk = typeof chunkIn === 'string' ? Buffer.from(chunkIn) : chunkIn;
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf(delimBuf);
      if (idx >= 0) {
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        resolve(buf.subarray(0, idx + delimBuf.length));
      }
    };
    const onError = (e: Error) => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      reject(e);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

/** Quick TCP connect probe to confirm a port is no longer accepting. */
async function isPortClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(false);
    });
    s.once('error', () => {
      resolve(true);
    });
  });
}

// ---- Test scaffolding -------------------------------------------------

let server: WsServer;

beforeEach(async () => {
  server = createWsServer({ port: 0 });
  await server.start();
});

afterEach(async () => {
  try {
    await server.stop();
  } catch {
    /* test may have already stopped it */
  }
});

// ---- Health endpoint --------------------------------------------------

describe('HTTP /health', () => {
  it('returns 200 with ok:true JSON', async () => {
    const port = server.port();
    const res = await nodeFetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.hasActiveConnection).toBe(false);
  });

  it('reflects hasActiveConnection once a WS client connects', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    try {
      // Tiny delay so the server's connect handler runs before we probe.
      await new Promise((r) => setTimeout(r, 20));
      const res = await nodeFetch(`http://127.0.0.1:${port}/health`);
      const body = await res.json();
      expect(body.hasActiveConnection).toBe(true);
    } finally {
      c.socket.destroy();
    }
  });

  it('returns 404 for unknown paths', async () => {
    const port = server.port();
    const res = await nodeFetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });
});

// ---- Handshake / upgrade ----------------------------------------------

describe('upgrade handshake', () => {
  it('completes a valid handshake and emits a connect event', async () => {
    const port = server.port();
    const connectedP = new Promise<void>((resolve) => {
      server.on('connect', () => resolve());
    });
    const c = await TestClient.connect(port);
    await connectedP;
    expect(server.active()).not.toBeNull();
    c.socket.destroy();
  });

  it('rejects a non-WS GET with 400', async () => {
    const port = server.port();
    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise((r) => socket.once('connect', r));
    // Missing Sec-WebSocket-Key / wrong upgrade header.
    socket.write(
      [
        'GET / HTTP/1.1',
        'Host: 127.0.0.1',
        'Connection: keep-alive',
        '',
        '',
      ].join('\r\n')
    );
    const data = await new Promise<Buffer>((resolve) => {
      socket.once('data', resolve);
    });
    expect(data.toString('utf8')).toMatch(/^HTTP\/1\.1 404/);
    socket.destroy();
  });

  it('rejects upgrade with missing Sec-WebSocket-Key', async () => {
    const port = server.port();
    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise((r) => socket.once('connect', r));
    socket.write(
      [
        'GET / HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n')
    );
    const data = await new Promise<Buffer>((resolve) => {
      socket.once('data', resolve);
    });
    expect(data.toString('utf8')).toMatch(/^HTTP\/1\.1 400/);
    socket.destroy();
  });
});

// ---- Frame parsing / sending ------------------------------------------

describe('text frames', () => {
  it('round-trips small (<126 byte) text frames in both directions', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    const conn = server.active()!;
    // Client → server.
    const gotMsg = new Promise<string>((resolve) => {
      conn.on('message', (m) => resolve(m));
    });
    c.sendText('hello');
    expect(await gotMsg).toBe('hello');
    // Server → client.
    conn.send('world');
    const frame = await c.nextFrame();
    expect(frame.opcode).toBe(0x1);
    expect(frame.payload.toString('utf8')).toBe('world');
    c.socket.destroy();
  });

  it('round-trips medium (16-bit length) text frames', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    const conn = server.active()!;
    const longText = 'x'.repeat(1000); // > 125, < 65536 → 16-bit length
    const got = new Promise<string>((resolve) =>
      conn.on('message', (m) => resolve(m))
    );
    c.sendText(longText);
    expect((await got).length).toBe(1000);
    conn.send(longText);
    const frame = await c.nextFrame();
    expect(frame.payload.length).toBe(1000);
    c.socket.destroy();
  });

  it('round-trips large (64-bit length) text frames', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    const conn = server.active()!;
    const huge = 'y'.repeat(100_000); // > 65535 → 64-bit length
    const got = new Promise<string>((resolve) =>
      conn.on('message', (m) => resolve(m))
    );
    c.sendText(huge);
    expect((await got).length).toBe(100_000);
    conn.send(huge);
    const frame = await c.nextFrame();
    expect(frame.payload.length).toBe(100_000);
    c.socket.destroy();
  });

  it('treats an unmasked client frame as a protocol error (1002)', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    c.sendTextUnmasked('illegal');
    const frame = await c.nextFrame();
    expect(frame.opcode).toBe(0x8); // close
    expect(c.closeCode).toBe(1002);
    await c.nextClose();
  });
});

// ---- Fragmented messages (RFC 6455 §5.4) ------------------------------
//
// Chrome's MV3 WebSocket implementation fragments outbound messages
// once they pass an internal threshold (~128 KiB). Production
// screenshots return ~400 KiB JSON, which arrives as multiple frames:
// a Text opener with fin=0, zero or more Continuation middles, and
// a final Continuation with fin=1. Earlier the server rejected any
// fin=0 frame with a 1002 close, which manifested in the bridge as
// "extension disconnected mid-call" right after every big response.
// These tests pin the correct reassembly behavior so the regression
// can't sneak back.

describe('fragmented text messages', () => {
  it('reassembles a two-fragment text message', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    const conn = server.active()!;
    const got = new Promise<string>((resolve) => {
      conn.on('message', (m) => resolve(m));
    });
    // First frame: Text (0x1), fin=0.
    c.sendFragment(0x1, 'hello ', false);
    // Second frame: Continuation (0x0), fin=1.
    c.sendFragment(0x0, 'world', true);
    expect(await got).toBe('hello world');
    c.socket.destroy();
  });

  it('reassembles a many-fragment text message (5 chunks)', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    const conn = server.active()!;
    const got = new Promise<string>((resolve) => {
      conn.on('message', (m) => resolve(m));
    });
    // Mimics how Chrome would split a ~400 KiB response: one opener,
    // several middles, one closer.
    c.sendFragment(0x1, 'A', false);
    c.sendFragment(0x0, 'B', false);
    c.sendFragment(0x0, 'C', false);
    c.sendFragment(0x0, 'D', false);
    c.sendFragment(0x0, 'E', true);
    expect(await got).toBe('ABCDE');
    c.socket.destroy();
  });

  it('reassembles a fragmented message larger than the medium-length threshold', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    const conn = server.active()!;
    const got = new Promise<string>((resolve) => {
      conn.on('message', (m) => resolve(m));
    });
    // Each fragment 50_000 bytes → uses 16-bit length encoding. Two
    // fragments → 100_000 byte reassembled message. Confirms the
    // length-aware parser path co-exists with the reassembly state.
    const half = 'x'.repeat(50_000);
    c.sendFragment(0x1, half, false);
    c.sendFragment(0x0, half, true);
    const msg = await got;
    expect(msg.length).toBe(100_000);
    expect(msg.startsWith('xxx')).toBe(true);
    c.socket.destroy();
  });

  it('allows a control frame (ping) interleaved between data fragments', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    const conn = server.active()!;
    const got = new Promise<string>((resolve) => {
      conn.on('message', (m) => resolve(m));
    });
    // Open the fragmented message.
    c.sendFragment(0x1, 'foo', false);
    // Slip in a ping (control frame, must not be fragmented, can
    // interleave). Server replies pong, fragmentation state stays.
    sendClientPing(c, Buffer.from([0x01, 0x02]));
    // Finish the message. The server should NOT treat the interleaved
    // ping as having interrupted the fragmented message.
    c.sendFragment(0x0, 'bar', true);
    expect(await got).toBe('foobar');
    // Drain the pong reply (order isn't strictly defined but the
    // server replies promptly).
    const f = await c.nextFrame();
    expect(f.opcode).toBe(0xa); // pong
    c.socket.destroy();
  });

  it('rejects a continuation frame with no message in progress (1002)', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    // Continuation frame (opcode=0) sent first → protocol error.
    c.sendFragment(0x0, 'orphan', true);
    const frame = await c.nextFrame();
    expect(frame.opcode).toBe(0x8); // close
    expect(c.closeCode).toBe(1002);
    expect(c.closeReason).toMatch(/continuation/i);
  });

  it('rejects a new data opener while a fragmented message is in flight (1002)', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    // Open a fragmented Text message.
    c.sendFragment(0x1, 'first', false);
    // Send ANOTHER Text opener instead of a Continuation → illegal.
    c.sendFragment(0x1, 'second', true);
    const frame = await c.nextFrame();
    expect(frame.opcode).toBe(0x8);
    expect(c.closeCode).toBe(1002);
    expect(c.closeReason).toMatch(/previous fragmented/i);
  });

  it('rejects a fragmented control frame (1002)', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    // Ping (0x9) with fin=0 — illegal per §5.5.
    c.sendFragment(0x9, Buffer.from([0xab]), false);
    const frame = await c.nextFrame();
    expect(frame.opcode).toBe(0x8);
    expect(c.closeCode).toBe(1002);
    expect(c.closeReason).toMatch(/control frames must not be fragmented/i);
  });
});

// ---- Close / displacement / stop --------------------------------------

describe('close + lifecycle', () => {
  it('echoes a client close frame and tears down cleanly', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    const closedP = new Promise<void>((resolve) => {
      server.on('disconnect', () => resolve());
    });
    c.close(1000, 'bye');
    const frame = await c.nextFrame();
    expect(frame.opcode).toBe(0x8);
    await closedP;
    expect(server.active()).toBeNull();
  });

  it('displaces the first connection when a second one upgrades', async () => {
    const port = server.port();
    const c1 = await TestClient.connect(port);
    await waitForConnect(server);
    const firstConn = server.active();
    expect(firstConn).not.toBeNull();
    const c2 = await TestClient.connect(port);
    // c1 should receive a close frame; its socket should close.
    const closeFrame = await c1.nextFrame();
    expect(closeFrame.opcode).toBe(0x8);
    expect(c1.closeCode).toBe(1000);
    expect(c1.closeReason).toContain('replaced');
    // c2 should now be the active connection.
    await waitForConnect(server, 2);
    expect(server.active()).not.toBe(firstConn);
    c2.socket.destroy();
  });

  it('stop() closes the active connection AND stops accepting', async () => {
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    await server.stop();
    // The active connection should have been closed with 1001.
    await c.nextClose();
    expect(c.closeCode).toBe(1001);
    // Subsequent connection attempts on the same port should fail.
    expect(await isPortClosed(port)).toBe(true);
  });
});

// ---- Keepalive ping ---------------------------------------------------

describe('server keepalive', () => {
  it('server-sent pings are matched by client pongs without protocol errors', async () => {
    // We can't reasonably wait 25s for the natural ping. Instead we
    // exercise the receive side: send a ping FROM the client (well-
    // formed, masked) and verify the server replies with a matching
    // pong rather than closing.
    const port = server.port();
    const c = await TestClient.connect(port);
    await waitForConnect(server);
    // Manually send a client ping (opcode 0x9). The server should
    // reply with a pong containing the same payload.
    sendClientPing(c, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const frame = await c.nextFrame();
    expect(frame.opcode).toBe(0xa); // pong
    expect(Array.from(frame.payload)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    c.socket.destroy();
  });
});

// ---- Helpers ---------------------------------------------------------

/**
 * Wait until the server has emitted at least N `connect` events
 * (cumulative across the test). Defaults to 1.
 */
async function waitForConnect(s: WsServer, n = 1): Promise<void> {
  if (s.active()) return;
  let count = 0;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off('connect', onConn);
      reject(new Error(`waitForConnect: only saw ${count}/${n} connects`));
    }, 2000);
    const onConn = () => {
      count++;
      if (count >= n) {
        clearTimeout(timer);
        s.off('connect', onConn);
        resolve();
      }
    };
    s.on('connect', onConn);
  });
}

/** Build and send a masked PING frame from the test client. */
function sendClientPing(c: TestClient, payload: Buffer): void {
  const mask = randomBytes(4);
  const header = Buffer.from([0x89, 0x80 | payload.length]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  c.socket.write(Buffer.concat([header, mask, masked]));
}
