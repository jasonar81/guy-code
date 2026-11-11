/**
 * A message sent to a running subagent must stop showing as "queued" once the
 * subagent picks it up.
 *
 * Delivery itself worked (main.log: "queued message for subagent" followed
 * seconds later by "injecting 1 message(s) from the user"), but the renderer
 * only cleared pending bubbles on `interrupt_picked_up`. The subagent emits
 * `subagent_user_message`, which the store had no case for, so the bubble sat
 * there "-> to subagent" forever and the message never appeared in the
 * subagent's activity.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

beforeEach(() => {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.api = {
    agent: {
      onEvent: vi.fn(() => () => {}),
      sendToSubagent: vi.fn().mockResolvedValue({ ok: true, pending: 1 }),
      interrupt: vi.fn().mockResolvedValue({ ok: true, pending: 1 }),
    },
    sessions: { list: vi.fn().mockResolvedValue([]) },
    apiKeys: { list: vi.fn().mockResolvedValue([]) },
  };
});

import { useApp } from '../src/lib/store';

const S = 'subagent-bubble-session';
const RUN = 'run12345';
const fire = (e: any) => useApp.getState().applyAgentEvent({ sessionId: S, ...e });
const pending = () => useApp.getState().chats[S]?.pendingInterrupts ?? [];
const subBlock = () => {
  const msgs = useApp.getState().chats[S]?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    for (const b of (msgs[i].content as any[]) ?? []) if (b?.type === 'subagent' && b.runId === RUN) return b;
  }
  return null;
};

function startSubagent() {
  useApp.setState((s) => ({ chats: { ...s.chats, [S]: undefined as any } }));
  fire({ type: 'turn_start' });
  fire({ type: 'subagent_start', runId: RUN, role: 'execute', description: 'do the thing' });
}

describe('send-to-subagent bubbles clear when the subagent picks them up', () => {
  it('clears the queued bubble and shows the message in the subagent block', async () => {
    startSubagent();
    await useApp.getState().sendToSubagent(S, 'use ripgrep instead');
    expect(pending()).toHaveLength(1);
    expect(pending()[0].toSubagent).toBe(true);

    fire({ type: 'subagent_user_message', runId: RUN, text: 'use ripgrep instead' });

    expect(pending()).toHaveLength(0);
    const items = subBlock()?.items ?? [];
    expect(items.at(-1)).toEqual({ kind: 'user_message', text: 'use ripgrep instead' });
  });

  it('two queued messages each clear on their own event', async () => {
    startSubagent();
    await useApp.getState().sendToSubagent(S, 'first');
    await useApp.getState().sendToSubagent(S, 'second');
    expect(pending()).toHaveLength(2);
    fire({ type: 'subagent_user_message', runId: RUN, text: 'first' });
    expect(pending().map((p) => p.text)).toEqual(['second']);
    fire({ type: 'subagent_user_message', runId: RUN, text: 'second' });
    expect(pending()).toHaveLength(0);
  });

  it('does not clear a same-text message that was queued for the MAIN agent', async () => {
    startSubagent();
    await useApp.getState().interruptTurn(S, 'same words');
    fire({ type: 'subagent_user_message', runId: RUN, text: 'same words' });
    expect(pending()).toHaveLength(1);
    expect(pending()[0].toSubagent).toBeFalsy();
  });
});

describe('the main process emits one event per message', () => {
  it('so each bubble can be matched by its own text', () => {
    const src = readFileSync(join(__dirname, '..', 'electron', 'subagent.ts'), 'utf8');
    expect(src).toMatch(/for \(const s of steering\) \{[\s\S]{0,120}emit\(\{ type: 'subagent_user_message', text: t \}\)/);
    expect(src).not.toMatch(/emit\(\{ type: 'subagent_user_message', text: body \}\)/);
  });

  it('the event is part of both event unions', () => {
    const t = readFileSync(join(__dirname, '..', 'src', 'types.ts'), 'utf8');
    const a = readFileSync(join(__dirname, '..', 'electron', 'agent.ts'), 'utf8');
    expect(t).toMatch(/type: 'subagent_user_message'; sessionId: string; runId: string; text: string/);
    expect(a).toMatch(/type: 'subagent_user_message'; sessionId: string; runId: string; text: string/);
  });
});
