import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEY_LEN = 64;

/**
 * Password hashing for the local auth driver. scrypt with a per-user random salt
 * and constant-time comparison. Firebase handles hashing in Firebase mode.
 */
export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, KEY_LEN);
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPassword(
  password: string,
  hash: string | null,
  salt: string | null,
): Promise<boolean> {
  if (!hash || !salt) return false;
  const derived = await scrypt(password, salt, KEY_LEN);
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

export function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}
