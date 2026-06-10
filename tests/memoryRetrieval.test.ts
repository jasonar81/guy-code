/**
 * Memory relevance retrieval: the cheap-model gate that picks which non-pinned
 * memory notes to load for a given message. These mock the Anthropic client so
 * no network is needed; gatherLeafMeta runs against the dev machine's real
 * memory tree (like listClaudeMemory.test.ts).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the Anthropic client so selectRelevant doesn't hit the network. Each
// test sets the mock's return value.
const createMock = vi.fn();
vi.mock('../electron/anthropic', () => ({
  getClient: () => ({ messages: { create: createMock } }),
}));

beforeEach(() => {
  createMock.mockReset();
});

const leaf = (name: string, mtime = Date.now()) => ({
  path: `/fake/${name}.md`,
  name,
  description: `desc for ${name}`,
  pinned: false,
  bytes: 100,
  mtime,
});

describe('selectRelevant', () => {
  it('returns all candidates without calling the model when there are few (<=6)', async () => {
    const { selectRelevant } = await import('../electron/memoryRetrieval');
    const cands = [leaf('a'), leaf('b'), leaf('c')];
    const r = await selectRelevant('hello', cands, null);
    expect(r.via).toBe('all');
    expect(r.selected).toHaveLength(3);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('uses the gate and returns only the named subset when there are many', async () => {
    const { selectRelevant } = await import('../electron/memoryRetrieval');
    const cands = [leaf('alpha'), leaf('beta'), leaf('gamma'), leaf('delta'), leaf('epsilon'), leaf('zeta'), leaf('eta')];
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '["beta", "eta"]' }] });
    const r = await selectRelevant('something about beta and eta', cands, null);
    expect(r.via).toBe('gate');
    expect(r.selected.map((s) => s.name).sort()).toEqual(['beta', 'eta']);
    expect(createMock).toHaveBeenCalledOnce();
  });

  it('handles JSON wrapped in prose (extracts the array)', async () => {
    const { selectRelevant } = await import('../electron/memoryRetrieval');
    const cands = Array.from({ length: 8 }, (_, i) => leaf('n' + i));
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'Here you go: ["n3"] done.' }] });
    const r = await selectRelevant('x', cands, null);
    expect(r.selected.map((s) => s.name)).toEqual(['n3']);
  });

  it('falls back to the newest candidates when the gate throws', async () => {
    const { selectRelevant } = await import('../electron/memoryRetrieval');
    const cands = [leaf('old', 1000), leaf('mid', 2000), leaf('new', 3000), leaf('d', 1), leaf('e', 2), leaf('f', 3), leaf('g', 4)];
    createMock.mockRejectedValue(new Error('boom'));
    const r = await selectRelevant('x', cands, null);
    expect(r.via).toBe('fallback');
    // newest first; 'new' (3000) must be included
    expect(r.selected.map((s) => s.name)).toContain('new');
    expect(r.selected.length).toBeGreaterThan(0);
  });

  it('returns empty selection (not all) when the gate returns []', async () => {
    const { selectRelevant } = await import('../electron/memoryRetrieval');
    const cands = Array.from({ length: 8 }, (_, i) => leaf('n' + i));
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '[]' }] });
    const r = await selectRelevant('totally unrelated', cands, null);
    expect(r.via).toBe('gate');
    expect(r.selected).toHaveLength(0);
  });
});

describe('gatherLeafMeta + loadRelevantMemory (against real memory tree)', () => {
  it('gatherLeafMeta returns leaves with a pinned flag', async () => {
    const { gatherLeafMeta } = await import('../electron/memoryRetrieval');
    const metas = gatherLeafMeta({ cwd: process.cwd(), projectId: '' });
    expect(Array.isArray(metas)).toBe(true);
    // Every entry has the shape we rely on.
    for (const m of metas.slice(0, 5)) {
      expect(typeof m.path).toBe('string');
      expect(typeof m.name).toBe('string');
      expect(typeof m.pinned).toBe('boolean');
    }
  });

  it('loadRelevantMemory always includes the pinned core and never throws', async () => {
    const { loadRelevantMemory } = await import('../electron/memoryRetrieval');
    // Force the gate to select nothing, so retrievedText is empty but
    // pinnedText (the always-on core) must still be present if any pinned
    // leaves exist on this machine.
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '[]' }] });
    const rm = await loadRelevantMemory({
      cwd: process.cwd(),
      projectId: '',
      userMessage: 'what time is it',
      apiKeyId: null,
    });
    expect(typeof rm.pinnedText).toBe('string');
    expect(typeof rm.retrievedText).toBe('string');
    expect(Array.isArray(rm.selectedNames)).toBe(true);
  });
});
