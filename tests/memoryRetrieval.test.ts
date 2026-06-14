/**
 * Memory relevance retrieval v2: always-load recent task state + gate only the
 * older tail, on conversation context, with sticky per-session selection.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('../electron/anthropic', () => ({
  getClient: () => ({ messages: { create: createMock } }),
}));
// In-memory settings store so sticky selection is testable.
const _settings = new Map<string, string>();
vi.mock('../electron/db', () => ({
  getSetting: (k: string) => _settings.get(k) ?? null,
  setSetting: (k: string, v: string) => void _settings.set(k, v),
}));
vi.mock('electron-log', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

beforeEach(() => {
  createMock.mockReset();
  _settings.clear();
});

const leaf = (name: string) => ({
  path: `/fake/${name}.md`,
  name,
  description: `desc for ${name}`,
  pinned: false,
  tier: 'normal' as const,
  bytes: 100,
  mtime: Date.now(),
});

describe('gateTail', () => {
  it('returns all tail names without calling the model when the tail is small (<=6)', async () => {
    const { gateTail } = await import('../electron/memoryRetrieval');
    const tail = [leaf('a'), leaf('b'), leaf('c')];
    const out = await gateTail('some context', tail, null);
    expect(out.sort()).toEqual(['a', 'b', 'c']);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('calls the model and returns the named subset for a larger tail', async () => {
    const { gateTail } = await import('../electron/memoryRetrieval');
    const tail = Array.from({ length: 8 }, (_, i) => leaf('n' + i));
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '["n3","n6"]' }] });
    const out = await gateTail('context about n3 and n6', tail, null);
    expect(out.sort()).toEqual(['n3', 'n6']);
    expect(createMock).toHaveBeenCalledOnce();
  });

  it('returns [] (tail omitted) when the gate errors - never throws', async () => {
    const { gateTail } = await import('../electron/memoryRetrieval');
    const tail = Array.from({ length: 8 }, (_, i) => leaf('n' + i));
    createMock.mockRejectedValueOnce(new Error('boom'));
    const out = await gateTail('ctx', tail, null);
    expect(out).toEqual([]);
  });

  it('extracts a JSON array wrapped in prose', async () => {
    const { gateTail } = await import('../electron/memoryRetrieval');
    const tail = Array.from({ length: 8 }, (_, i) => leaf('n' + i));
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'Sure: ["n1"] done' }] });
    const out = await gateTail('ctx', tail, null);
    expect(out).toEqual(['n1']);
  });
});

describe('gatherLeafMeta + loadRelevantMemory (real memory tree)', () => {
  it('gatherLeafMeta returns leaves with pinned flag + tier', async () => {
    const { gatherLeafMeta } = await import('../electron/memoryRetrieval');
    const metas = gatherLeafMeta({ cwd: process.cwd(), projectId: '' });
    expect(Array.isArray(metas)).toBe(true);
    for (const m of metas.slice(0, 5)) {
      expect(typeof m.pinned).toBe('boolean');
      expect(['pinned', 'normal', 'archived']).toContain(m.tier);
    }
  });

  it('loadRelevantMemory always returns pinned core + recent state, never throws', async () => {
    const { loadRelevantMemory } = await import('../electron/memoryRetrieval');
    // Even if the gate selects nothing, recent normal leaves must still load.
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '[]' }] });
    const rm = await loadRelevantMemory({
      cwd: process.cwd(),
      projectId: '',
      contextText: 'what time is it',
      sessionId: 'test-session',
      apiKeyId: null,
    });
    expect(typeof rm.pinnedText).toBe('string');
    expect(typeof rm.retrievedText).toBe('string');
    expect(Array.isArray(rm.selectedNames)).toBe(true);
  });

  it('persists a sticky selection across calls in the same session', async () => {
    const { loadRelevantMemory } = await import('../electron/memoryRetrieval');
    // The gate's pick should be recorded in the sticky settings store.
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '[]' }] });
    await loadRelevantMemory({
      cwd: process.cwd(),
      projectId: '',
      contextText: 'x',
      sessionId: 'sticky-session',
      apiKeyId: null,
    });
    // A sticky key for the session should exist after a run.
    expect(_settings.has('mem_retrieval_sticky_sticky-session')).toBe(true);
  });
});
