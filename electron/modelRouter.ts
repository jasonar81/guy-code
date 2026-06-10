// Smart model routing.
//
// Goal: use a CHEAPER model when a turn clearly doesn't need a top-tier model
// (simple question, lookup, small clear edit), and the STRONG model when it
// does (complex/multi-step coding, ambiguous, correctness-critical, agentic).
// Cost control without sacrificing quality.
//
// Safety (never route a hard task to a cheap model):
//   - Bias to STRONG whenever the cheap router is uncertain.
//   - Respect a user-set minimum-model FLOOR.
//   - Anything that looks agentic / continues an existing tool-using turn stays
//     STRONG.
//   - Escalation (handled in agent.ts, reusing the refusal-fallback path): if a
//     cheap model errors or its output looks low-confidence, re-run on strong.
//
// The router itself is a single cheap Haiku call, gated to only run when smart
// routing is enabled and the turn is a fresh user message.

import log from 'electron-log';
import { getClient } from './anthropic';

/** Cheap model used for the routing decision itself. */
const ROUTER_MODEL = 'claude-haiku-4-5';

/** Default cheap model a turn is routed DOWN to. */
export const DEFAULT_CHEAP_MODEL = 'claude-sonnet-4-6';

export type RouteTier = 'strong' | 'cheap';

export interface RouteDecision {
  tier: RouteTier;
  /** The concrete model id to use this turn. */
  model: string;
  reason: string;
  /** How the decision was reached (for logging/transparency). */
  via: 'router' | 'floor' | 'agentic' | 'disabled' | 'fallback';
}

/** Strip a [1m]-style context tag for family comparison. */
function bareId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

/** Rough capability rank so a "minimum model floor" can be enforced. */
function rank(model: string): number {
  const b = bareId(model);
  if (b.includes('haiku')) return 1;
  if (b.includes('sonnet')) return 2;
  if (b.includes('opus')) return 3;
  if (b.includes('fable') || b.includes('mythos')) return 3; // top tier
  return 3; // unknown -> treat as strong so we never under-serve
}

/**
 * Decide which model to use for a turn.
 *
 * @param userText      the fresh user message (empty for tool-continuation rounds)
 * @param strongModel   the user's configured top model (getSetting('model') || default)
 * @param cheapModel    the configured cheap model
 * @param floorModel    minimum-model floor (cheap routing can't go below this); '' = none
 * @param apiKeyId      key for the router call
 */
export async function classifyTurn(args: {
  userText: string;
  strongModel: string;
  cheapModel: string;
  floorModel?: string;
  apiKeyId?: string | null;
}): Promise<RouteDecision> {
  const { userText, strongModel, cheapModel, floorModel, apiKeyId } = args;

  // No fresh user message (tool-result continuation) -> keep strong; the turn
  // is already in flight and likely agentic.
  if (!userText || !userText.trim()) {
    return { tier: 'strong', model: strongModel, reason: 'continuation round', via: 'agentic' };
  }

  // If the floor is already at/above the cheap model, cheap routing is pointless.
  const effectiveCheap =
    floorModel && rank(floorModel) > rank(cheapModel) ? floorModel : cheapModel;

  try {
    const client = getClient(apiKeyId);
    const resp = await client.messages.create({
      model: ROUTER_MODEL,
      max_tokens: 256,
      system:
        'You are a routing classifier for a CODING AGENT. Decide whether the user message needs a TOP-TIER model or a cheaper model is sufficient. ' +
        'Answer "strong" for: writing or refactoring non-trivial code, multi-step or multi-file work, debugging, design/architecture, anything correctness-critical, ambiguous requests, or work that will require using many tools. ' +
        'Answer "cheap" ONLY for clearly simple turns: a factual question, a quick lookup, a tiny and unambiguous edit, a yes/no, or chit-chat. ' +
        'When in doubt, answer "strong". Respond with ONLY a JSON object: {"tier":"strong"|"cheap","reason":"<short>"}.',
      messages: [{ role: 'user', content: userText.slice(0, 4000) }],
    });
    const text = (resp.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    const parsed = parseDecision(text);
    if (!parsed) throw new Error('router returned no parseable decision');

    if (parsed.tier === 'cheap') {
      return {
        tier: 'cheap',
        model: effectiveCheap,
        reason: parsed.reason || 'router: simple turn',
        via: floorModel && effectiveCheap === floorModel ? 'floor' : 'router',
      };
    }
    return { tier: 'strong', model: strongModel, reason: parsed.reason || 'router: needs strong', via: 'router' };
  } catch (e) {
    // Any router failure -> STRONG (never under-serve a turn because the router
    // broke). Guard the log call too so a logging failure can't escape.
    try {
      log.warn(`[modelRouter] classify failed, using strong model: ${(e as Error).message}`);
    } catch {
      /* ignore */
    }
    return { tier: 'strong', model: strongModel, reason: 'router error', via: 'fallback' };
  }
}

function parseDecision(text: string): { tier: RouteTier; reason: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1));
    const tier = o.tier === 'cheap' ? 'cheap' : o.tier === 'strong' ? 'strong' : null;
    if (!tier) return null;
    return { tier, reason: typeof o.reason === 'string' ? o.reason : '' };
  } catch {
    return null;
  }
}

export const __testing = { rank, bareId, parseDecision };
