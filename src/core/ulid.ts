/**
 * Client-generated ULIDs (§8). Every upsert is idempotent, so a retry after a flaky
 * radio cannot duplicate a marker. Lexicographically sortable by creation time, which
 * is also what makes "recent markers, newest first" a plain ORDER BY.
 *
 * Crockford base32: 10 chars of millisecond timestamp + 16 chars of randomness.
 * Pure — randomness and time are both injectable so tests are deterministic.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
export const ULID_LEN = TIME_LEN + RANDOM_LEN;

/** Returns `len` bytes of randomness. Production uses crypto.getRandomValues. */
export type RandomBytes = (len: number) => Uint8Array;

export const cryptoRandom: RandomBytes = (len) => crypto.getRandomValues(new Uint8Array(len));

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > 281_474_976_710_655) {
    throw new Error(`ulid timestamp out of range: ${ms}`);
  }
  let out = '';
  let n = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[n % ENCODING_LEN] + out;
    n = Math.floor(n / ENCODING_LEN);
  }
  return out;
}

function encodeRandom(random: RandomBytes): string {
  const bytes = random(RANDOM_LEN);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[(bytes[i] ?? 0) % ENCODING_LEN];
  }
  return out;
}

/**
 * `ms` is wall-clock only — it orders rows, it never becomes a timecode, so Date.now()
 * is correct here and nowhere else (§3.3).
 */
export function ulid(ms: number = Date.now(), random: RandomBytes = cryptoRandom): string {
  return encodeTime(Math.floor(ms)) + encodeRandom(random);
}

export function isUlid(value: string): boolean {
  if (value.length !== ULID_LEN) return false;
  for (const ch of value) if (!ENCODING.includes(ch)) return false;
  return true;
}
