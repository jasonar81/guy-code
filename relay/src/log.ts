/**
 * Structured, deliberately thin logging for the relay.
 *
 * The relay is untrusted infrastructure and everything it logs is metadata
 * about who talks to whom (DESIGN.md 11a, "What the relay knows regardless").
 * So the logger enforces, rather than merely hopes:
 *
 *   - Fields are primitives only. An envelope or request object cannot be
 *     logged by accident; it becomes "[omitted]".
 *   - Field names that would carry secrets or ciphertext (ct, iv, tag, token,
 *     signature, nonce, certPem, body, payload) are refused outright.
 *   - Any long hex run (a full fingerprint, a token) is cut to a 12-char
 *     prefix, and any long base64 run is replaced with "[redacted]", as a
 *     second line of defence for values passed under an innocent name.
 *
 * Output is one JSON object per line on stdout; under systemd that goes to
 * journald, which owns rotation and retention (see README).
 */

export type LogLevel = 'info' | 'warn' | 'error';
export type LogSink = (line: string) => void;
export type LogValue = string | number | boolean | undefined | null;

const FORBIDDEN_FIELDS = new Set(['ct', 'iv', 'tag', 'token', 'signature', 'nonce', 'certpem', 'cert', 'body', 'payload', 'envelope', 'authorization']);

/** First 12 hex chars of a fingerprint - enough to correlate, not enough to identify outside the relay. */
export function fpPrefix(fp: string | undefined | null): string {
  if (!fp) return '';
  return fp.slice(0, 12);
}

function scrub(v: string): string {
  return v
    .replace(/[0-9a-fA-F]{24,}/g, (m) => `${m.slice(0, 12)}...`)
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]');
}

export class RelayLogger {
  constructor(
    private readonly sink: LogSink = (line) => process.stdout.write(line + '\n'),
    private readonly now: () => number = Date.now
  ) {}

  info(event: string, fields?: Record<string, LogValue>): void {
    this.log('info', event, fields);
  }
  warn(event: string, fields?: Record<string, LogValue>): void {
    this.log('warn', event, fields);
  }
  error(event: string, fields?: Record<string, LogValue>): void {
    this.log('error', event, fields);
  }

  log(level: LogLevel, event: string, fields: Record<string, LogValue> = {}): void {
    const out: Record<string, string | number | boolean> = { t: new Date(this.now()).toISOString(), level, event };
    for (const [k, v] of Object.entries(fields)) {
      if (FORBIDDEN_FIELDS.has(k.toLowerCase())) {
        // A programming error, but never let it crash the relay or leak: record that it happened.
        out[`${k}_refused`] = true;
        continue;
      }
      if (v === undefined || v === null) continue;
      if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'string') out[k] = scrub(v.slice(0, 300));
      else out[k] = '[omitted]';
    }
    try {
      this.sink(JSON.stringify(out));
    } catch {
      /* logging must never take the relay down */
    }
  }
}
