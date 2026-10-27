import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt with N=2^15, r=8, p=1 (~32 MiB, ~100 ms): OWASP's minimum is N=2^17 for r=8, p=1 at
// 128 MiB; this is a home server where phones log in, so we trade a little for memory.
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEYLEN = 32;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, { ...opts, maxmem: 128 * opts.N! * opts.r! * 2 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** "scrypt$N$r$p$<salt b64>$<hash b64>" */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(key, expected);
}

let dummy: Promise<string> | null = null;
/** Same work as a real check, for unknown users, so response timing doesn't reveal valid names. */
export async function verifyDummy(password: string): Promise<false> {
  dummy ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummy);
  return false;
}

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;

export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  return null;
}

export const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,63}$/;
