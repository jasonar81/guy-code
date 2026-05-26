/**
 * Tests for `src/lib/narration.ts` — the assistant-text internal-narration
 * filter that mutes preamble noise (memory/compaction/self-reassurance)
 * in the chat transcript without modifying the underlying JSONL.
 *
 * Strategy: drive the public API directly with the actual exemplar text
 * blocks the user pasted (paraphrased to canonical phrasings used in
 * real assistant output). Every paragraph the user explicitly flagged
 * MUST be muted; substantive content MUST NOT be. Fenced code blocks
 * are always substantive even if the surrounding prose contains
 * narration words.
 *
 * The cost model: false positives are visually cheap (text is just
 * smaller / dimmer), false negatives are the actual bug the user
 * complained about. Tests skew toward exhaustive flagging.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyAssistantText,
  isInternalNarration,
  splitIntoChunks,
} from '../src/lib/narration';

// ----- splitIntoChunks --------------------------------------------------

describe('splitIntoChunks', () => {
  it('empty / whitespace returns []', () => {
    expect(splitIntoChunks('')).toEqual([]);
    expect(splitIntoChunks('   ')).toEqual([]);
    expect(splitIntoChunks('\n\n\n')).toEqual([]);
  });

  it('single paragraph stays single', () => {
    expect(splitIntoChunks('Hello world.')).toEqual(['Hello world.']);
  });

  it('splits paragraphs on blank lines', () => {
    const chunks = splitIntoChunks('para one.\n\npara two.');
    expect(chunks).toEqual(['para one.', 'para two.']);
  });

  it('collapses multiple blank-line separators', () => {
    const chunks = splitIntoChunks('A.\n\n\n\nB.');
    expect(chunks).toEqual(['A.', 'B.']);
  });

  it('keeps line-internal newlines (single \\n inside a paragraph)', () => {
    const chunks = splitIntoChunks('line 1\nline 2\n\npara two');
    expect(chunks).toEqual(['line 1\nline 2', 'para two']);
  });

  it('fenced code blocks are atomic (blank lines inside do NOT split)', () => {
    const text = [
      'before code.',
      '',
      '```ts',
      'const x = 1;',
      '',
      'const y = 2;',
      '```',
      '',
      'after code.',
    ].join('\n');
    const chunks = splitIntoChunks(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe('before code.');
    expect(chunks[1]).toBe('```ts\nconst x = 1;\n\nconst y = 2;\n```');
    expect(chunks[2]).toBe('after code.');
  });

  it('handles a fence at start of input', () => {
    const text = '```\ncode\n```\n\nafter.';
    expect(splitIntoChunks(text)).toEqual(['```\ncode\n```', 'after.']);
  });

  it('handles an unclosed fence by treating the rest of the input as one chunk', () => {
    // Defensive: if the model produces a malformed fence, we must not
    // crash and we must not split prose that follows. Keeping the
    // remainder atomic is conservative — code rendering may look
    // wrong but the chunker has no way to know where the fence
    // intended to close.
    const text = '```\ncode line 1\n\ncode line 2\n\nstill in fence';
    const chunks = splitIntoChunks(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('still in fence');
  });

  it('trims leading and trailing blank lines around the whole input', () => {
    const chunks = splitIntoChunks('\n\nhello.\n\nworld.\n\n');
    expect(chunks).toEqual(['hello.', 'world.']);
  });
});

// ----- isInternalNarration ----------------------------------------------

describe('isInternalNarration — exact phrases the user flagged', () => {
  // Direct exemplars copy-pasted (canonicalized) from the user's
  // bug report. Every one of these MUST be muted.
  const FLAGGED: ReadonlyArray<[string, string]> = [
    [
      'memory comprehensive preamble',
      'State is comprehensive in memory. Let me write the new stage_load and seeding logic.',
    ],
    [
      'comprehensive state already saved',
      'Comprehensive state already saved to memory. Let me execute the demo.py patch on net1:',
    ],
    [
      'fully captured with size',
      'State is fully captured in memory at demo_fleet_state (12.7KB). Let me append the very latest progress.',
    ],
    [
      'critical state saved with size',
      'I have all critical state saved to demo_fleet_state memory leaf (16.7KB). Let me save the remaining authoring decisions to memory before the cleanup.',
    ],
    [
      'state fully saved',
      'State fully saved. Let me push the bench.py update and finish more pieces in this turn before context compaction.',
    ],
    [
      'comprehensively saved in two leaves',
      'Memory is comprehensively saved already in both leaves (db38061_progress_state 27.6KB + db38061_tuple_slowness_session 26.5KB). Both auto-load next session.',
    ],
    [
      'no additional save needed',
      'Memory is comprehensively saved already in both leaves. All critical state preserved. No additional save needed.',
    ],
    [
      'context compaction mention',
      'Let me execute the fix now before context is wiped.',
    ],
    [
      'self-reassurance loop',
      'Memory is comprehensive — I just verified by re-reading.',
    ],
    [
      'continuing without content',
      'Continuing with the implementation.',
    ],
    [
      'now let me actually pivot',
      'Now let me actually do the patch.',
    ],
    [
      'saving the implementation plan',
      'Saving the implementation plan to memory.',
    ],
    [
      'next session resume',
      'Both auto-load next session — the next session can pick up where we left off.',
    ],
    [
      'save_memory mentioned in prose',
      'Let me call save_memory with the new leaf to capture this.',
    ],
    [
      'context getting tight',
      'Context is getting tight — saving now before the next compaction.',
    ],
    [
      'checkpoint saved',
      'Checkpoint saved. Continuing.',
    ],
  ];

  for (const [label, paragraph] of FLAGGED) {
    it(`flags: ${label}`, () => {
      expect(isInternalNarration(paragraph)).toBe(true);
    });
  }
});

describe('isInternalNarration — substantive content that must NOT be muted', () => {
  // Real prose from substantive assistant turns. None should match.
  const SUBSTANTIVE: ReadonlyArray<[string, string]> = [
    ['code action narration', 'Reading the file to see the current structure.'],
    [
      'tool-call narration',
      'I will use Bash to run the migration and then verify the schema.',
    ],
    ['plain question', 'Do you want me to also handle the wrap-around case?'],
    [
      'analysis paragraph',
      "The bug is that the watchdog watches scroll events, but the reset happens on DOM detach which doesn't emit a scroll event.",
    ],
    [
      'unrelated KB mention',
      'The compressed payload is about 42KB, which is still under the 1MB cap.',
    ],
    [
      'plain "memory" usage',
      'The model has a 200K context window in this configuration.',
    ],
    [
      'instructive list-item style',
      "Step 1: open the file. Step 2: edit it. Step 3: save the changes.",
    ],
    [
      'numeric findings',
      'Test run finished: 441 passed, 0 failed in 2.5 seconds.',
    ],
  ];

  for (const [label, paragraph] of SUBSTANTIVE) {
    it(`does NOT flag: ${label}`, () => {
      expect(isInternalNarration(paragraph)).toBe(false);
    });
  }

  it('code-fenced block is never narration even if it contains memory words', () => {
    const block = '```ts\n// save memory to disk\nfunction saveMemory() {}\n```';
    expect(isInternalNarration(block)).toBe(false);
  });

  it('empty / whitespace returns false', () => {
    expect(isInternalNarration('')).toBe(false);
    expect(isInternalNarration('   \n\t')).toBe(false);
  });
});

// ----- classifyAssistantText (end-to-end) --------------------------------

describe('classifyAssistantText', () => {
  it('a transcript chunk mixing narration + content classifies each paragraph correctly', () => {
    const text = [
      'State is comprehensive in memory. Let me execute the demo.py patch.',
      '',
      'Reading config.yaml to find the routing rules.',
      '',
      '```bash',
      'cat config.yaml | grep -i route',
      '```',
      '',
      'Memory is comprehensively saved already in both leaves (foo 12.0KB + bar 6.5KB).',
    ].join('\n');
    const chunks = classifyAssistantText(text);
    expect(chunks).toHaveLength(4);
    expect(chunks[0].muted).toBe(true); // memory preamble
    expect(chunks[1].muted).toBe(false); // tool action narration
    expect(chunks[2].muted).toBe(false); // code block
    expect(chunks[3].muted).toBe(true); // saved-in-leaves
  });

  it('empty input returns empty array (no chunks to render)', () => {
    expect(classifyAssistantText('')).toEqual([]);
    expect(classifyAssistantText('   ')).toEqual([]);
  });

  it('single substantive paragraph round-trips unchanged + unmuted', () => {
    const text = 'Here is the answer to your question.';
    const chunks = classifyAssistantText(text);
    expect(chunks).toEqual([{ text, muted: false }]);
  });

  it('single narration paragraph rendered muted with original text intact', () => {
    const text = 'State is fully captured in memory at session_X (8.4KB).';
    const chunks = classifyAssistantText(text);
    expect(chunks).toEqual([{ text, muted: true }]);
  });
});
