/**
 * Guards the performance work that keeps the UI responsive as usage history
 * grows. On a real 564K-row `usage_events` table the sidebar's 5-second budget
 * poll was doing full table scans (165ms every poll) and single-session lookups
 * were running `listSessionsAll().find(...)` - a full two-way GROUP BY over the
 * whole table - at ~400ms a call, on the main process.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dbSrc = readFileSync(join(__dirname, '..', 'electron', 'db.ts'), 'utf8');
const agentSrc = readFileSync(join(__dirname, '..', 'electron', 'agent.ts'), 'utf8');
const ipcSrc = readFileSync(join(__dirname, '..', 'electron', 'ipc.ts'), 'utf8');

describe('usage_events indexes', () => {
  it('creates an index covering (source, ts) - the budget-poll filter', () => {
    expect(dbSrc).toMatch(/CREATE INDEX IF NOT EXISTS usage_source_ts ON usage_events\(source, ts\)/);
  });

  it('creates an index covering (source, session_id) - the per-session cost rollup', () => {
    expect(dbSrc).toMatch(
      /CREATE INDEX IF NOT EXISTS usage_source_session ON usage_events\(source, session_id\)/
    );
  });
});

describe('single-session lookups do not aggregate the whole usage table', () => {
  it('db exposes getSessionById', () => {
    expect(dbSrc).toMatch(/export function getSessionById/);
  });

  it('getSessionById scopes its cost subqueries to the one session', () => {
    // Both cost columns must filter by session_id (correlated), never GROUP BY
    // the entire table the way listSessionsAll does.
    const fn = dbSrc.slice(dbSrc.indexOf('export function getSessionById'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('session_id = s.id');
    expect(body).not.toContain('GROUP BY session_id');
  });

  it('no caller looks up one session via listSessionsAll().find(...)', () => {
    // This pattern cost ~400ms per call on a real history.
    const bad = /listSessionsAll\(\)\s*\.find\(/;
    expect(bad.test(agentSrc)).toBe(false);
    expect(bad.test(ipcSrc)).toBe(false);
  });
});
