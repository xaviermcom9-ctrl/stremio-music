// Encryption at rest for source secrets (passwords, API keys): AES-256-GCM. The key comes from
// APP_SECRET_KEY / APP_SECRET_KEY_FILE (e.g. a Docker secret); without one, a random key is created
// in /config/secret.key (0600) and the Sources page warns that the key sits next to the data.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PREFIX = 'enc:v1:';

export type KeySource = 'env' | 'file' | 'generated';

export class SecretBox {
  private constructor(
    private readonly key: Buffer,
    readonly source: KeySource,
  ) {}

  /** A passphrase of any length is accepted; it's hashed to 256 bits. */
  static fromPassphrase(passphrase: string, source: KeySource): SecretBox {
    if (passphrase.trim().length < 16) throw new Error('APP_SECRET_KEY must be at least 16 characters');
    return new SecretBox(createHash('sha256').update(passphrase.trim()).digest(), source);
  }

  static load(opts: { key?: string; keyFile?: string; configDir: string }): SecretBox {
    if (opts.key) return SecretBox.fromPassphrase(opts.key, 'env');
    if (opts.keyFile) return SecretBox.fromPassphrase(readFileSync(opts.keyFile, 'utf8'), 'file');
    const file = path.join(opts.configDir, 'secret.key');
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
    }
    chmodSync(file, 0o600);
    return SecretBox.fromPassphrase(readFileSync(file, 'utf8'), 'generated');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  decrypt(value: string): string {
    if (!SecretBox.isEncrypted(value)) throw new Error('not an encrypted value');
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  /** URL-safe encrypted token for a small JSON payload (proxy URLs). */
  seal(payload: unknown): string {
    return Buffer.from(this.encrypt(JSON.stringify(payload)).slice(PREFIX.length), 'base64').toString('base64url');
  }

  open<T>(token: string): T {
    return JSON.parse(this.decrypt(PREFIX + Buffer.from(token, 'base64url').toString('base64'))) as T;
  }

  static isEncrypted(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(PREFIX);
  }
}
