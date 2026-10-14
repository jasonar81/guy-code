/**
 * Wiring checks for mid-run subagent steering.
 *
 * The queue itself is covered by subagentInbox.test.ts; these assert that
 * runSubagent actually USES it - marks itself active, drains between rounds,
 * and cleans up on EVERY exit path (there are several returns and four
 * throws, which is why the body is wrapped in try/finally).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'electron', 'subagent.ts'), 'utf8');

describe('runSubagent integrates with the inbox', () => {
  it('announces itself so the UI can offer to message it', () => {
    expect(src).toMatch(/markSubagentActive\(parent\.sessionId/);
  });

  it('drains the inbox INSIDE the round loop, not just at the start', () => {
    const loopAt = src.indexOf('for (let round = 0');
    const drainAt = src.indexOf('drainSubagentInbox(parent.sessionId)');
    expect(loopAt).toBeGreaterThan(-1);
    expect(drainAt).toBeGreaterThan(loopAt);
  });

  it('injects the message as a USER turn so it steers the work', () => {
    // Use the CALL SITE, not the import line at the top of the file.
    const i = src.indexOf('drainSubagentInbox(parent.sessionId)');
    const after = src.slice(i, i + 900);
    expect(after).toMatch(/messages\.push\(/);
    expect(after).toMatch(/role: 'user'/);
    // Framed so the child knows it is live human input, not parent instructions.
    expect(after).toMatch(/Message from the user/);
  });

  it('cleans up on EVERY exit path via try/finally', () => {
    // The real body was moved into runSubagentInner precisely so the wrapper
    // can guarantee this - several returns and four throws otherwise.
    expect(src).toMatch(/async function runSubagentInner/);
    const wrapper = src.slice(
      src.indexOf('export async function runSubagent'),
      src.indexOf('async function runSubagentInner')
    );
    expect(wrapper).toMatch(/try \{/);
    expect(wrapper).toMatch(/finally \{/);
    expect(wrapper).toMatch(/markSubagentDone\(parent\.sessionId\)/);
  });

  it('hands late messages to the PARENT rather than dropping them', () => {
    const wrapper = src.slice(
      src.indexOf('export async function runSubagent'),
      src.indexOf('async function runSubagentInner')
    );
    expect(wrapper).toMatch(/queueInterrupt\(parent\.sessionId, t\)/);
  });

  it('a UI emit failure can never break the run', () => {
    const wrapper = src.slice(
      src.indexOf('export async function runSubagent'),
      src.indexOf('async function runSubagentInner')
    );
    expect(wrapper).toMatch(/\.catch\(/);
  });
});

describe('the renderer can target the subagent', () => {
  const ipc = readFileSync(join(__dirname, '..', 'electron', 'ipc.ts'), 'utf8');
  const preload = readFileSync(join(__dirname, '..', 'electron', 'preload.ts'), 'utf8');

  it('exposes a send channel that reports failure instead of swallowing', () => {
    expect(ipc).toMatch(/'agent:sendToSubagent'/);
    // pending < 0 means "no subagent" - must surface as ok:false.
    const i = ipc.indexOf("'agent:sendToSubagent'");
    expect(ipc.slice(i, i + 400)).toMatch(/ok: false/);
  });

  it('exposes a status channel for the UI toggle', () => {
    expect(ipc).toMatch(/'agent:subagentStatus'/);
  });

  it('bridges both through preload', () => {
    expect(preload).toMatch(/sendToSubagent:/);
    expect(preload).toMatch(/subagentStatus:/);
  });
});

describe('the composer routes to the right destination', () => {
  const composer = readFileSync(
    join(__dirname, '..', 'src', 'components', 'Composer.tsx'),
    'utf8'
  );

  it('only offers the choice while a subagent is running', () => {
    expect(composer).toMatch(/subagentRunId && \(/);
  });

  it('sends to the subagent when selected, else queues for the parent', () => {
    expect(composer).toMatch(/if \(subagentRunId && sendTo === 'subagent'\)/);
    expect(composer).toMatch(/sendToSubagentAction\(sessionId, t\)/);
    expect(composer).toMatch(/interruptTurn\(sessionId, t\)/);
  });

  it('resets the destination when the subagent ends', () => {
    expect(composer).toMatch(/if \(!subagentRunId\) setSendTo\('subagent'\)/);
  });

  it('subscribes to a primitive, not the object (avoids per-token re-render)', () => {
    expect(composer).toMatch(/activeSubagent\(sessionId\)\?\.runId \?\? null/);
  });
});
