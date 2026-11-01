/**
 * Worker-thread entry for building the memory bundle OFF the main process.
 *
 * Loading memory reads ~2,000+ markdown files from disk. Done synchronously on
 * the Electron main process it froze the whole app for 11s at the median (63s
 * worst) whenever the disk was busy - and with a 60s cache TTL, 86% of turn
 * starts were cache misses, so it happened on almost every action. Running the
 * same pure function in a worker means a slow disk delays one session's memory
 * refresh instead of freezing every window.
 *
 * The worker has no Electron APIs; memory.ts only needs node:fs/os/path plus
 * electron-log, which degrades to console outside Electron.
 */
import { parentPort } from 'node:worker_threads';
import { loadMemoryUncachedForWorker } from './memory';

if (parentPort) {
  parentPort.on('message', (msg: { id: number; cwd: string; projectId: string }) => {
    try {
      const bundle = loadMemoryUncachedForWorker({ cwd: msg.cwd, projectId: msg.projectId });
      parentPort!.postMessage({ id: msg.id, ok: true, bundle });
    } catch (e) {
      parentPort!.postMessage({ id: msg.id, ok: false, error: String((e as Error)?.message ?? e) });
    }
  });
}
