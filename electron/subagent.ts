// Subagent execution engine.
//
// A subagent is a fresh Anthropic call with a curated system prompt and
// curated tool subset, run synchronously from inside the parent agent's
// tool-execution loop. The parent's `Task` / `Plan` / `Execute` /
// `Review` tool calls land here.
//
// Why a subagent at all?
//   The user's primary motivation is **context isolation**: spinning up
//   a fresh window so planning, execution, and review don't bleed into
//   each other and so the parent's context window stays small. It's not
//   about parallelism — the user explicitly chose sequential-only,
//   single-child-at-a-time. The parent's tool call blocks until the
//   child returns its final text.
//
// Design constraints (per user):
//   • Sequential only. No parallel children. The parent waits.
//   • No recursion. Children cannot spawn grandchildren — `Task` and
//     friends are removed from every subagent toolset.
//   • Shares the parent's API key, cwd, and budget bucket. Subagent
//     turns DO NOT call `noteRunStart` / `noteRunEnd` because the
//     parent's reservation already covers them — over-reserving would
//     cause spurious budget blocks while the child runs.
//   • Spend lands in `usage_events` with the parent's `sessionId` /
//     `projectId` / `apiKeyId`, so per-session and per-key totals
//     stay correct and the audit trail reflects the actual cost.
//   • Cancel propagation: the parent's `AbortController` is forwarded
//     to the child's stream. A user-pressed Stop kills both.
//
// Not implemented (intentional, for v1):
//   • Live UI nesting. The user sees a single tool card for the parent's
//     `Task`/`Plan`/`Execute`/`Review` call with the final text as the
//     result. Intermediate child rounds are logged via electron-log but
//     not broadcast as separate cards.
//   • Per-run JSONL transcripts. The parent's tool_result captures the
//     contract. If we need step-by-step replay later we'll add it.

import Anthropic from '@anthropic-ai/sdk';
import log from 'electron-log';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getClient, DEFAULT_MODEL, parseExtendedContext } from './anthropic';
import { TOOLS, executeTool, type ToolContext } from './tools';
import { getMcpToolSchemas } from './mcp';
import { computeCostMicros } from './pricing';
import { insertUsageEvent } from './db';
import { precheckCall } from './budget';
import type { MemoryBundle } from './memory';

/** Roles supported by the subagent system. */
export type SubagentRole = 'plan' | 'execute' | 'review' | 'general';

/** Hard cap on rounds inside a single subagent run. */
const MAX_SUBAGENT_ROUNDS = 30;

/**
 * Tool subsets per role. Each entry is a list of native tool names; we
 * resolve them against the global `TOOLS` registry at call time so any
 * tool re-naming stays in sync. Notably absent from EVERY subset:
 *
 *   • `Task` / `Plan` / `Execute` / `Review` — no recursion.
 *   • `TodoWrite` — would pollute the parent's plan panel.
 *   • `WaitForUser` — subagents can't pause for the user; the parent is
 *     blocked anyway, so a wait would deadlock the whole run.
 *
 * MCP tools are intentionally NOT included: subagents are short-lived
 * helpers that should focus on the local codebase. If a parent needs
 * MCP, it should call the MCP tool itself.
 */
const ROLE_TOOLSETS: Record<SubagentRole, string[]> = {
  plan: [
    'Read',
    'Glob',
    'Grep',
    // SHELL is registered under either 'Bash' (POSIX) or 'PowerShell'
    // (Windows); we resolve dynamically below.
    'recall_memory',
    'list_memory',
    'list_skills',
    'read_skill',
    'search_conversation',
  ],
  execute: [
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'WaitForFile',
    'WaitForProcess',
    'WaitForTime',
    'WaitForHttp',
    'recall_memory',
    'list_memory',
    'list_skills',
    'read_skill',
    'search_conversation',
    'save_memory',
  ],
  review: [
    'Read',
    'Glob',
    'Grep',
    'recall_memory',
    'list_memory',
    'list_skills',
    'read_skill',
    'search_conversation',
  ],
  general: [
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'WaitForFile',
    'WaitForProcess',
    'WaitForTime',
    'WaitForHttp',
    'recall_memory',
    'list_memory',
    'list_skills',
    'read_skill',
    'search_conversation',
    'save_memory',
  ],
};

/**
 * Whether a role gets shell access. Plan/Execute/General can poke at
 * the system; Review is read-only and doesn't need shell.
 */
const ROLE_HAS_SHELL: Record<SubagentRole, boolean> = {
  plan: true,
  execute: true,
  review: true, // read-only commands like `git status`, `ls`, `cat` are fine
  general: true,
};

/**
 * Build the role-specific system prompt. Kept terse and deterministic
 * so it caches well across many subagent invocations within a session.
 */
function buildRoleSystemPrompt(role: SubagentRole, parentCwd: string): string {
  const cwdLine = parentCwd
    ? `Working directory: ${parentCwd}`
    : `Working directory: (none — use absolute paths)`;
  const common = [
    `You are a subagent invoked from a parent agent's tool call.`,
    `${cwdLine}`,
    ``,
    `Hard rules:`,
    `  • You CANNOT spawn further subagents. There is no Task / Plan / Execute / Review tool available to you.`,
    `  • You CANNOT update the parent's plan panel. There is no TodoWrite tool available to you.`,
    `  • You CANNOT pause for user input. There is no WaitForUser tool available to you.`,
    `  • You share the parent's API key and budget. Be efficient. Don't waste rounds on filler text.`,
    `  • End your final assistant turn with a stop_reason of 'end_turn' (no tool calls). The text content of that final turn is what the parent receives as your output.`,
    ``,
  ].join('\n');

  switch (role) {
    case 'plan':
      return [
        common,
        `Role: PLANNER`,
        ``,
        `Your job is to investigate the codebase and produce a concrete, actionable plan for the task in the user message. You do NOT execute the work — you only plan it.`,
        ``,
        `Method:`,
        `  1. Read enough of the codebase to ground your plan in real file paths, function names, and existing patterns. Use Read, Glob, Grep, recall_memory, search_conversation.`,
        `  2. Identify the smallest set of changes that delivers the task. Prefer modifying existing files over creating new ones.`,
        `  3. Surface risks: ambiguity, missing data, things that depend on the user's preference.`,
        ``,
        `Output (as your final assistant text, after any tool calls):`,
        `  • A numbered plan (3-12 steps), each step naming the files involved, the concrete change, and how to verify.`,
        `  • A "Risks & unknowns" section listing anything you're not sure about.`,
        `  • An effort estimate (S / M / L) with one-line justification.`,
        `Be specific. "Refactor auth" is not a step; "Edit src/auth.ts:checkSession to return null on expired token, update 3 callers in src/middleware/*.ts" is.`,
      ].join('\n');

    case 'execute':
      return [
        common,
        `Role: EXECUTOR`,
        ``,
        `Your job is to ship the change described in the user message. The parent has already decided what should happen; you write the code, run the verification, and report back.`,
        ``,
        `Method:`,
        `  1. Re-read the relevant files yourself before editing — don't trust paraphrased descriptions.`,
        `  2. Make the smallest change that meets the requirement. Match the surrounding code's style.`,
        `  3. If tests exist, run them after each significant change. Fix breakages before declaring done.`,
        `  4. If you hit a blocker (ambiguous requirement, missing dependency, broken test you can't fix), STOP and report — don't guess and don't expand scope.`,
        ``,
        `Output (as your final assistant text):`,
        `  • A "RESULT:" block listing what you changed (file paths + line ranges), what you verified (commands run + outcomes), and any caveats the parent should know about.`,
        `  • If you bailed on a blocker: explain what you tried, what's blocking you, and what input the parent would need to provide to unblock.`,
      ].join('\n');

    case 'review':
      return [
        common,
        `Role: REVIEWER`,
        ``,
        `Your job is to critique the work described in the user message. You do NOT modify any code — you only read and report.`,
        ``,
        `Method:`,
        `  1. Read the changed files in full (not just diffs — the diff context is often misleading).`,
        `  2. Look for: correctness bugs, security issues, perf regressions, style violations, tests that the change should have updated but didn't, edge cases the change doesn't handle.`,
        `  3. Cross-reference against existing tests and any project conventions you find via recall_memory.`,
        ``,
        `Output (as your final assistant text):`,
        `  • "Findings:" — one bullet per issue, ordered by severity. Each bullet names the file/line, describes the problem in one sentence, and proposes a fix in one sentence. NO speculation; if you're not sure, mark "(unverified)".`,
        `  • "Suggestions:" — non-blocking improvements (style, refactor opportunities). One bullet each.`,
        `  • A final verdict: "APPROVED" / "CHANGES REQUESTED" with a one-line summary.`,
        `If there are no findings, say so explicitly — don't pad.`,
      ].join('\n');

    case 'general':
    default:
      return [
        common,
        `Role: GENERAL TASK`,
        ``,
        `The parent has delegated a focused task to you. Read the user message carefully, then complete the task using the tools available. Stay scoped — don't expand into adjacent work.`,
        ``,
        `Output: a final assistant text block summarizing what you found / did / produced. The parent will use this as the result of its tool call.`,
      ].join('\n');
  }
}

/**
 * Build the tool list passed to Anthropic for this subagent run. Pulls
 * curated names from `ROLE_TOOLSETS`, optionally adds the platform's
 * shell tool, and resolves each name against the live registry.
 */
function buildToolSchemas(role: SubagentRole): Anthropic.Tool[] {
  const names = [...ROLE_TOOLSETS[role]];
  if (ROLE_HAS_SHELL[role]) {
    // SHELL registers as 'Bash' on POSIX and 'PowerShell' on Windows;
    // pick whichever's currently in the registry.
    if (TOOLS['Bash']) names.push('Bash');
    else if (TOOLS['PowerShell']) names.push('PowerShell');
  }
  const out: Anthropic.Tool[] = [];
  for (const n of names) {
    const t = TOOLS[n];
    if (t) out.push(t.schema);
    else log.warn(`[subagent] missing tool "${n}" for role ${role}`);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Caller-supplied parent context the subagent inherits. */
export interface SubagentParent {
  sessionId: string;
  projectId: string;
  cwd: string;
  /** API key id, or null to fall back to the current default. */
  apiKeyId: string | null;
  /** Forwarded to tools + the Anthropic stream so a parent cancel kills the child. */
  signal?: AbortSignal;
  /** Memory bundle to make available to recall_memory inside the child. */
  memory?: MemoryBundle;
  /** Model override; defaults to the parent's model (= DEFAULT_MODEL). */
  model?: string;
}

export interface SubagentInput {
  role: SubagentRole;
  /** Short title; used for logging, NOT part of the prompt. */
  description: string;
  /** The actual task body the subagent receives as its sole user message. */
  prompt: string;
}

/**
 * Run a subagent to completion and return its final assistant text.
 *
 * The function blocks the caller until either:
 *   • the model returns an end_turn response (success path),
 *   • `MAX_SUBAGENT_ROUNDS` is reached (hard timeout),
 *   • the parent's signal fires (cancellation),
 *   • the budget governor blocks the next round (we surface the reason).
 */
export async function runSubagent(
  parent: SubagentParent,
  input: SubagentInput
): Promise<string> {
  const runId = randomUUID().slice(0, 8);
  const tag = `subagent:${runId}:${input.role}`;
  log.info(`[${tag}] start description=${JSON.stringify(input.description)}`);

  const system = buildRoleSystemPrompt(input.role, parent.cwd);
  const tools = buildToolSchemas(input.role);
  const model = parent.model || DEFAULT_MODEL;

  // The child inherits the parent's tool context EXCEPT the projectId
  // filter — recall_memory should still see the project's memory. The
  // signal is critical: any subprocess started by the child needs to die
  // when the parent's Stop button is pressed.
  const toolCtx: ToolContext = {
    sessionId: parent.sessionId,
    cwd: parent.cwd || homedir(),
    projectId: parent.projectId,
    memory: parent.memory,
    signal: parent.signal,
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: input.prompt,
    },
  ];

  let finalText = '';
  for (let round = 0; round < MAX_SUBAGENT_ROUNDS; round++) {
    if (parent.signal?.aborted) {
      log.info(`[${tag}] aborted by parent before round ${round}`);
      throw new Error('subagent aborted by parent');
    }

    // Pre-flight budget check. Subagents share the parent's bucket; if
    // there's no headroom we bail with a structured message rather than
    // burning a request that the API would also block. Same per-API-call
    // semantics as the parent loop — every round of the subagent goes
    // through this gate. usage_events rows recorded under the parent's
    // sessionId mean `sessionHasCallInCurrentHour` returns true after the
    // first subagent round, so the parent + subagent share the single
    // min-one-call exemption per hour.
    const pre = precheckCall(parent.sessionId, parent.apiKeyId);
    if (!pre.allowed) {
      log.warn(`[${tag}] budget block on round ${round}: ${pre.reason}`);
      throw new Error(
        `subagent halted: budget governor blocked next round (${pre.reason || 'cap exceeded'})`
      );
    }

    const { id: bareModel, want1m } = parseExtendedContext(model);
    const betas: string[] = ['context-management-2025-06-27'];
    if (want1m) betas.push('context-1m-2025-08-07');

    const client = getClient(parent.apiKeyId);
    log.info(
      `[${tag}] round=${round} messages=${messages.length} tools=${tools.length}`
    );

    let response: Anthropic.Message;
    try {
      const stream = client.messages.stream(
        {
          model: bareModel,
          max_tokens: 16384,
          system,
          tools,
          messages,
          // Server-side micro-compaction: same shape the main agent uses,
          // tuned slightly tighter because subagents have shorter
          // expected lifespans.
          context_management: {
            edits: [
              {
                type: 'clear_tool_uses_20250919',
                trigger: {
                  type: 'input_tokens',
                  value: want1m ? 600_000 : 150_000,
                },
                keep: { type: 'tool_uses', value: want1m ? 20 : 5 },
                clear_at_least: {
                  type: 'input_tokens',
                  value: want1m ? 50_000 : 20_000,
                },
                exclude_tools: ['save_memory', 'recall_memory', 'list_memory'],
              },
            ],
          },
        } as any,
        {
          signal: parent.signal,
          headers: { 'anthropic-beta': betas.join(',') },
        }
      );
      // Consume the stream so the SDK pumps it; final message comes from
      // `finalMessage()`. We don't broadcast deltas to the UI for v1 —
      // the parent's tool card shows the final text only.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _evt of stream) {
        // intentionally empty
      }
      response = await stream.finalMessage();
    } catch (e: any) {
      if (parent.signal?.aborted) {
        log.info(`[${tag}] aborted during stream`);
        throw new Error('subagent aborted by parent');
      }
      log.warn(`[${tag}] stream failed: ${e?.message || e}`);
      throw e;
    }

    // ----- Cost accounting -----------------------------------------------
    const u = response.usage as any;
    const inputTokens = u.input_tokens ?? 0;
    const cacheReadTokens = u.cache_read_input_tokens ?? 0;
    const cacheCreate1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cacheCreate5m =
      u.cache_creation?.ephemeral_5m_input_tokens ??
      Math.max(0, (u.cache_creation_input_tokens ?? 0) - cacheCreate1h);
    const outputTokens = u.output_tokens ?? 0;
    const costUsdMicros = computeCostMicros(response.model, {
      inputTokens,
      cacheReadTokens,
      cacheWrite5mTokens: cacheCreate5m,
      cacheWrite1hTokens: cacheCreate1h,
      outputTokens,
    });
    insertUsageEvent({
      ts: Date.now(),
      projectId: parent.projectId,
      sessionId: parent.sessionId,
      // Tag the row so per-key audit can distinguish parent vs child.
      // We use the parent session id as the group key but prefix the
      // turn id so it's clear in the ledger this came from a subagent.
      turnId: `subagent-${runId}-${response.id}`,
      model: response.model,
      inputTokens,
      cacheReadTokens,
      cacheWrite5mTokens: cacheCreate5m,
      cacheWrite1hTokens: cacheCreate1h,
      outputTokens,
      costUsdMicros,
      source: 'live',
      apiKeyId: parent.apiKeyId,
    });

    // ----- Append assistant + tool dispatch ------------------------------
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(
      (b: any) => b.type === 'tool_use'
    ) as Anthropic.ToolUseBlock[];

    if (toolUses.length === 0) {
      // No tool calls → terminal turn. Concatenate text blocks for the
      // parent's tool_result.
      finalText = response.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
        .trim();
      log.info(
        `[${tag}] done in ${round + 1} rounds, finalText=${finalText.length}b`
      );
      break;
    }

    // Execute every tool_use sequentially. The block-content shape for a
    // user message containing tool_results is [tool_result, tool_result,
    // ...] — order matches the order the model called them.
    const toolResultBlocks: any[] = [];
    for (const tu of toolUses) {
      if (parent.signal?.aborted) {
        log.info(`[${tag}] aborted during tool dispatch`);
        throw new Error('subagent aborted by parent');
      }
      // Defense-in-depth against a model that hallucinates a tool name
      // we deliberately stripped from its toolset (e.g. Task). The
      // schema list is the contract; if it's not in `tools`, we error.
      const toolNames = new Set(tools.map((t) => t.name));
      if (!toolNames.has(tu.name)) {
        log.warn(
          `[${tag}] model called disallowed tool "${tu.name}" — refusing`
        );
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `error: tool "${tu.name}" is not available to subagents in role "${input.role}". Reply with your final answer using only the tools listed in your initial system prompt.`,
          is_error: true,
        });
        continue;
      }
      log.info(`[${tag}] tool=${tu.name}`);
      const r = await executeTool(tu.name, tu.input, toolCtx);
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: r.content,
        is_error: r.isError,
      });
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  if (!finalText) {
    log.warn(
      `[${tag}] hit MAX_SUBAGENT_ROUNDS (${MAX_SUBAGENT_ROUNDS}) without a terminal turn`
    );
    return `[subagent ${input.role} hit ${MAX_SUBAGENT_ROUNDS}-round cap without producing a final answer; partial work above may be useful but the run did not finish cleanly]`;
  }
  return finalText;
}

/**
 * Diagnostic: enumerate the tool names a given role gets. Used by tests
 * and by the debug console to sanity-check subset boundaries.
 */
export function toolsForRole(role: SubagentRole): string[] {
  const names = [...ROLE_TOOLSETS[role]];
  if (ROLE_HAS_SHELL[role]) {
    if (TOOLS['Bash']) names.push('Bash');
    else if (TOOLS['PowerShell']) names.push('PowerShell');
  }
  // Always include MCP tools? No — subagents are intentionally local-only.
  // Suppress unused-import warning by referencing the helper here.
  void getMcpToolSchemas;
  return names.sort();
}
