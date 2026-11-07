/**
 * Worker-thread entry for memory work that reads the whole memory tree, so it
 * runs OFF the Electron main process.
 *
 * Two jobs, both pure functions of what is on disk:
 *   - 'load'   : build the memory bundle for a turn (loadMemoryUncached).
 *                Synchronously it froze the app for 11s at the median, 63s
 *                worst, whenever the disk was busy.
 *   - 'recall' : the recall_memory tool's substring search. A query with few
 *                or no matches reads every leaf in full - 2,495 files / 37 MB
 *                on a real install - and froze the app for 18s and 62s.
 *
 * The worker has no Electron APIs; memory.ts only needs node:fs/os/path plus
 * electron-log, which degrades to console outside Electron.
 */
import { parentPort } from 'node:worker_threads';
import { loadMemoryUncachedForWorker, recallFromDisk } from './memory';

type Msg =
  | { id: number; kind?: 'load'; cwd: string; projectId: string }
  | { id: number; kind: 'recall'; cwd: string; projectId?: string; query: string; maxResults?: number };

if (parentPort) {
  parentPort.on('message', (msg: Msg) => {
    try {
      if (msg.kind === 'recall') {
        const text = recallFromDisk({
          cwd: msg.cwd,
          projectId: msg.projectId,
          query: msg.query,
          maxResults: msg.maxResults,
        });
        parentPort!.postMessage({ id: msg.id, ok: true, result: text });
        return;
      }
      const bundle = loadMemoryUncachedForWorker({ cwd: msg.cwd, projectId: msg.projectId });
      parentPort!.postMessage({ id: msg.id, ok: true, result: bundle });
    } catch (e) {
      parentPort!.postMessage({ id: msg.id, ok: false, error: String((e as Error)?.message ?? e) });
    }
  });
}
