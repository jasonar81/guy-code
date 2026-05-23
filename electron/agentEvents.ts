// Cross-module helper for emitting `agent:event` payloads to all renderer
// windows. Used by agent.ts, tools.ts (WaitFor* state flips), and budget.ts.

import { BrowserWindow } from 'electron';

export function broadcastAgentEvent(payload: any): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('agent:event', payload);
  }
}

/** Convenience for the very common state_changed event. */
export function broadcastStateChanged(sessionId: string, state: string): void {
  broadcastAgentEvent({ type: 'state_changed', sessionId, state });
}
