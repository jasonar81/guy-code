/**
 * Detect "should I stop or keep going due to context budget?" questions
 * that the model emits via WaitForUser.
 *
 * These questions are an anti-pattern. Context management is fully
 * automatic in Guy Code:
 *
 *   • Server-side micro-compaction
 *     (`context_management.clear_tool_uses_20250919`) clears older tool
 *     results in place once we cross the input-token trigger (600K for
 *     1M context, 150K for 200K).
 *   • Client-side `preflightCompactIfNeeded` summarizes the head as a
 *     backstop before any request that would otherwise exceed the cap.
 *   • Saved memory + the on-disk JSONL + the active-plan slot anchor
 *     goal + progress across compactions; the model doesn't lose its
 *     place. There is no "fresh session needed" scenario.
 *
 * The agent loop intercepts WaitForUser calls whose `question` matches
 * one of these patterns, synthesizes a tool_result telling the model
 * "context is automatic; keep working", and continues the loop. See
 * `electron/agent.ts` runUserTurn() for the integration site.
 *
 * Pattern philosophy:
 *   • Each pattern is "context-anchored" — must mention context, budget,
 *     compaction, fresh session, saved memory, or another concept that
 *     uniquely identifies a bail-out question. Bare "should I continue?"
 *     is NOT flagged because that's a legitimate branching question in
 *     many situations.
 *   • False positives are bounded by `MAX_CONTEXT_BAIL_NUDGES` in the
 *     agent loop — after 4 hits the next matching question is accepted
 *     as a real WaitForUser. So a model with genuinely novel context-
 *     pressure logic isn't silenced forever.
 *   • False negatives are the actual bug we're fixing. Skew aggressive.
 */

/**
 * Regex patterns that mark a WaitForUser question as context-bail.
 *
 * `exec` order doesn't matter — `looksLikeContextBail` returns true on
 * the FIRST match. Each pattern is commented with the exemplar
 * phrasing it was added to catch.
 */
const CONTEXT_BAIL_PATTERNS: ReadonlyArray<RegExp> = [
  // "context budget" / "context window" / "context room" / "context
  // remaining" — every one of these as a noun phrase implies the model
  // is fishing for permission based on space concerns.
  /\bcontext\s+(budget|window|cap|limit|tight|space|room|pressure|remaining|left|usage)\b/i,
  // "tight against context" / "tight against budget" / "tight against tokens"
  /\btight\s+against\s+(context|budget|the\s+context|the\s+budget|tokens?)\b/i,
  // "fresh session" — this phrase almost never appears outside the
  // bail-out anti-pattern. The system has no notion of a "fresh
  // session" continuation handoff; every session is durable.
  /\bfresh\s+session\b/i,
  // "new session" combined with pickup language
  /\bnew\s+session\b[^\n]{0,80}\b(pick(s|ing)?\s+up|resume[sd]?|continue[sd]?|take(s|ing)?\s+over|start(s|ing)?\s+(over|fresh))\b/i,
  // "next session" combined with pickup language (the user's exemplar
  // uses this verbatim: "let a fresh session pick up from the saved
  // memory" + "the next session can pick up"). Match in either
  // direction since the model can phrase it as "next session can
  // resume" OR "I'll resume in the next session".
  /\bnext\s+session\b[^\n]{0,80}\b(pick(s|ing)?\s+up|resume[sd]?|continue[sd]?|take(s|ing)?\s+over|start(s|ing)?\s+(over|fresh))\b/i,
  /\b(pick(s|ing)?\s+up|resume[sd]?|continue[sd]?|take(s|ing)?\s+over)\b[^\n]{0,80}\bnext\s+session\b/i,
  // "saved X to memory" / "saved everything to memory" — phrasing only
  // ever produced when the model is about to ask whether to bail. We
  // already have a `saved\s+memor` pattern but it requires adjacency;
  // the user's exemplar reads "saved everything to memory" with words
  // between `saved` and `memory`.
  /\bsaved\s+\w+(\s+\w+){0,3}\s+to\s+memor(y|ies)\b/i,
  // "stop here and X" — almost always frames a context bail-out
  /\bstop\s+here\s+and\b/i,
  // "in this same turn" — alone is fine, but when paired with a bail
  // verb in the same question it's the user's exemplar.
  /\bin\s+this\s+same\s+turn\b/i,
  // "push through" + completion / context / tight / budget / turn
  /\bpush\s+through\b[^\n]{0,80}\b(completion|to\s+completion|the\s+turn|context|tight|budget|window|memory)\b/i,
  // "saved memory" + (pick up | resume | next/fresh/new session)
  /\bsaved\s+memor(y|ies)\b[^\n]{0,80}\b(pick\s+up|resume[sd]?|next\s+session|fresh\s+session|new\s+session)\b/i,
  // The "OR stop here" / "OR pause" choice framing
  /\b\bOR\s+(stop|pause|halt|pick\s+up|resume|continue)\b/i,
  // "split [work/task] across [sessions/turns]". Permissive on the
  // intermediate words so "split this work across multiple sessions"
  // / "split it between two turns" / "split across sessions" all hit.
  /\bsplit\b[^\n]{0,40}\b(across|between)\b[^\n]{0,20}\b(sessions|turns)\b/i,
  // Direct context-pressure self-narration framed as a question
  /\bcontext\s+(is|gets|getting|getting\s+too)\s+(tight|full|approaching|near|low)\b/i,
];

/**
 * True when the WaitForUser question reads like a context-bail
 * (asking the user for permission to keep going due to context size /
 * token budget / "fresh session" handoff).
 *
 * Returns false for empty input and for legitimate clarifying
 * questions ("should I also handle the wrap case?", "do you want me
 * to delete the file?"), which never trip any of the patterns.
 */
export function looksLikeContextBail(question: string): boolean {
  if (!question || !question.trim()) return false;
  for (const re of CONTEXT_BAIL_PATTERNS) {
    if (re.test(question)) return true;
  }
  return false;
}

/**
 * Tool-result content the agent loop injects in place of the refused
 * WaitForUser. The `nudgesUsed` / `maxNudges` parameters let the
 * caller surface the bound to the model so it knows the guardrail
 * will eventually fall through if it keeps trying.
 */
export function buildContextBailNudge(
  nudgesUsed: number,
  maxNudges: number
): string {
  const ratio = `${nudgesUsed} / ${maxNudges}`;
  const last = nudgesUsed >= maxNudges;
  return (
    'SYSTEM GUARDRAIL — context management is fully automatic. ' +
    'Server-side micro-compaction clears older tool results once you cross ' +
    'the input-token trigger (600K for 1M context, 150K for 200K). The ' +
    'client-side preflight is a backstop that summarizes the head before ' +
    'any request that would otherwise exceed the cap. Saved memory + the ' +
    "on-disk JSONL + the active-plan slot anchor your goal + progress " +
    "across compactions; you don't lose your place. " +
    'NEVER call WaitForUser to ask whether to continue due to context ' +
    'pressure / context budget / token usage / "fresh session" handoff / ' +
    '"push through this same turn vs stop here". Just keep working. The ' +
    'user does NOT want to be asked these questions. ' +
    (last
      ? `(This is your LAST guardrail nudge — guardrail used ${ratio}. Next context-bail WaitForUser will go through.)`
      : `(Guardrail nudges used: ${ratio}. Keep working.)`)
  );
}
