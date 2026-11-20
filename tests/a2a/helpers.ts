/**
 * Shared fixtures for the A2A tests: a throwaway sql.js database with the
 * real A2A schema, an in-memory secret store, a recording SessionPort, and a
 * helper that stands up a full A2ANode with a freshly generated certificate on
 * 127.0.0.1:0 (real TLS, nothing mocked between client and server).
 */
import initSqlJs, { type Database } from 'sql.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { A2A_SCHEMA_SQL } from '../../electron/a2a/schema';
import { A2ANode } from '../../electron/a2a/node';
import { generateSelfSignedCert, type TlsIdentity } from '../../electron/a2a/tls';
import type { SecretPort, SqlHandle } from '../../electron/a2a/store';
import type { RoutableSession, SessionPort } from '../../electron/a2a/router';

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

export async function makeSql(): Promise<{ sql: SqlHandle; raw: Database }> {
  SQL ??= await initSqlJs();
  const raw = new SQL.Database();
  raw.exec(A2A_SCHEMA_SQL);
  const sql: SqlHandle = {
    prepare: (q: string) => ({
      run: (...p: unknown[]) => {
        raw.run(q, p as any);
      },
      all: <T,>(...p: unknown[]) => {
        const st = raw.prepare(q);
        try {
          if (p.length) st.bind(p as any);
          const rows: T[] = [];
          while (st.step()) rows.push(st.getAsObject() as T);
          return rows;
        } finally {
          st.free();
        }
      },
      get: <T,>(...p: unknown[]) => sql.prepare(q).all<T>(...p)[0],
    }),
  };
  return { sql, raw };
}

export function memSecrets(): SecretPort & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    set: (k, v) => (map.set(k, v), true),
    get: (k) => map.get(k) ?? null,
    clear: (k) => void map.delete(k),
  };
}

export function session(over: Partial<RoutableSession> = {}): RoutableSession {
  return {
    id: over.id ?? `s-${Math.random().toString(36).slice(2, 10)}`,
    project_id: 'p',
    cwd: '',
    jsonl_path: '/tmp/x.jsonl',
    jsonl_mtime: 0,
    state: 'idle',
    archived: 0,
    title: null,
    user_title: null,
    ...over,
  };
}

/** Name-substring resolver, enough to exercise the router's toSession branch. */
function simpleResolve(rows: RoutableSession[], ref: string) {
  const q = ref.toLowerCase();
  const hits = rows.filter((r) => r.id.startsWith(q) || (r.user_title || r.title || '').toLowerCase().includes(q));
  return hits.length === 1 ? { session: hits[0] } : { error: hits.length ? 'ambiguous' : 'none' };
}

export interface RecordingPort extends SessionPort {
  rows: RoutableSession[];
  running: Set<string>;
  turns: Array<{ sessionId: string; text: string }>;
  interrupts: Array<{ sessionId: string; text: string }>;
  notes: string[];
  /** Every text handed to a session by either path. */
  delivered(): string[];
}

export function recordingPort(rows: RoutableSession[] = []): RecordingPort {
  const port: RecordingPort = {
    rows,
    running: new Set(),
    turns: [],
    interrupts: [],
    notes: [],
    listSessions: () => port.rows,
    resolveSession: simpleResolve,
    isRunning: (id) => port.running.has(id),
    queueInterrupt: (id, text) => void port.interrupts.push({ sessionId: id, text }),
    startTurn: (s, text) => void port.turns.push({ sessionId: s.id, text }),
    getOrCreateInboxSession: () => {
      let s = port.rows.find((r) => r.title === 'A2A inbox');
      if (!s) {
        s = session({ id: 'inbox', title: 'A2A inbox' });
        port.rows.push(s);
      }
      return s;
    },
    notify: (t, b) => void port.notes.push(`${t}: ${b}`),
    delivered: () => [...port.turns, ...port.interrupts].map((x) => x.text),
  };
  return port;
}

let _certCache: TlsIdentity[] = [];
/** Fresh cert per node (cheap with P-256, but cache a few across a file). */
export function cert(i: number): TlsIdentity {
  while (_certCache.length <= i) {
    _certCache.push(generateSelfSignedCert({ commonName: `test-${_certCache.length}`, ips: ['127.0.0.1'], dnsNames: ['localhost'] }));
  }
  return _certCache[i];
}

export interface TestNode {
  node: A2ANode;
  port: RecordingPort;
  sql: SqlHandle;
  secrets: ReturnType<typeof memSecrets>;
  cidrs: string[];
  clock: { now: number };
}

export async function makeNode(opts: {
  name: string;
  certIndex: number;
  rows?: RoutableSession[];
  cidrs?: string[];
  tls?: TlsIdentity;
}): Promise<TestNode> {
  const { sql } = await makeSql();
  const secrets = memSecrets();
  const port = recordingPort(opts.rows ?? []);
  const dir = mkdtempSync(join(tmpdir(), 'a2a-test-'));
  const cidrs = opts.cidrs ?? ['127.0.0.0/8'];
  const clock = { now: Date.now() };
  const node = new A2ANode({
    sql,
    secrets,
    sessions: port,
    auditPath: join(dir, 'audit.jsonl'),
    tls: opts.tls ?? cert(opts.certIndex),
    host: '127.0.0.1',
    port: 0,
    allowCidrs: () => cidrs,
    displayName: opts.name,
    userName: opts.name.toLowerCase(),
    agentKind: 'guycode',
    appVersion: 'test',
    now: () => clock.now,
  });
  await node.start();
  return { node, port, sql, secrets, cidrs, clock };
}

/** Pair b with a (a invites, b redeems). Returns each side's handle for the other. */
export async function pair(a: TestNode, b: TestNode): Promise<{ aSeesB: string; bSeesA: string }> {
  const { code } = a.node.invite();
  const peerA = await b.node.redeem(code);
  const peerB = a.node.store.listPeers().find((p) => p.card_url === b.node.cardUrl())!;
  return { aSeesB: peerB.peer_id, bSeesA: peerA.peer_id };
}
