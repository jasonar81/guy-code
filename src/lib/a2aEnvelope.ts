/**
 * Renderer-side parser for the A2A untrusted-content envelope.
 *
 * MIRRORS `parseEnvelope` in `electron/a2a/envelope.ts`; the renderer cannot
 * import from electron/ (separate tsconfig project), so the logic is copied
 * and `tests/a2a/envelope.test.ts` asserts both parse the same inputs the
 * same way. Change them together.
 *
 * Used by MessageList to draw inbound peer messages as a distinct "Agent
 * message from ..." bubble, so they never look like the user typing.
 */
export const BEGIN_MARK = '----- begin peer message -----';
export const END_MARK = '----- end peer message -----';

export interface ParsedEnvelope {
  peerId: string;
  displayName: string;
  agentKindLabel: string;
  trust: string;
  taskId?: string;
  contextId?: string;
  before: string;
  body: string;
  after: string;
}

const HEADER_RE = /^\[A2A message from (\S+) \((.*), ([^,()]*)\) · trust: ([^·\]]+?)((?: · [^·\]]+)*)\]$/m;

export function parseEnvelope(text: string): ParsedEnvelope | null {
  const m = HEADER_RE.exec(text ?? '');
  if (!m) return null;
  const headerEnd = m.index + m[0].length;
  const rest = text.slice(headerEnd);
  const b = rest.indexOf(`\n${BEGIN_MARK}\n`);
  if (b < 0) return null;
  const bodyStart = b + BEGIN_MARK.length + 2;
  const e = rest.indexOf(`\n${END_MARK}`, bodyStart - 1);
  const body = e < 0 ? rest.slice(bodyStart) : rest.slice(bodyStart, e);
  const after = e < 0 ? '' : rest.slice(e + END_MARK.length + 1).replace(/^\n/, '');
  const extras = m[5] ?? '';
  const taskId = /· task (\S+)/.exec(extras)?.[1];
  const contextId = /· context (\S+)/.exec(extras)?.[1];
  return {
    peerId: m[1],
    displayName: m[2],
    agentKindLabel: m[3],
    trust: m[4].trim(),
    taskId,
    contextId,
    before: text.slice(0, m.index).replace(/\n$/, ''),
    body,
    after,
  };
}
