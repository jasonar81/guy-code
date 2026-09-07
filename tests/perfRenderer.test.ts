/**
 * Guards the renderer-side performance work. Symptom being prevented: the UI
 * going "Not Responding" / laggy clicks+scroll+typing once a real history
 * accumulates.
 *
 * Two causes, both fixed:
 *  1. A `usage` agent event fires on EVERY api call and used to trigger
 *     refreshSessions() - re-aggregating the usage table, shipping every
 *     session row over IPC (hundreds of KB), and replacing the whole sessions
 *     array so every row re-rendered.
 *  2. The sidebar session row wasn't memoized, so a replaced sessions array
 *     re-rendered every visible row.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const storeSrc = readFileSync(join(__dirname, '..', 'src', 'lib', 'store.ts'), 'utf8');
const rowSrc = readFileSync(join(__dirname, '..', 'src', 'components', 'ProjectRow.tsx'), 'utf8');
const sidebarSrc = readFileSync(join(__dirname, '..', 'src', 'components', 'Sidebar.tsx'), 'utf8');

describe('usage events do not trigger a full session refetch', () => {
  it("the 'usage' case patches one row instead of calling refreshSessions", () => {
    // Slice out the `case 'usage':` block and assert it does NOT refresh.
    const i = storeSrc.indexOf("case 'usage':");
    expect(i).toBeGreaterThan(-1);
    const block = storeSrc.slice(i, storeSrc.indexOf('break;', i));
    // Strip comments - the block intentionally documents what it replaced.
    const code = block
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('refreshSessions');
    expect(code).toContain('sessionsCostPatch');
  });

  it('the cost patch updates only the matching session row', () => {
    expect(storeSrc).toContain('if (row.id !== id) return row;');
    expect(storeSrc).toMatch(/cost_all_time_micros:.*deltaMicros/);
  });
});

describe('refreshSessions is coalesced', () => {
  it('keeps at most one refresh in flight and one queued', () => {
    expect(storeSrc).toContain('_refreshInFlight');
    expect(storeSrc).toContain('_refreshQueued');
    // A second caller while one is running must not start another fetch.
    const i = storeSrc.indexOf('refreshSessions: async () =>');
    const body = storeSrc.slice(i, i + 1400);
    expect(body).toMatch(/if \(_refreshInFlight\)/);
  });
});

describe('sidebar rendering is bounded and memoized', () => {
  it('the session row is exported memoized', () => {
    expect(rowSrc).toMatch(/export const SessionListRow = memo\(SessionListRowImpl\)/);
  });

  it('the idle/archived list mounts a bounded page, not every row', () => {
    expect(sidebarSrc).toMatch(/const IDLE_PAGE = \d+/);
    expect(sidebarSrc).toContain('idle.slice(0, idleShown)');
    expect(sidebarSrc).toContain('idleHidden');
  });
});
