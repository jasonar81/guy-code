/**
 * Smart model routing: the cheap-model classifier that picks strong vs cheap
 * per turn. The Anthropic client is mocked so no network is needed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('../electron/anthropic', () => ({
  getClient: () => ({ messages: { create: createMock } }),
}));
vi.mock('electron-log', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

beforeEach(() => createMock.mockReset());

const base = {
  strongModel: 'claude-opus-4-8[1m]',
  cheapModel: 'claude-sonnet-4-6',
  apiKeyId: null,
};

describe('classifyTurn', () => {
  it('routes a clearly-simple turn to the cheap model', async () => {
    const { classifyTurn } = await import('../electron/modelRouter');
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '{"tier":"cheap","reason":"simple lookup"}' }] });
    const d = await classifyTurn({ ...base, userText: 'what is the temperature in Chicago' });
    expect(d.tier).toBe('cheap');
    expect(d.model).toBe('claude-sonnet-4-6');
  });

  it('routes a complex turn to the strong model', async () => {
    const { classifyTurn } = await import('../electron/modelRouter');
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '{"tier":"strong","reason":"multi-file refactor"}' }] });
    const d = await classifyTurn({ ...base, userText: 'refactor this 5-file module to fix the race condition' });
    expect(d.tier).toBe('strong');
    expect(d.model).toBe('claude-opus-4-8[1m]');
  });

  it('stays strong on a continuation round (empty userText) without calling the router', async () => {
    const { classifyTurn } = await import('../electron/modelRouter');
    const d = await classifyTurn({ ...base, userText: '' });
    expect(d.tier).toBe('strong');
    expect(d.via).toBe('agentic');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('falls back to strong when the router call fails', async () => {
    const { classifyTurn } = await import('../electron/modelRouter');
    // create() resolves, but reading .content throws -> exercises the catch ->
    // strong/fallback. (Using a thrown access rather than a rejected promise
    // avoids vitest flagging a free-floating unhandled rejection.)
    createMock.mockResolvedValueOnce({
      get content(): never {
        throw new Error('boom');
      },
    });
    const d = await classifyTurn({ ...base, userText: 'do a thing' });
    expect(d.tier).toBe('strong');
    expect(d.via).toBe('fallback');
  });

  it('falls back to strong when the router output is unparseable', async () => {
    const { classifyTurn } = await import('../electron/modelRouter');
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'no json here' }] });
    const d = await classifyTurn({ ...base, userText: 'hmm' });
    expect(d.tier).toBe('strong');
    expect(d.via).toBe('fallback');
  });

  it('enforces the minimum-model floor: a cheap route below the floor uses the floor', async () => {
    const { classifyTurn } = await import('../electron/modelRouter');
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '{"tier":"cheap","reason":"simple"}' }] });
    // cheapModel haiku is below the sonnet floor -> must use the floor (sonnet).
    const d = await classifyTurn({
      ...base,
      cheapModel: 'claude-haiku-4-5',
      floorModel: 'claude-sonnet-4-6',
      userText: 'simple question',
    });
    expect(d.tier).toBe('cheap');
    expect(d.model).toBe('claude-sonnet-4-6');
  });

  it('parses a decision wrapped in prose', async () => {
    const { classifyTurn } = await import('../electron/modelRouter');
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'Sure: {"tier":"cheap","reason":"x"} ok' }] });
    const d = await classifyTurn({ ...base, userText: 'q' });
    expect(d.tier).toBe('cheap');
  });
});

describe('modelRouter internals', () => {
  it('rank orders haiku < sonnet < opus/fable', async () => {
    const { __testing } = await import('../electron/modelRouter');
    expect(__testing.rank('claude-haiku-4-5')).toBeLessThan(__testing.rank('claude-sonnet-4-6'));
    expect(__testing.rank('claude-sonnet-4-6')).toBeLessThan(__testing.rank('claude-opus-4-8'));
    expect(__testing.rank('claude-fable-5')).toBe(__testing.rank('claude-opus-4-8'));
  });

  it('parseDecision returns null on garbage and a tier on valid json', async () => {
    const { __testing } = await import('../electron/modelRouter');
    expect(__testing.parseDecision('garbage')).toBeNull();
    expect(__testing.parseDecision('{"tier":"cheap"}')?.tier).toBe('cheap');
  });
});
