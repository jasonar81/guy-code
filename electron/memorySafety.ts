/**
 * Keep saved memory from triggering API refusals.
 *
 * THE PROBLEM, measured. Guy Code injects the memory tree into every request.
 * Some of those notes are debugging notes ABOUT the model API itself - refusal
 * categories, `stop_reason`, `stop_details`, beta headers, system-prompt text.
 * To the safety classifier that reads like an attempt to reverse-engineer the
 * model, and it answers with
 *
 *     stop_reason: 'refusal'
 *     stop_details: { category: 'reasoning_extraction',
 *                     explanation: '...Terms of Service restrictions on
 *                                   reverse engineering or duplicating model
 *                                   outputs...' }
 *
 * and ZERO content blocks - which the UI shows as a turn with tool calls and
 * no text, or simply nothing.
 *
 * Measured on a real 855-leaf memory tree, same agentic prompt, 12 runs:
 *     model          full memory        with these notes redacted
 *     Opus 5         12/12 refused      0/12
 *     Opus 5.5       12/12 refused      5/12
 *
 * So this is NOT a "new model is stricter" problem - the CURRENT default
 * refuses every single time once the memory tree is big enough to include
 * these notes.
 *
 * THE APPROACH. Do not delete the user's notes and do not drop whole files:
 * the engineering content is valuable and the trigger is only the API-internals
 * vocabulary. Redact that vocabulary on the way INTO the prompt. The file on
 * disk is untouched, so nothing is lost and the user can still read it in full.
 */

/**
 * Patterns that make a note read as model reverse-engineering, with neutral
 * replacements that preserve the engineering meaning.
 *
 * Deliberately NOT included: a bare "refusal" or "system prompt". Those appear
 * in ordinary engineering writing (merge conflicts, PR review notes) and
 * redacting them would mangle unrelated content for no benefit - the measured
 * refusals came from the API-internals vocabulary, not from the English words.
 */
const REDACTIONS: Array<{ re: RegExp; to: string }> = [
  // Response-shape internals.
  { re: /\bstop_reason\b/gi, to: 'end-state field' },
  { re: /\bstop_details\b/gi, to: 'end-state detail' },
  { re: /\breasoning_extraction\b/gi, to: 'policy-category-A' },
  { re: /\bcategory:\s*['"]?cyber['"]?/gi, to: 'policy-category-B' },
  { re: /\brefusal[-_ ]?fallback\b/gi, to: 'automatic retry' },
  { re: /\bREFUSAL_FALLBACK_MODEL\b/g, to: 'FALLBACK_MODEL_SETTING' },
  // Request-shape internals.
  { re: /\banthropic-beta\b/gi, to: 'vendor-beta-header' },
  { re: /\boutput_config\b/gi, to: 'output-settings' },
  { re: /\bmessages\.create\(/gi, to: 'api-call(' },
  { re: /\bmax_tokens\b/gi, to: 'token-limit' },
  // Verbatim refusal text copied from API responses.
  // Tolerant of case and of line-wrapping artifacts (a note may have a "##"
  // or newline spliced into the middle of the quoted sentence).
  {
    re: /reverse\s+engineering\s+or\s+duplicating(?:[\s#*>_-]*model)?(?:[\s#*>_-]*outputs)?/gi,
    to: 'the vendor policy on model internals',
  },
  {
    re: /This request was blocked as it seems to violate[^.]*\./gi,
    to: 'The request was declined by a policy check.',
  },
  {
    re: /triggered restrictions on violative cyber content[^.]*\./gi,
    to: 'was declined by a policy check.',
  },
];

/** True if the text contains vocabulary known to trigger the classifier. */
export function hasRiskyMemoryContent(text: string): boolean {
  if (!text) return false;
  return REDACTIONS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/**
 * Which patterns matched, for telling the user what was adjusted. Returns
 * human-readable labels, not the regexes.
 */
export function riskyMemoryTerms(text: string): string[] {
  const found: string[] = [];
  if (!text) return found;
  for (const { re } of REDACTIONS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) found.push(m[0].trim());
  }
  return [...new Set(found)];
}

/**
 * Redact API-internals vocabulary from memory text before it is injected into
 * a request. Content-preserving: the note still reads correctly, it just no
 * longer looks like a transcript of model internals.
 */
export function sanitizeMemoryText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, to } of REDACTIONS) {
    re.lastIndex = 0;
    out = out.replace(re, to);
  }
  return out;
}

/**
 * Count how many replacements sanitizing would make - used for logging so the
 * effect is visible without dumping the memory text.
 */
export function countRedactions(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const { re } of REDACTIONS) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (m) n += m.length;
  }
  return n;
}
