// API-key handling — multi-key.
//
// Each key is a row in the `api_keys` table:
//   - id (uuid)
//   - name (user-friendly label, e.g. "Work" or "Personal")
//   - cipher_b64 (encrypted via Electron safeStorage)
//   - daily_budget_usd / per_turn_cap_usd (per-key budget governor config)
//   - is_default (exactly one row should have this flagged; enforced in code)
//
// safeStorage uses OS-level encryption (DPAPI on Windows, Keychain on macOS,
// libsecret on Linux). The DB stores only the ciphertext (base64).
//
// Sessions reference a key via `sessions.api_key_id`. A null value means
// "use whatever is currently the default" — that way creating a key, then
// later creating a session, then later promoting a different key to
// default, still hits the *current* default at agent-run time. Sessions
// that want sticky binding to a key get their api_key_id set explicitly
// via the sidebar's right-click menu.
//
// Backwards compatibility: this module preserves the old single-key API
// (`getApiKey()`, `setApiKey(plain)`, `hasApiKey()`) so existing call sites
// keep working. Those calls resolve to the default key under the hood.

import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import log from 'electron-log';
import {
  countApiKeys,
  db,
  deleteApiKey as dbDeleteApiKey,
  getApiKeyRow,
  getDefaultApiKeyRow,
  getSetting,
  insertApiKey,
  listApiKeysFull,
  setDefaultApiKey,
  setSetting,
  updateApiKey,
  type ApiKeyRow,
} from './db';

const LEGACY_SETTING_KEY = 'apiKey.cipherB64';

function bootstrapPath(): string {
  return join(app.getPath('home'), '.guycode', 'api-key');
}

// ---- Internal helpers -----------------------------------------------------

function encryptPlain(plain: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('[secret] safeStorage not available; cannot encrypt');
    return null;
  }
  return safeStorage.encryptString(plain).toString('base64');
}

function decryptCipher(cipher: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('[secret] safeStorage not available; cannot decrypt');
    return null;
  }
  try {
    const buf = Buffer.from(cipher, 'base64');
    return safeStorage.decryptString(buf);
  } catch (e) {
    log.error('[secret] decrypt failed', e);
    return null;
  }
}

// ---- Generic encrypted secrets (settings-backed) --------------------------
//
// For small secrets like the WSL sudo password. Stored as an encrypted
// setting via the same safeStorage path as API keys. Returns null when
// encryption isn't available (the caller should then prompt each time).

/** Store a secret encrypted under a settings key. Returns false if it couldn't. */
export function setSecret(name: string, plain: string): boolean {
  const cipher = encryptPlain(plain);
  if (cipher == null) return false;
  setSetting(`secret.${name}.cipher`, cipher);
  return true;
}

/** Retrieve + decrypt a secret, or null if absent/undecryptable. */
export function getSecret(name: string): string | null {
  const cipher = getSetting(`secret.${name}.cipher`);
  if (!cipher) return null;
  return decryptCipher(cipher);
}

/** Forget a stored secret. */
export function clearSecret(name: string): void {
  setSetting(`secret.${name}.cipher`, '');
}

/** True if a secret is stored (without decrypting it). */
export function hasSecret(name: string): boolean {
  return !!getSetting(`secret.${name}.cipher`);
}

// ---- Multi-key API --------------------------------------------------------

export interface ApiKeyPublic {
  id: string;
  name: string;
  daily_budget_usd: number | null;
  per_turn_cap_usd: number | null;
  is_default: boolean;
  created_at: number;
  /** First/last bits of the decrypted key for visual identification. Never sends the full key over IPC. */
  preview: string | null;
  /**
   * Active-hours window for budget redistribution. Both 0..23.
   * When `active_hour_start == active_hour_end` (including the 0/0
   * default) the budget spreads over all 24 hours. Otherwise the
   * window is the half-open interval [start, end), wrapping midnight
   * when end < start. See `electron/budget.ts` for the math.
   */
  active_hour_start: number;
  active_hour_end: number;
}

function toPublic(r: ApiKeyRow): ApiKeyPublic {
  const plain = decryptCipher(r.cipher_b64);
  // Show enough of the key for the user to tell them apart, but never the
  // full secret. Anthropic keys are long and uniform-looking, so the last
  // 4 chars is a useful uniqueness signal even when the prefix is shared.
  const preview =
    plain && plain.length > 12
      ? `${plain.slice(0, 8)}…${plain.slice(-4)}`
      : plain
        ? `${plain.slice(0, 4)}…`
        : null;
  return {
    id: r.id,
    name: r.name,
    daily_budget_usd: r.daily_budget_usd,
    per_turn_cap_usd: r.per_turn_cap_usd,
    is_default: r.is_default === 1,
    created_at: r.created_at,
    preview,
    active_hour_start: r.active_hour_start,
    active_hour_end: r.active_hour_end,
  };
}

export function listApiKeys(): ApiKeyPublic[] {
  return listApiKeysFull().map(toPublic);
}

export function getApiKeyById(id: string): ApiKeyPublic | undefined {
  const r = getApiKeyRow(id);
  return r ? toPublic(r) : undefined;
}

/**
 * Decrypted plaintext key for a given key id (or the current default if
 * id is null/undefined). Used by the Anthropic client cache. Returns null
 * if no key exists or decryption failed.
 */
export function getApiKeyPlaintext(id?: string | null): string | null {
  const row =
    id && id.trim() ? getApiKeyRow(id) : getDefaultApiKeyRow();
  if (!row) return null;
  return decryptCipher(row.cipher_b64);
}

export function getDefaultApiKeyId(): string | null {
  const r = getDefaultApiKeyRow();
  return r?.id ?? null;
}

/**
 * Insert a new API key row. Returns its id, or null on validation /
 * encryption failure.
 */
export function createApiKey(args: {
  name: string;
  plain: string;
  dailyBudgetUsd?: number | null;
  perTurnCapUsd?: number | null;
  setDefault?: boolean;
  /**
   * Active-hours window. Both integers [0..23]; omit / leave 0
   * for the all-day default. See `db.ts` insertApiKey doc for
   * wrap semantics.
   */
  activeHourStart?: number;
  activeHourEnd?: number;
}): string | null {
  const trimmed = args.plain.trim();
  if (!trimmed.startsWith('sk-')) {
    log.warn('[secret] refused to store key with bad prefix');
    return null;
  }
  const cipherB64 = encryptPlain(trimmed);
  if (!cipherB64) return null;
  const id = randomUUID();
  const isFirst = countApiKeys() === 0;
  insertApiKey({
    id,
    name: args.name.trim() || 'API key',
    cipherB64,
    dailyBudgetUsd:
      args.dailyBudgetUsd != null && Number.isFinite(args.dailyBudgetUsd)
        ? args.dailyBudgetUsd
        : null,
    perTurnCapUsd:
      args.perTurnCapUsd != null && Number.isFinite(args.perTurnCapUsd)
        ? args.perTurnCapUsd
        : null,
    // First key is always default; otherwise honor the caller's flag.
    isDefault: isFirst || !!args.setDefault,
    createdAt: Date.now(),
    activeHourStart: args.activeHourStart,
    activeHourEnd: args.activeHourEnd,
  });
  if (args.setDefault && !isFirst) {
    setDefaultApiKey(id);
  }
  log.info(`[secret] api key "${args.name}" stored (id=${id})`);
  return id;
}

export function updateApiKeyFields(
  id: string,
  patch: {
    name?: string;
    plain?: string; // re-encrypt and store if provided
    dailyBudgetUsd?: number | null;
    perTurnCapUsd?: number | null;
    /** Hour-of-day [0..23] for the active-hours start. Undefined leaves it alone. */
    activeHourStart?: number;
    /** Hour-of-day [0..23] for the active-hours end. Undefined leaves it alone. */
    activeHourEnd?: number;
  }
): boolean {
  const dbPatch: {
    name?: string;
    cipherB64?: string;
    dailyBudgetUsd?: number | null;
    perTurnCapUsd?: number | null;
    activeHourStart?: number;
    activeHourEnd?: number;
  } = {};
  if (patch.name !== undefined) dbPatch.name = patch.name.trim();
  if (patch.plain !== undefined && patch.plain.trim()) {
    const trimmed = patch.plain.trim();
    if (!trimmed.startsWith('sk-')) {
      log.warn('[secret] refused to update key with bad prefix');
      return false;
    }
    const cipher = encryptPlain(trimmed);
    if (!cipher) return false;
    dbPatch.cipherB64 = cipher;
  }
  if (patch.dailyBudgetUsd !== undefined) {
    dbPatch.dailyBudgetUsd =
      patch.dailyBudgetUsd != null && Number.isFinite(patch.dailyBudgetUsd)
        ? patch.dailyBudgetUsd
        : null;
  }
  if (patch.perTurnCapUsd !== undefined) {
    dbPatch.perTurnCapUsd =
      patch.perTurnCapUsd != null && Number.isFinite(patch.perTurnCapUsd)
        ? patch.perTurnCapUsd
        : null;
  }
  if (patch.activeHourStart !== undefined) {
    dbPatch.activeHourStart = patch.activeHourStart;
  }
  if (patch.activeHourEnd !== undefined) {
    dbPatch.activeHourEnd = patch.activeHourEnd;
  }
  updateApiKey(id, dbPatch);
  return true;
}

export function setApiKeyAsDefault(id: string): void {
  setDefaultApiKey(id);
}

export function deleteApiKeyById(id: string): void {
  dbDeleteApiKey(id);
}

// ---- Backwards-compatible single-key API ---------------------------------
//
// The renderer / existing call sites still use `getApiKey()` /
// `setApiKey()` / `hasApiKey()`. We resolve those to the current default
// key in the new schema so the rest of the codebase doesn't have to be
// aware that the underlying storage is now multi-row.

/** Returns the decrypted plaintext of the current default key (or null). */
export function getApiKey(): string | null {
  return getApiKeyPlaintext();
}

/**
 * Replace the default key's value. If no keys exist yet, creates a row
 * called "Default" and marks it as default. Returns true on success.
 */
export function setApiKey(plain: string): boolean {
  const trimmed = plain.trim();
  if (!trimmed.startsWith('sk-')) {
    log.warn('[secret] refused to store key with bad prefix');
    return false;
  }
  const cipher = encryptPlain(trimmed);
  if (!cipher) return false;
  const def = getDefaultApiKeyRow();
  if (def) {
    updateApiKey(def.id, { cipherB64: cipher });
    log.info(`[secret] api key for default "${def.name}" replaced`);
    return true;
  }
  const id = createApiKey({ name: 'Default', plain: trimmed, setDefault: true });
  return !!id;
}

/**
 * Bootstrap from filesystem or env if no key is in the DB yet.
 * Removes the plain-text bootstrap file after successful encryption.
 * Also handles the legacy single-key migration: if the old
 * `apiKey.cipherB64` setting exists but no api_keys row does, we lift it
 * into a row called "Default".
 */
export function bootstrapApiKey(): { source: string; ok: boolean } {
  // Legacy migration first: copy the old single-key setting into a row.
  // Has to come before the "any key?" check below — otherwise the legacy
  // user appears keyless on first launch under the new schema and we'd
  // start asking them to type their key again, even though it's already
  // in their DB.
  if (countApiKeys() === 0) {
    const legacyCipher = getSetting(LEGACY_SETTING_KEY);
    if (legacyCipher && legacyCipher.trim()) {
      const legacyPlain = decryptCipher(legacyCipher);
      if (legacyPlain) {
        const legacyDaily = parseFloat(getSetting('budget.dailyBudgetUsd') ?? '');
        const legacyPerTurn = parseFloat(getSetting('budget.perTurnCapUsd') ?? '');
        const id = createApiKey({
          name: 'Default',
          plain: legacyPlain,
          dailyBudgetUsd: Number.isFinite(legacyDaily) && legacyDaily > 0 ? legacyDaily : null,
          perTurnCapUsd: Number.isFinite(legacyPerTurn) && legacyPerTurn > 0 ? legacyPerTurn : null,
          setDefault: true,
        });
        if (id) {
          // Clear the legacy setting so we don't read it again on next boot.
          setSetting(LEGACY_SETTING_KEY, '');
          // Backfill: historical usage_events have api_key_id = NULL
          // (column didn't exist before migration v4). Attribute them
          // to the newly-created Default key so the per-key spend view
          // shows the user's history under that key. Without this,
          // "Default" looks like a brand-new key with $0 spend, which
          // is a confusing onboarding moment for someone with thousands
          // of dollars of pre-migration history. We also bind every
          // existing session to the Default key so the right-click
          // "Change API key" dropdown shows the correct currently-
          // selected entry instead of all checkmarks landing on
          // "Inherit default" by default.
          try {
            db()
              .prepare(
                `UPDATE usage_events SET api_key_id = ? WHERE api_key_id IS NULL`
              )
              .run(id);
            db()
              .prepare(
                `UPDATE sessions SET api_key_id = ? WHERE api_key_id IS NULL`
              )
              .run(id);
          } catch (e) {
            log.warn(
              `[secret] legacy backfill of usage_events/sessions failed (non-fatal): ${(e as Error).message}`
            );
          }
          log.info('[secret] migrated legacy single-key into api_keys row');
          return { source: 'legacy-migration', ok: true };
        }
      }
    }
  }

  if (countApiKeys() > 0) return { source: 'safeStorage', ok: true };

  // Try ~/.guycode/api-key (file)
  try {
    const p = bootstrapPath();
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8').trim();
      if (raw && setApiKey(raw)) {
        try {
          unlinkSync(p);
          log.info('[secret] bootstrapped from file; plaintext removed');
        } catch (e) {
          log.warn('[secret] could not remove bootstrap file', e);
        }
        return { source: 'file', ok: true };
      }
    }
  } catch (e) {
    log.error('[secret] file bootstrap failed', e);
  }

  // Try env var
  const env = process.env.ANTHROPIC_API_KEY;
  if (env && env.trim()) {
    if (setApiKey(env.trim())) {
      return { source: 'env', ok: true };
    }
  }

  return { source: 'none', ok: false };
}

export function hasApiKey(): boolean {
  return countApiKeys() > 0;
}

