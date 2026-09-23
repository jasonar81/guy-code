/**
 * Refusal notices name the models involved dynamically.
 *
 * They used to hardcode "Claude Fable 5.1 declined; retrying on Claude Opus
 * 5.5", which was wrong for any other model - and actively misleading once
 * Opus 5.5 itself started refusing ssh work.
 */
import { describe, expect, it, vi } from 'vitest';

// agent.ts pulls in a lot of main-process machinery; stub what it needs so we
// can exercise the pure helper.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: {} }));
vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }));

describe('prettyModelName', () => {
  it('renders the current models the way a person would say them', async () => {
    const { prettyModelName } = await import('../electron/agent');
    expect(prettyModelName('claude-opus-5-5[1m]')).toBe('Claude Opus 5.5');
    expect(prettyModelName('claude-opus-5[1m]')).toBe('Claude Opus 5');
    expect(prettyModelName('claude-opus-4-8[1m]')).toBe('Claude Opus 4.8');
    expect(prettyModelName('claude-fable-5-1[1m]')).toBe('Claude Fable 5.1');
    expect(prettyModelName('claude-sonnet-5')).toBe('Claude Sonnet 5');
    expect(prettyModelName('claude-haiku-4-5')).toBe('Claude Haiku 4.5');
  });

  it('works without the [1m] suffix', async () => {
    const { prettyModelName } = await import('../electron/agent');
    expect(prettyModelName('claude-opus-5-5')).toBe('Claude Opus 5.5');
  });

  it('degrades gracefully for an unrecognised id', async () => {
    const { prettyModelName } = await import('../electron/agent');
    expect(prettyModelName('some-custom-model')).toBe('some-custom-model');
    expect(prettyModelName('')).toBe('the model');
  });
});
