/**
 * Entry point: `npm start` (or `node dist/main.js`). Configuration is by
 * environment only, so a systemd unit can set it (see README.md):
 *
 *   RELAY_HOST       bind address               (default 0.0.0.0)
 *   RELAY_PORT       port                       (default 7429)
 *   RELAY_TLS_CERT   path to a PEM certificate  (optional; enables HTTPS)
 *   RELAY_TLS_KEY    path to its PEM key        (required with RELAY_TLS_CERT)
 *
 * Exits non-zero on a bad config or a failed bind, so systemd's Restart= sees it.
 */
import { readFileSync } from 'node:fs';
import { RelayServer } from './server';
import { RelayLogger } from './log';

export const DEFAULT_RELAY_PORT = 7429;

async function main(): Promise<void> {
  const log = new RelayLogger();
  const port = process.env.RELAY_PORT ? Number(process.env.RELAY_PORT) : DEFAULT_RELAY_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log.error('bad_config', { reason: 'RELAY_PORT must be an integer 0-65535' });
    process.exit(2);
  }
  const certPath = process.env.RELAY_TLS_CERT;
  const keyPath = process.env.RELAY_TLS_KEY;
  if (!!certPath !== !!keyPath) {
    log.error('bad_config', { reason: 'set both RELAY_TLS_CERT and RELAY_TLS_KEY, or neither' });
    process.exit(2);
  }
  let tls: { certPem: string; keyPem: string } | undefined;
  if (certPath && keyPath) {
    try {
      tls = { certPem: readFileSync(certPath, 'utf8'), keyPem: readFileSync(keyPath, 'utf8') };
    } catch (e) {
      log.error('bad_config', { reason: 'could not read the TLS cert or key file', code: (e as NodeJS.ErrnoException).code ?? 'unknown' });
      process.exit(2);
    }
  } else {
    log.warn('plain_http', { note: 'payloads are end-to-end encrypted, but session tokens and metadata are visible on the wire; set RELAY_TLS_CERT/RELAY_TLS_KEY' });
  }

  const relay = new RelayServer({ host: process.env.RELAY_HOST || '0.0.0.0', port, tls, logger: log });
  try {
    await relay.start();
  } catch (e) {
    log.error('start_failed', { code: (e as NodeJS.ErrnoException).code ?? 'unknown', message: (e as Error).message });
    process.exit(1);
  }
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('signal', { signal });
    relay.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
