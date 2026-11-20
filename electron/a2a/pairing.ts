/**
 * Pairing (design 4.3): one exchange per pair of people that yields a bearer
 * token in each direction and pins each side's certificate.
 *
 *   inviter A                                  redeemer B
 *   ---------                                  ----------
 *   createInvite() -> "a2a1:<base64url json>"  --(Slack / paste)-->
 *                                              redeemCode(code):
 *                                                fetch A's card, pinned to code.certSha256
 *                                                POST /a2a-pair {inviteId, inviteSecret,
 *                                                  myCardUrl, myCertSha256, myDisplayName,
 *                                                  tokenForYouToCallMe}
 *   acceptPair(): burn invite, store B  <------
 *   -> {tokenForMeToCallYou}            ------>  store A
 *
 * The invite secret is 128-bit, single use, expires after 15 minutes, is
 * stored only as a SHA-256 and compared in constant time (store.consumeInvite).
 * A leaked code after redemption is useless.
 */
import { A2AProtocolError } from './errors';
import { normaliseFingerprint } from './tls';
import { newToken, type A2AStore, type PeerRow } from './store';
import type { AgentKind, PairingCodePayload, PairRequest, PairResponse } from './types';
import { CertPinMismatchError, baseUrlOf, fetchCard, redeemPairing } from './client';

export const PAIRING_CODE_PREFIX = 'a2a1:';

export function encodePairingCode(p: PairingCodePayload): string {
  return PAIRING_CODE_PREFIX + Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

/** Decode and shape-check a pairing code. Throws a plain-English error on anything off. */
export function decodePairingCode(code: string): PairingCodePayload {
  // People paste codes out of Slack with surrounding quotes, backticks or line breaks.
  const s = String(code ?? '').replace(/[\s`'"]/g, '');
  if (!s.startsWith(PAIRING_CODE_PREFIX)) throw new Error('That is not an A2A pairing code (it should start with "a2a1:").');
  let p: PairingCodePayload;
  try {
    p = JSON.parse(Buffer.from(s.slice(PAIRING_CODE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('The pairing code is damaged (could not decode it). Ask for a fresh one.');
  }
  const fp = normaliseFingerprint(p?.certSha256);
  if (!p || typeof p.cardUrl !== 'string' || fp.length !== 64 || typeof p.inviteId !== 'string' || typeof p.inviteSecret !== 'string' || typeof p.expires !== 'number') {
    throw new Error('The pairing code is incomplete. Ask for a fresh one.');
  }
  try {
    const u = new URL(p.cardUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad scheme');
  } catch {
    throw new Error('The pairing code has an invalid address in it.');
  }
  return { ...p, certSha256: fp, displayName: String(p.displayName ?? '') };
}

export interface LocalIdentity {
  /** Our public card URL, e.g. https://10.30.1.23:7427/.well-known/agent-card.json */
  cardUrl: string;
  certSha256: string;
  displayName: string;
  agentKind: AgentKind;
}

export function createInvite(store: A2AStore, me: LocalIdentity, ttlMs: number, now = Date.now()): { code: string; expires: number; inviteId: string } {
  const inv = store.createInvite(ttlMs, now);
  const code = encodePairingCode({
    cardUrl: me.cardUrl,
    certSha256: me.certSha256,
    inviteId: inv.inviteId,
    inviteSecret: inv.inviteSecret,
    expires: inv.expires,
    displayName: me.displayName,
  });
  return { code, expires: inv.expires, inviteId: inv.inviteId };
}

/**
 * Server side of POST /a2a-pair. Validates shape, burns the invite, and
 * stores the new peer at trust `inform`. `allowHttp` is true only when the
 * local endpoint itself runs with a2a.insecureHttp (tests).
 */
export async function acceptPair(
  store: A2AStore,
  req: PairRequest,
  me: LocalIdentity,
  opts: { allowHttp: boolean; now?: number; verifyPeerCard?: boolean }
): Promise<{ response: PairResponse; peer: PeerRow }> {
  const bad = (msg: string) => new A2AProtocolError(400, 'INVALID_REQUEST', msg);
  if (!req || typeof req !== 'object') throw bad('Body must be a pairing request object.');
  const fp = normaliseFingerprint(req.myCertSha256);
  if (fp.length !== 64) throw bad('myCertSha256 must be a SHA-256 hex fingerprint.');
  if (typeof req.tokenForYouToCallMe !== 'string' || req.tokenForYouToCallMe.length < 32 || req.tokenForYouToCallMe.length > 512) {
    throw bad('tokenForYouToCallMe must be a random token of at least 32 characters.');
  }
  let cardUrl: URL;
  try {
    cardUrl = new URL(String(req.myCardUrl));
  } catch {
    throw bad('myCardUrl is not a URL.');
  }
  if (cardUrl.protocol !== 'https:' && !(opts.allowHttp && cardUrl.protocol === 'http:')) throw bad('myCardUrl must be https.');

  const check = store.consumeInvite(String(req.inviteId ?? ''), String(req.inviteSecret ?? ''), opts.now);
  if (check !== 'ok') {
    // Unknown and wrong-secret look the same from outside so the endpoint is not
    // an oracle for which invite ids exist.
    const msg =
      check === 'expired'
        ? 'This pairing code has expired (codes last 15 minutes). Ask for a fresh one.'
        : check === 'used'
          ? 'This pairing code has already been used. Ask for a fresh one.'
          : 'This pairing code is not valid.';
    const reason = check === 'expired' ? 'INVITE_EXPIRED' : check === 'used' ? 'INVITE_USED' : 'INVITE_INVALID';
    throw new A2AProtocolError(403, reason, msg);
  }

  // Best effort: confirm the redeemer's endpoint really presents the cert it
  // claims, and keep its card. A pin mismatch means the request is lying about
  // its own identity, so refuse. Unreachable is tolerated: inform traffic from
  // them to us still works, and the first call back will surface the problem.
  let cardJson: string | null = null;
  if (opts.verifyPeerCard !== false) {
    try {
      const card = await fetchCard({ baseUrl: baseUrlOf(cardUrl.toString()), certSha256: fp }, 3000);
      cardJson = JSON.stringify(card);
    } catch (e) {
      if (e instanceof CertPinMismatchError) {
        throw new A2AProtocolError(400, 'INVALID_REQUEST', 'Your endpoint does not present the certificate named in myCertSha256.');
      }
    }
  }

  const displayName = String(req.myDisplayName ?? '').slice(0, 80) || cardUrl.hostname;
  const agentKind: AgentKind = req.myAgentKind === 'guycode' || req.myAgentKind === 'claude-code' ? req.myAgentKind : 'other';
  const tokenForMeToCallYou = newToken();
  const peerId = store.allocatePeerId(displayName, cardUrl.toString());
  const peer = store.savePairedPeer({
    peerId,
    displayName,
    agentKind,
    cardUrl: cardUrl.toString(),
    certSha256: fp,
    tokenOut: req.tokenForYouToCallMe,
    tokenIn: tokenForMeToCallYou,
    cardJson,
    now: opts.now,
  });
  return { response: { tokenForMeToCallYou, displayName: me.displayName, agentKind: me.agentKind }, peer };
}

/** Client side: redeem a code someone sent us. Returns the stored peer. */
export async function redeemCode(store: A2AStore, code: string, me: LocalIdentity, now = Date.now()): Promise<PeerRow> {
  const p = decodePairingCode(code);
  if (now > p.expires) throw new Error('This pairing code has expired (codes last 15 minutes). Ask for a fresh one.');
  if (normaliseFingerprint(p.certSha256) === normaliseFingerprint(me.certSha256)) {
    throw new Error('That is your own pairing code. Send it to the other person instead.');
  }
  const ep = { baseUrl: baseUrlOf(p.cardUrl), certSha256: p.certSha256 };
  // Fetch the card first: it proves the pin before we send anything that matters.
  const card = await fetchCard(ep, 5000);
  const tokenForYouToCallMe = newToken();
  const res = await redeemPairing(ep, {
    inviteId: p.inviteId,
    inviteSecret: p.inviteSecret,
    myCardUrl: me.cardUrl,
    myCertSha256: me.certSha256,
    myDisplayName: me.displayName,
    myAgentKind: me.agentKind,
    tokenForYouToCallMe,
  });
  if (!res || typeof res.tokenForMeToCallYou !== 'string' || res.tokenForMeToCallYou.length < 32) {
    throw new Error('The other agent answered the pairing request with something unexpected.');
  }
  const displayName = String(res.displayName || p.displayName || card.name || new URL(p.cardUrl).hostname).slice(0, 80);
  const agentKind: AgentKind = res.agentKind === 'guycode' || res.agentKind === 'claude-code' ? res.agentKind : 'other';
  return store.savePairedPeer({
    peerId: store.allocatePeerId(displayName, p.cardUrl),
    displayName,
    agentKind,
    cardUrl: p.cardUrl,
    certSha256: p.certSha256,
    tokenOut: res.tokenForMeToCallYou,
    tokenIn: tokenForYouToCallMe,
    cardJson: JSON.stringify(card),
    now,
  });
}
