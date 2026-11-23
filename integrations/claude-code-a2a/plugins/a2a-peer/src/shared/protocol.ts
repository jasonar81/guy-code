/**
 * The plugin's view of the A2A protocol code: a re-export seam, NOT a fork.
 *
 * Design 7.2 / Q6 asked for the protocol code to be shared with Guy Code
 * "if practical". It is: everything below is Guy Code's own `electron/a2a`
 * module, imported by relative path and bundled into `dist/` by build.mjs.
 * None of those modules imports Electron (node.ts, server.ts, client.ts,
 * store.ts, router.ts, pairing.ts, push.ts, waiters.ts, watch.ts, tls.ts,
 * envelope.ts, schema.ts, config.ts, audit.ts, types.ts, errors.ts were all
 * written Electron-free with injected ports for exactly this reason), and
 * `electron/conditionCheck.ts` holds the WaitForCondition runner on its own
 * so the daemon's watches use the very same shell handling.
 *
 * So a Guy Code endpoint and an a2a-peer daemon speak byte-for-byte the same
 * protocol: same routes, same pairing handshake, same push rules, same
 * envelope. A fix on one side is a fix on both. Keep every import of Guy Code
 * code going through this one file so the boundary stays visible.
 */
export { A2ANode, type A2ANodeOptions } from '../../../../../../electron/a2a/node';
export { A2A_SCHEMA_SQL, applyA2AP2Schema, applyA2AP3Schema, applyA2ARelaySchema } from '../../../../../../electron/a2a/schema';
export { type SecretPort, type SqlHandle, type PeerRow, type TaskRow } from '../../../../../../electron/a2a/store';
export { lastPathSegment, type RoutableSession, type SessionPort } from '../../../../../../electron/a2a/router';
export { buildEnvelope, parseEnvelope, HEADER_PREFIX } from '../../../../../../electron/a2a/envelope';
export { generateSelfSignedCert, fingerprintOfPem, type TlsIdentity } from '../../../../../../electron/a2a/tls';
export { relayNoteForPeer } from '../../../../../../electron/a2a/relayCrypto';
// CLAUDE_CODE_DEFAULT_PORT (7428) is what this plugin listens on. DEFAULT_PORT
// (7427) is Guy Code's and is re-exported only so the two can be named in
// error messages - the daemon must never fall back to it, or both would fight
// over one port on a machine running both.
export {
  DEFAULT_ALLOW_CIDRS,
  DEFAULT_PORT,
  CLAUDE_CODE_DEFAULT_PORT,
  parseCidr,
  resolveAdvertiseHost,
  resolveBindAddress,
} from '../../../../../../electron/a2a/config';
export { stateWord, stateWakes, type A2ATaskEvent } from '../../../../../../electron/a2a/waiters';
export { fmtDuration, type WatchCheckFn } from '../../../../../../electron/a2a/watch';
export { taskOutcomeText, partsText } from '../../../../../../electron/a2a/push';
export { TERMINAL_STATES, isTrustLevel, trustAtLeast, type AgentKind, type MessageKind, type Task, type TaskState, type TrustLevel } from '../../../../../../electron/a2a/types';
export { runConditionCheck } from '../../../../../../electron/conditionCheck';
export { escalationRefusal } from '../../../../../../electron/a2a/escalation';
