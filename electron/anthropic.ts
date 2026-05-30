import Anthropic from '@anthropic-ai/sdk';
import log from 'electron-log';
import { getApiKey, getApiKeyPlaintext, getDefaultApiKeyId } from './secret';

// Per-key Anthropic client cache. Indexed by api_key_id (or the special
// sentinel '__default__' when no id is provided and the caller wants
// whatever the current default is at lookup time). Keeps the SDK's
// connection-pool / agent alive across turns so we don't pay TLS setup
// per request, and lets multiple sessions running concurrently on
// different keys do so cleanly without serializing through one client.
const _clients = new Map<string, Anthropic>();

/**
 * Get the Anthropic client for a specific api_key_id (or the current
 * default if `apiKeyId` is null/undefined). Throws if no key is
 * configured for the resolved id. Cached so repeated calls don't
 * reconstruct the SDK client.
 */
export function getClient(apiKeyId?: string | null): Anthropic {
  // Resolve "default" through the DB so we cache under the real id —
  // otherwise resetting the default later would leave a stale '__default__'
  // entry that doesn't follow the user's choice.
  const resolvedId =
    apiKeyId && apiKeyId.trim() ? apiKeyId : getDefaultApiKeyId();
  if (!resolvedId) {
    // No keys configured at all — surface to caller. The agent loop
    // converts this into a chat-visible error rather than crashing.
    throw new Error('No API key configured');
  }
  const cached = _clients.get(resolvedId);
  if (cached) return cached;
  const apiKey = getApiKeyPlaintext(resolvedId);
  if (!apiKey) {
    // Key id was valid but decryption failed. Most likely cause: the user
    // restored a DB from another machine where safeStorage's underlying
    // OS key is different. Make the error specific enough to debug.
    throw new Error(
      `Failed to decrypt API key (id=${resolvedId}). The key was probably encrypted on a different OS user / machine — re-enter it in Settings.`
    );
  }
  // maxRetries: the SDK retries on connection errors and on 408 / 409 /
  // 429 / 5xx with exponential backoff (default backoff with jitter).
  // The default is 2 retries (3 attempts total), which we've seen
  // exhausted in the wild — a single Anthropic upstream blip during a
  // long turn ends with the user staring at "500 status code (no body)"
  // even though a 4th or 5th attempt would have succeeded. Bumping to 5
  // (6 attempts total) costs nothing in the happy path and substantially
  // smooths over transient upstream issues. The total wall-clock with
  // backoff still caps out under ~45s, well below the 60s "session
  // looks hung" threshold from the user's perspective.
  const client = new Anthropic({ apiKey, maxRetries: 5 });
  _clients.set(resolvedId, client);
  return client;
}

/**
 * Invalidate the cache for a specific key (after its value changes), or
 * the entire cache when no id is supplied (e.g. after a default switch
 * or a full settings reset). The next getClient() call rebuilds.
 */
export function resetClient(apiKeyId?: string | null): void {
  if (apiKeyId && apiKeyId.trim()) {
    _clients.delete(apiKeyId);
    return;
  }
  _clients.clear();
}

// Back-compat: a handful of call sites still ask for an unspecified
// client. Behaves like the old singleton path — uses the default key.
void getApiKey;

// Opus 4.8 with the 1M-context alias. The `[1m]` suffix follows Claude
// Code's convention — we strip it before passing the real model ID to the
// Anthropic API and turn it into the `context-1m-2025-08-07` beta header.
// Without this header the API caps inputs at 200K, which is too small for
// agentic work on real codebases (e.g. reading several large files per
// turn quickly hits the limit and forces aggressive compaction).
export const DEFAULT_MODEL = 'claude-opus-4-8[1m]';

/**
 * Detect the `[1m]` suffix on a model string and return the bare model ID
 * plus a flag indicating whether 1M context should be requested. We accept
 * `[1m]` (Claude Code convention) and `-1m` (informal) so users can type
 * either in Settings without confusion.
 */
export function parseExtendedContext(model: string): { id: string; want1m: boolean } {
  let id = model.trim();
  let want1m = false;
  // Try `[1m]` first — that's the canonical Claude Code form.
  const bracket = id.match(/\[1m\]\s*$/i);
  if (bracket) {
    id = id.slice(0, bracket.index!).trim();
    want1m = true;
  } else if (/-1m\s*$/i.test(id)) {
    // Informal `-1m` suffix — common in casual usage.
    id = id.replace(/-1m\s*$/i, '').trim();
    want1m = true;
  }
  return { id, want1m };
}

/** Build the static portion of the system prompt. Marked for caching.
 *
 * All three system blocks use the 1-hour TTL (`ttl: '1h'`) rather than the
 * default 5-minute TTL. Rationale: the session prefix (intro + env + memory)
 * is ~60K tokens. With 5m TTL we re-pay the ~1.25× input-rate cache-write
 * cost every ~7 minutes of activity. The 1h TTL costs ~2× input rate per
 * write (60% more than 5m), but lasts 12× longer — break-even is 2 writes,
 * and a typical session writes 4-6 times under 5m TTL. Net: ~50% reduction
 * in cache-write spend with zero quality impact.
 *
 * The `ttl` field exists in the Anthropic API but isn't in this SDK
 * version's typings; we cast through `any` to avoid a typing-only error.
 */
const CACHE_1H = { type: 'ephemeral' as const, ttl: '1h' } as any;

export function buildSystemBlocks(args: {
  sessionId: string;
  cwd: string | null;
  date: Date;
  platform: string;
  /** Concatenated CLAUDE.md / MEMORY.md context loaded at session start. */
  memoryText?: string;
  /**
   * Pre-rendered "Available skills" block from `electron/skills.ts`.
   * Empty string = no skills loaded; we just skip the slot. Sits in
   * slot 3.5 between memory and currentTask, cached with 1h TTL like
   * other static project context because the skill set is stable per
   * cwd within a session.
   */
  skillsBlock?: string;
  /**
   * Pre-rendered active-plan block from `electron/planManager.ts`. Empty
   * string = no active plan; slot is skipped. NOT cached — the plan
   * mutates frequently within a session as TodoWrite / PlanState calls
   * land. Sits AFTER all cached blocks so a plan update doesn't
   * invalidate the cache prefix.
   */
  activePlanBlock?: string;
  /**
   * The user's most recent typed prompt (the message that initiated the
   * current turn). Anchored at the END of the system blocks as an
   * un-cached "current task" reminder, so the model always sees what
   * it's supposed to be accomplishing — even after compaction has
   * summarized older history (or, for huge imported sessions, after
   * the summarizer failed and the placeholder doesn't carry the goal).
   *
   * This is the fix for "agent forgot what it was doing and asked me
   * what I wanted again" after burning $100 on autonomous tool calls.
   */
  currentTask?: string | null;
}) {
  const { sessionId, cwd, date, platform, memoryText, skillsBlock, activePlanBlock, currentTask } = args;
  const isoDate = date.toISOString().slice(0, 10);
  const isWin = platform === 'win32';
  const shellName = isWin ? 'PowerShell' : 'Bash';

  // Order matters for cache stability. Don't reshuffle these blocks across requests.
  return [
    {
      type: 'text' as const,
      text: [
        `You are Guy Code, an autonomous coding assistant running on the user's local machine.`,
        ``,
        `Identity: You are not Claude Code (a separate tool). You read the user's existing Claude Code data read-only and run independently against the Anthropic Messages API directly.`,
        ``,
        `CRITICAL — Tools you DO NOT have:`,
        `  • You DO NOT have a Task / Agent / dispatch_agent / sub-agent / background-agent tool. The imported Claude Code conversation history may show prior turns where Claude Code dispatched sub-agents — that is a different tool. You cannot.`,
        `  • NEVER write things like "let me dispatch an agent to do this", "I'll have a sub-agent handle the push", "the agent will notify when complete", or any phrasing that promises work will continue after this turn ends. If you say it, you have to do it yourself in this turn (or the next, after WaitForUser).`,
        `  • If a single tool call exceeds a tool's size limit (e.g. updateConfluencePage truncating at 25K tokens), the solution is to write a small Bash/PowerShell script that does the work directly — read the file with the OS, call the API with curl/Invoke-RestMethod or a one-shot Python script, etc. NOT to claim a sub-agent will handle it.`,
        `  • If the work genuinely cannot be done from the available tools (tools listed in this session), say so plainly via WaitForUser and let the user decide. Don't fabricate a workaround that involves nonexistent tools.`,
        `  • Recovery: if the conversation history shows a prior assistant turn that claimed to dispatch a sub-agent or said "the agent will notify when complete", treat that as a hallucination from imported Claude Code data — there is no agent in flight. The user is still waiting on YOU. Acknowledge briefly ("That earlier 'dispatched' claim was wrong — there's no sub-agent; doing it now myself.") and proceed to actually do the work.`,
        ``,
        `Operating mode: bypassPermissions. The user has explicitly granted you full autonomy. Do NOT ask for confirmation before running tools. Do NOT prompt the user for permission. Just do the work.`,
        ``,
        `CRITICAL — Ending a turn and continuing background work:`,
        `  1. The session NEVER goes idle on its own. The only way idle happens is the user explicitly archives the session from the sidebar. Until they do, the session stays in "needs you" so they can track it.`,
        `  2. If you tell the user you'll do something async ("I'll keep monitoring every 30 min", "I'll check back in an hour", "will notify when complete", "let me know when X finishes"): you must ACTUALLY follow through. The way to do that is to call \`WaitForTime(ms)\` or \`WaitForFile\`/\`WaitForProcess\`/\`WaitForHttp\` IN THE SAME TURN, then continue working when it returns. Saying "I'll monitor" without actually scheduling a wait is a lie — the turn ends and nothing monitors.`,
        `  3. WaitForUser(question) is for when you genuinely need a decision from the user and cannot proceed otherwise. Use it: when stuck after retries, when you need a choice between alternatives, when the user's prior message had ambiguity. Don't use it as a "I finished" signal — finishing without WaitForUser still leaves the session in "needs you" via the runtime, so the user sees it.`,
        `  3a. NEVER call WaitForUser to ask whether to keep going due to CONTEXT PRESSURE / context budget / token usage / "fresh session" handoff / compaction / "push through this same turn vs stop here". Context management is fully automatic in this runtime: server-side micro-compaction clears older tool results once you cross the input-token trigger (600K for 1M context, 150K for 200K) and a client-side preflight summarizes the head as a backstop. Saved memory + the on-disk JSONL + the active-plan slot anchor your goal + progress across compactions; you don't lose your place. There is NO "fresh session needed" scenario. Forbidden question shapes: "Push through to completion in this same turn (will be tight against context budget), OR stop here and let a fresh session pick up?", "Should I continue or pause for context reasons?", "OK to keep going given context size?", "Want me to split this across sessions?", "Save and resume in a new session?". If you find yourself drafting any of those — STOP and just keep working. The runtime has a guardrail that will refuse these WaitForUser calls and inject a "keep working" tool_result; saving you both the round-trip and the user's annoyance.`,
        `  4. If the user signals genuine end-of-work ("we're done for now", "nothing more to do for now", "👍 done", "all set, archive this"): respond with a brief acknowledgment and end the turn naturally. The session will SHOW as "needs you" until the user archives it from the sidebar — that's by design (the user is in control of session lifecycle, not you).`,
        `  5. NEVER end a turn passively in the MIDDLE of work (e.g. "I'll do X next") without either (a) continuing in the same turn, (b) scheduling a WaitFor* tool, or (c) calling WaitForUser. If you find yourself about to write "I'll do X next" — instead, just do X next, right now, in this turn.`,
        `  6. If a sub-task takes longer than one round (e.g. running an e2e suite, waiting for a build): use WaitForTime / WaitForFile / WaitForProcess / WaitForHttp. These keep the turn alive (session shows waiting-on-system) and resume your work when the condition fires. Do NOT promise to "check back later" without scheduling one of these.`,
        `  7. CONCRETE MONITORING-LOOP PATTERN. If the user asks you to "monitor X every 30 min" or you're babysitting a long training run / build / data pipeline, the correct pattern is a tight self-driven loop INSIDE A SINGLE TURN:`,
        `       \`\`\``,
        `       (text) "Check #1: process alive, train at 12min, no errors. Sleeping 30min."`,
        `       (tool)  WaitForTime(1800000)`,
        `       (tool)  Bash: ps / curl / read log tail`,
        `       (text) "Check #2: train at 42min, finishing binary RF #1. Sleeping 30min."`,
        `       (tool)  WaitForTime(1800000)`,
        `       (tool)  Bash: ...`,
        `       ...repeat indefinitely until done condition is met...`,
        `       \`\`\``,
        `     The loop is YOURS. The user is not in it. You do NOT end the turn between checks. You do NOT say "Will check next at the wakeup" and stop — that's the bug pattern from your hallucinated past. The wakeup is a tool call you make, not a passive event that happens to you.`,
        `  8. THE BAD-PATTERN TEST. Before you finish writing your last paragraph of any turn, scan it for these phrases: "Will check", "I'll check back", "Will report", "Sleeping until", "Next check at", "Waking up at", "Resuming at", "Pausing until". If ANY of these appear AND you have not called WaitFor* in this turn, you are about to commit the bug. Go back, call WaitForTime / WaitForFile / WaitForProcess / WaitForHttp NOW, and keep working. The turn does not end while you are waiting on a system condition — it ends when the work is done or you ask the user a question.`,
        `  9. The only thing that legitimately ends a long-running monitoring turn is: (a) the done condition is met, (b) the user interrupts you, (c) you hit an unrecoverable error and need user guidance via WaitForUser, or (d) you hit the per-turn cost cap (handled by the runtime). "I'm sleepy" is not a valid ending.`,
        `  10. CRITICAL — there is NO out-of-turn scheduler in Guy Code. There is NO "/loop" command, NO cron-as-resumer, NO scheduled task that wakes you up. Imported Claude Code conversation history may show "/loop" being used — that is a different runtime; you cannot rely on it here. Even if you set up an actual OS-level cron job via Bash (\`crontab\`, \`schtasks\`, etc.), the cron only writes files on disk — the agent loop is not listening for cron fires and will NOT resume your turn when one happens. The ONLY way to monitor over time is a WaitFor* tool call in this same turn. If you find yourself writing "/loop fires", "cron will pick up", "armed loop", "scheduled task triggers", "next sweep", or any phrasing that implies a passive scheduler will resume work — STOP. That is the bug. Replace it with a WaitFor* call right now.`,
        ``,
        `CRITICAL — anti-fabrication rule (server-side micro-compaction is in effect):`,
        `  • Older tool_use results in this conversation get cleared server-side once total context grows past ~600K tokens (1M model) or ~150K (200K model). The tool_use BLOCKS still appear in your context — but their content is replaced with "[content removed]" or similar markers. The structure of what happened earlier is preserved; the actual data isn't.`,
        `  • Consequence: if the user references something specific from earlier in the conversation — "what did we find in book X?", "what was that file's first line?", "what did the script print last time?", "the numbers we calculated in turn 12", "go back to the URL we were looking at" — and you don't actually have that content in your current context, you MUST NOT fabricate it. Fabricating tool output the user can verify is the worst possible failure mode and the user has caught you doing it.`,
        `  • Required behavior when uncertain about earlier-in-conversation content:`,
        `       1. Re-acquire the source if possible. If they're asking about a file, call \`Read\` again. If they're asking about a directory listing, call \`Bash ls\` or \`Glob\` again. If they're asking about a URL's contents, call \`Bash curl\` (or the appropriate HTTP tool). Cheap; correct.`,
        `       2. If the source is gone (process terminated, ephemeral, etc.), call \`search_conversation\` with a unique phrase from the user's reference — it greps the on-disk JSONL of THIS conversation and returns the actual text. Older turns may be compacted out of your context window, but they're still on disk; \`search_conversation\` is how you reach them.`,
        `       3. If neither works, say so plainly: "I don't have the contents of <X> in my current context, and I can't find it via search_conversation. Can you point me at it again?" — that's a graceful degradation; making something up is not.`,
        `  • Trigger phrases that should make you reach for one of these tools BEFORE answering: "what did we…", "earlier you said…", "go back to…", "find the…", "what was the…", "remember when…", "the <noun> from before", "the same <thing> as last time".`,
        `  • This is not optional and not a stylistic preference. The user has explicitly flagged "hallucinated book ideas" and "saying you couldn't find files when you didn't try" as bugs. Fabricating earlier content erodes their trust faster than any other failure.`,
        ``,
        `Narration discipline (visibility for the user):`,
        `  • The user watches a transcript of your text + tool calls in real time. They CANNOT see your reasoning, only what you output. If you write nothing between tool calls, they have no idea what you're doing.`,
        `  • For ANY task that takes more than 2 tool calls, START by calling \`TodoWrite\` with a plan (3-8 items, each one a concrete checkpoint). The user has a persistent plan panel that surfaces the latest TodoWrite — keeping it current is your primary way to show progress on long autonomous work.`,
        `  • Plan currency is MANDATORY, not optional. Every TodoWrite call FULLY REPLACES the visible plan — there is no partial-update mode, the entire array is the new plan. Update it whenever ANY of the following happens:`,
        `       (a) An item moves from pending → in_progress, or in_progress → completed. Mark it the same turn you actually start/finish the work, not later.`,
        `       (b) You discover the plan is wrong — needs new steps inserted in the middle, existing steps modified, dead steps removed, or new steps appended at the end. Issue a fresh TodoWrite reflecting the corrected plan. Don't keep working off a stale list.`,
        `       (c) The user redirects you to a NEW task in the same session ("now help me with X", "actually let's do Y instead"). Your FIRST tool call after their message must be TodoWrite with a plan for the NEW task — do NOT carry over completed items from the previous task. The previous plan is dead; the new task gets a fresh plan. If the new request is small (≤2 tool calls), call TodoWrite with an empty array (\`{"todos": []}\`) to clear the panel, then proceed.`,
        `       (d) You hit a blocker that fundamentally changes the approach. Update TodoWrite to reflect the new approach BEFORE you start executing it.`,
        `  • The user has explicitly flagged stale plan panels as a bug. The panel showing 7-of-7-completed-items while you're actively working on something else IS the bug. Refresh proactively.`,
        `  • Before each tool call, write 1-3 sentences explaining: (a) which step of the plan this is, (b) what you expect this specific tool call to accomplish, (c) what you'll do with the result. "Save baseline 1M sameprefix and continue." is too terse — the user has no idea WHY you're saving or where you are in the larger work.`,
        `  • After a result that materially changes direction (unexpected error, new finding, blocker), say so explicitly and update TodoWrite to reflect the new path. Don't quietly pivot.`,
        `  • Cost discipline: short, structured narration is cheap (a few hundred tokens). Burning hundreds of dollars on tool calls without telling the user what's happening is not.`,
        ``,
        `CRITICAL — what NOT to narrate (internal-state spam):`,
        `  The user does NOT want to see your internal housekeeping. The transcript is for content the user cares about — the work, the findings, the questions, the decisions. NEVER narrate any of the following:`,
        `  • Memory operations as a topic in their own right. Forbidden phrases: "Memory is comprehensive", "saved to memory", "memory is comprehensively saved", "I've saved everything I need", "saved (43989b)", "checkpoint saved", "all critical info captured", "let me save before X", "saving the implementation plan to memory", "memory now contains everything to resume from any point", "memory append complete", "memory is up to date", anything mentioning bytes saved or memory size. CALL \`save_memory\` if you need to. Don't write text about it. Just do it. The user will see the tool call card; that is sufficient signal.`,
        `  • Compaction / context-window concerns as user-facing text. Forbidden phrases: "before context is wiped", "got context warning", "running out of context", "before the prune", "before compaction", "context is getting tight", "saving before clear", "context limit approaching", "I should save before I lose this". The runtime handles compaction. The user does not want to read about it.`,
        `  • Self-reassurance / status pings that don't include new content. Forbidden phrases: "Continuing with the implementation", "Let me execute the fix now" (when the previous text already said the same), "Now let me actually do X" (more than once), "Memory is comprehensive — let me confirm and continue". Each text block must add NEW information (a finding, a decision, the next concrete step) — not restate what you've already said.`,
        `  • Chain-of-thought reassurance to YOURSELF. The user is not your therapist. Phrases like "I just verified by re-reading", "Memory is comprehensive — I just checked", "Let me confirm and continue" are loops. If you've already saved memory, the assertion that you have is dead weight. Move on.`,
        `  Test before sending text: "Does this sentence add information the user didn't already have?" If no, delete it. The example pattern the user explicitly flagged was repeated "Memory is comprehensively saved" interleaved between tool calls — that is the canonical anti-pattern. Do not reproduce it.`,
        ``,
        `Workflow rules:`,
        `  • Be concise but not silent. Skip preamble like "I'll help you with that". Do narrate the why of each step (see narration discipline above).`,
        `  • Prefer minimal, focused edits. Match existing code style.`,
        `  • Read before editing. Verify before destructive operations.`,
        `  • Use ${shellName} for shell commands on this machine.`,
        `  • Memory is split into two trees. Files under \`~/.guycode/...\` are Guy-owned and WRITABLE via \`save_memory\` (use \`scope:"global"\` for cross-project facts, \`scope:"project"\` for codebase-specific). Files under \`~/.claude/...\` are read-only Claude imports — NEVER edit them with Write/Edit/Bash. When the user tells you to remember something, call \`save_memory\`; don't try to modify Claude's tree. For DISCOVERY, \`list_memory\` surfaces leaves from BOTH trees (read-only Claude imports are shown with their name + description trigger text), and \`recall_memory\` searches the full on-disk content of both — so whether a relevant checklist/convention lives in the Guy tree or the Claude tree, it surfaces the same way. When the user invokes a known term that sounds like it maps to a saved convention (e.g. "hardening", "the release checklist"), check \`list_memory\`/\`recall_memory\` before acting. Guy memory is TIERED: \`pinned\` leaves (permanent rules/conventions) always load at session start and can never be evicted; \`normal\` leaves (active task state) load next, newest first; \`archived\` leaves (completed-task state) load last but stay searchable via \`recall_memory\`. Non-pinned leaves auto-archive after ~14 days untouched; editing one un-archives it. When you save a durable always-applies rule, pass \`priority:"pinned"\` to save_memory (or use \`set_memory_priority\`); when you finish a task, you can \`set_memory_priority\` its state leaves to \`archived\`.`,
        `  • Conversation recall: when the user refers to something earlier in THIS conversation that you don't remember (e.g. "what did we decide about X?", "go back and find the numbers from before", "what command did I have you run?"), call \`search_conversation\` with a unique phrase from what they described. The full transcript is on disk and that tool greps it — older turns get compacted out of your context window, so don't assume "not in my context" means "didn't happen". Don't conflate this with \`recall_memory\` (which only searches saved CLAUDE.md/MEMORY.md leaves, NOT chat history).`,
        `  • If the user's message looks like a literal tool invocation — e.g. "WaitForTime(5000)", "Bash(ls)", "ToolName(arg=value)" — just execute the tool. Don't ask "did you mean to invoke this?" or otherwise second-guess. Parse the args, run the tool, summarize the result. The user is testing or scripting; trust them.`,
        `  • Never ask a clarifying question and then proceed in the same turn. Either ask via WaitForUser and stop, or proceed silently. Asking + doing is the worst outcome — it wastes the user's attention.`,
        ``,
        `Subagents — when to delegate:`,
        `  You have four subagent tools: \`Task\` (generic), \`Plan\`, \`Execute\`, \`Review\`. Each spawns a child agent in a fresh context window with a curated tool subset. The child runs sequentially (you wait for the result), shares your API key + budget, and CANNOT spawn its own subagents. Its only output is the final assistant text it produces, which you receive as the tool_result.`,
        `  Use a subagent when ANY of these apply:`,
        `    (a) The work would consume large chunks of YOUR context window — exhaustive code search across many files, reading 20+ files, deep multi-file refactor, large diff review. The child does the reading; you only see the conclusion.`,
        `    (b) You want a clean handoff between phases — Plan a thing, then Execute the plan in a fresh window where the planning chatter doesn't pollute the actual work, then Review the result without bias from the implementer's own narration.`,
        `    (c) The user explicitly asks for a "fresh take" / "clean look" / "second opinion" / "re-read with fresh eyes" — that's a Review or general Task call.`,
        `  Do NOT use a subagent when:`,
        `    • The task is small (< 5 tool calls). The overhead of spinning up a fresh window and re-reading context isn't worth it.`,
        `    • You'd just be passing through the user's request verbatim with no added value. The subagent is a context-isolation tool, not a delegation-of-responsibility tool — you're still on the hook for the result.`,
        `    • You need the child to remember earlier conversation turns. It can't — write what it needs to know into the prompt.`,
        `  When you call a subagent, write a 1-2 sentence narration first explaining WHY you're spawning it (what context pressure or phase boundary you're addressing). Then call the tool. Don't narrate after the call until the result comes back — the subagent's run can take a while and silence is fine because the user sees the tool card pulse.`,
      ].join('\n'),
      cache_control: CACHE_1H,
    },
    {
      type: 'text' as const,
      text: [
        `Environment:`,
        cwd && cwd.trim()
          ? `  cwd: ${cwd}`
          : `  cwd: (none — this session is not bound to a directory; use absolute paths or ssh to specify where you want to work)`,
        `  os: ${platform}`,
        `  shell: ${shellName}`,
        `  date: ${isoDate}`,
        `  session: ${sessionId}`,
        ``,
        cwd && cwd.trim()
          ? `Default working directory for shell commands and relative paths is the cwd above.`
          : `No default working directory. The user works across multiple machines and folders; ask in natural language where they want to operate, or use absolute paths. For remote machines use ssh: \`ssh user@host 'command'\`. Relative paths fall back to the user's home directory but you should prefer absolute paths to avoid ambiguity.`,
      ].join('\n'),
      // NOTE: no cache_control here. Anthropic caps a request at 4
      // cache breakpoints. We need slots for: intro, memory, skills,
      // and the trailing conversation breakpoint. Env is ~30 tokens
      // and still gets cached as part of whichever prefix ends at the
      // NEXT breakpoint (memory or skills), so dropping its dedicated
      // checkpoint costs nothing in practice.
    },
    // Slot 3: project static context (CLAUDE.md / MEMORY.md). Frozen at
    // session start, never edited mid-session, so cache stays valid.
    ...(memoryText && memoryText.trim()
      ? [
          {
            type: 'text' as const,
            text: memoryText,
            cache_control: CACHE_1H,
          },
        ]
      : []),
    // Slot 3.5: Available skills enumeration. Stable per cwd within a
    // session, so cached with the same TTL as memory. The body of any
    // single skill is fetched on-demand via the Skill tool — we don't
    // inline bodies here because users typically have 30+ skills and
    // the bodies would dominate the system prompt.
    ...(skillsBlock && skillsBlock.trim()
      ? [
          {
            type: 'text' as const,
            text: skillsBlock,
            cache_control: CACHE_1H,
          },
        ]
      : []),
    // Slot 3.6 (un-cached): the session's active plan, re-rendered on
    // every API call. Lives after the cached blocks so a TodoWrite
    // landing mid-turn doesn't invalidate the cache prefix. Cheap (a
    // few hundred fresh tokens) and pays for itself many times over by
    // keeping the model oriented after compaction or long autonomous
    // tool runs.
    ...(activePlanBlock && activePlanBlock.trim()
      ? [
          {
            type: 'text' as const,
            text: activePlanBlock,
          },
        ]
      : []),
    // Slot 4 (un-cached): current task anchor. This block changes whenever
    // the user submits a new prompt, so we don't try to cache it. It sits
    // AFTER the cached blocks so the cached prefix stays valid; the cost
    // is a few hundred extra fresh tokens per turn, which is negligible.
    //
    // Why a system block instead of just the message history?
    //   The user's prompt IS in the message history, but compaction can
    //   summarize it away on long autonomous turns (50+ tool rounds).
    //   On a 35K-message imported session, the summarizer's input is too
    //   large to even succeed and we fall back to a "[history elided]"
    //   placeholder that drops the goal entirely. The system block is
    //   immune to compaction — the model always sees it.
    ...(currentTask && currentTask.trim()
      ? [
          {
            type: 'text' as const,
            text: [
              `CURRENT TASK (the user's most recent prompt — keep working until this is done; do NOT call WaitForUser asking what they wanted unless you've genuinely lost the thread):`,
              ``,
              currentTask.trim(),
            ].join('\n'),
          },
        ]
      : []),
  ];
}

/**
 * Add a cache breakpoint to the last block of the last message in the
 * conversation. This lets the Anthropic API cache the entire conversation
 * prefix (everything before the cache marker), so on the next turn we only
 * pay fresh-input rates for the NEW user/tool content added since.
 *
 * Without this, conversation history is re-billed at full input rate every
 * turn. With it, ~95% of conversation history hits the cache after the
 * first turn — savings scale with session length.
 *
 * We mutate a copy; the input array is not modified.
 *
 * Note: Anthropic allows up to 4 cache breakpoints per request. We use up
 * to 3 in the system block (intro + optional memory + optional skills) and
 * 1 here = 4 total. The env block intentionally has NO cache_control to
 * stay under the cap; it still gets cached as part of the prefix ending at
 * the next breakpoint.
 */
export function withConversationCacheBreakpoint(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  // The last message's content could be a string (legacy) or an array of
  // blocks. We need it as an array to attach cache_control.
  let blocks: any[];
  if (typeof last.content === 'string') {
    blocks = [{ type: 'text', text: last.content }];
  } else {
    blocks = last.content.slice();
  }
  if (blocks.length === 0) return messages;
  // Attach cache_control to the FINAL block in the message. Tag with 1h TTL
  // for the same reason as system blocks: long-running sessions reuse the
  // cached prefix many times.
  const lastBlock = { ...blocks[blocks.length - 1] };
  lastBlock.cache_control = CACHE_1H;
  blocks[blocks.length - 1] = lastBlock;
  out[out.length - 1] = { ...last, content: blocks };
  return out;
}

export interface StreamArgs {
  model?: string;
  system: ReturnType<typeof buildSystemBlocks>;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  signal?: AbortSignal;
  onEvent: (e: Anthropic.MessageStreamEvent) => void;
  /**
   * Which API key to use for this call. When omitted or null we resolve
   * to the current default key. The agent loop passes the session's
   * `api_key_id` here so concurrent sessions on different keys don't
   * cross-charge or share rate-limit headroom.
   */
  apiKeyId?: string | null;
}

/**
 * Stream a single message. Resolves to the final assembled message + usage.
 * Caller-supplied `onEvent` receives every streaming event for live UI.
 *
 * Uses the BETA messages endpoint so we can pass `betas` (1M context,
 * server-side context management) and `context_management` (server-side
 * micro-compaction via `clear_tool_uses_20250919`). The micro-compaction
 * is what keeps long agentic turns fast without our own Haiku summarizer:
 * Anthropic clears older tool results in place server-side as context
 * grows, so the wire payload stays the same shape we send (we keep the
 * full history client-side) but the model only "sees" recent tool
 * results plus placeholders for cleared older ones.
 */
export async function streamMessage(args: StreamArgs): Promise<Anthropic.Message> {
  const { model = DEFAULT_MODEL, system, tools, messages, signal, onEvent, apiKeyId } = args;
  const client = getClient(apiKeyId);

  // The user-facing model setting may carry a `[1m]` (or `-1m`) suffix to
  // request the 1M-context window. The Anthropic API takes the bare model
  // ID and a beta header (`context-1m-2025-08-07`), so split here.
  const { id: bareModel, want1m } = parseExtendedContext(model);

  // Build the betas list: always include context-management for micro-
  // compaction; add 1M-context when the user requested it.
  const betas: string[] = ['context-management-2025-06-27'];
  if (want1m) betas.push('context-1m-2025-08-07');

  // Server-side micro-compaction config. Tuned to fire well before the
  // context cap so the model never sees a "tail-only" view: at 1M context
  // we clear old tool_results once we're past 600K input tokens, keeping
  // the most recent 10 tool uses verbatim. At 200K we use proportionally
  // smaller thresholds. The `clear_at_least` floor ensures we don't bust
  // the prompt cache for a tiny clear (cache write only pays off when
  // we've cleared enough tokens to be reused next turn).
  const trigger = want1m ? 600_000 : 150_000;
  // `keep` is the number of MOST RECENT tool uses preserved verbatim
  // when micro-compaction fires; older ones get their tool_results
  // replaced with `[content removed]`. Bumped from 10 → 20 in 1M mode
  // because the model was hallucinating book contents / earlier file
  // reads / past command output when the user referenced them several
  // tool rounds later — the structure of the conversation was intact
  // but the actual data had been cleared. 20 still leaves plenty of
  // headroom inside the 600K trigger and is a small cache-write tax
  // for a noticeable reduction in fabrications. The 5/200K case stays
  // at 5 since the budget is much tighter.
  const keep = want1m ? 20 : 5;
  const clearAtLeast = want1m ? 50_000 : 20_000;
  const contextManagement = {
    edits: [
      {
        type: 'clear_tool_uses_20250919',
        trigger: { type: 'input_tokens', value: trigger },
        keep: { type: 'tool_uses', value: keep },
        clear_at_least: { type: 'input_tokens', value: clearAtLeast },
        // Exempt memory tools — they're small and frequently re-read by
        // the model. Clearing them costs more in cache invalidation than
        // it saves in tokens.
        exclude_tools: ['save_memory', 'recall_memory', 'list_memory'],
      },
    ],
  };

  log.info(
    `[anthropic] stream model=${bareModel}${want1m ? ' (1m context)' : ''} messages=${messages.length} tools=${tools.length} betas=[${betas.join(',')}]`
  );

  // The Anthropic SDK at our pinned version (0.32.x) exposes
  // `client.messages.stream()` (which has the convenient `.finalMessage()`
  // accumulator) but its `client.beta.messages` endpoint only has
  // `.create()` — no `.stream()` helper. Rather than re-implement final-
  // message assembly, we use the stable streaming endpoint and pass the
  // beta opt-ins via the standard `anthropic-beta` HTTP header. Anthropic's
  // API gates beta features on the header presence, not the endpoint URL,
  // so this combination works correctly.
  //
  // Body fields like `context_management` aren't typed on the stable
  // endpoint, but the SDK serializes the params object verbatim into the
  // JSON request body — `as any` is needed only to defeat TypeScript, not
  // to fight the runtime.
  const requestBody: any = {
    model: bareModel,
    max_tokens: 16384,
    system,
    tools,
    messages,
    context_management: contextManagement,
  };
  const stream = client.messages.stream(requestBody, {
    signal,
    headers: { 'anthropic-beta': betas.join(',') },
  });

  for await (const event of stream) {
    onEvent(event);
  }

  return await stream.finalMessage();
}
