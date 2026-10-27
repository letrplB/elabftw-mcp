/**
 * Secrets-at-rest helpers for the registration store.
 *
 *   - Bearer tokens are persisted as `sha256(token)` only. Tokens are
 *     256-bit random values, so a plain hash is enough — no salt, no KDF
 *     (there is nothing to brute-force).
 *   - eLabFTW API keys are encrypted with AES-256-GCM. The 32-byte key
 *     comes from `MCP_STORE_KEY` (base64 or hex) or, if unset, from a key
 *     file generated next to the store on first start.
 *
 * Ciphertext format (one string, safe to embed in JSON):
 *
 *     enc:v1:<iv base64>:<auth tag base64>:<ciphertext base64>
 *
 * The `enc:v1:` prefix lets loaders tell an encrypted value from a
 * legacy plaintext one during migration. eLabFTW keys look like
 * `3-abc…`, so the prefix can't collide with a real key.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const ENC_PREFIX = 'enc:v1:';

/** `sha256(token)` as 64 lowercase hex chars — the store's lookup key. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** True when `value` is already in the `enc:v1:` envelope. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

/**
 * AES-256-GCM box around one store key. Each `encrypt` call uses a
 * fresh random IV, so re-encrypting the same plaintext yields a
 * different ciphertext (and that's fine — nothing compares them).
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`Store key must be ${KEY_BYTES} bytes, got ${key.length}.`);
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(envelope: string): string {
    if (!isEncrypted(envelope)) {
      throw new Error('Value is not an enc:v1 envelope.');
    }
    const parts = envelope.slice(ENC_PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('Malformed enc:v1 envelope.');
    const [ivB64, tagB64, ctB64] = parts as [string, string, string];
    const decipher = createDecipheriv(
      CIPHER,
      this.key,
      Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(ctB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // GCM auth failure. Almost always the wrong MCP_STORE_KEY / key
      // file rather than corruption — say so.
      throw new Error(
        'Could not decrypt a stored API key — MCP_STORE_KEY (or the key ' +
          'file) does not match the key the store was written with.'
      );
    }
  }

  /** Encrypt `value` unless it's already an envelope (migration helper). */
  ensureEncrypted(value: string): string {
    return isEncrypted(value) ? value : this.encrypt(value);
  }
}

/**
 * Parse a 32-byte key given as 64 hex chars or base64. Throws with a
 * message that names the env var on anything else.
 */
export function parseStoreKey(raw: string, source: string): Buffer {
  const trimmed = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else {
    key = Buffer.from(trimmed, 'base64');
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${source} must be ${KEY_BYTES} random bytes encoded as 64 hex chars ` +
        `or base64 (e.g. \`openssl rand -base64 32\`); decoded length was ${key.length}.`
    );
  }
  return key;
}

/**
 * Resolve the store encryption key.
 *
 *   1. `MCP_STORE_KEY` env var (base64 or hex), if set.
 *   2. Otherwise `<storePath>.key`, generated (mode 0600) on first
 *      start. A key file on the same volume as the store only protects
 *      against the store file leaking on its own (backups, copies), so
 *      we warn loudly and recommend the env var.
 */
export async function loadStoreKey(
  storePath: string,
  envValue: string | undefined
): Promise<SecretBox> {
  if (envValue?.trim()) {
    return new SecretBox(parseStoreKey(envValue, 'MCP_STORE_KEY'));
  }
  const keyPath = `${storePath}.key`;
  if (existsSync(keyPath)) {
    const raw = await readFile(keyPath, 'utf8');
    // Tighten the mode in case it was copied around with a loose umask.
    await chmod(keyPath, 0o600).catch(() => {});
    // biome-ignore lint/suspicious/noConsole: startup diagnostic
    console.error(
      `[elabftw-mcp] Using store encryption key from ${keyPath}. ` +
        'Set MCP_STORE_KEY instead to keep the key off the data volume.'
    );
    return new SecretBox(parseStoreKey(raw, keyPath));
  }
  const key = randomBytes(KEY_BYTES);
  // `wx` — never clobber a key file another process just wrote.
  await writeFile(keyPath, `${key.toString('base64')}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  // biome-ignore lint/suspicious/noConsole: startup diagnostic
  console.error(
    `[elabftw-mcp] WARNING: MCP_STORE_KEY is not set — generated a new store ` +
      `encryption key at ${keyPath}. BACK THIS FILE UP: without it the stored ` +
      'eLabFTW API keys cannot be decrypted and every user must re-register. ' +
      'Better: move its contents into the MCP_STORE_KEY env var and delete the file.'
  );
  return new SecretBox(key);
}
