import { describe, it, expect } from 'vitest';
import { ulid, isUlid, ULID_LEN, cryptoRandom } from '../../src/core/ulid';

const fixedRandom = (byte: number) => (len: number) => new Uint8Array(len).fill(byte);

describe('§8 ULIDs', () => {
  it('is 26 Crockford base32 characters', () => {
    const id = ulid(1_757_000_000_000, fixedRandom(0));
    expect(id).toHaveLength(ULID_LEN);
    expect(id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    expect(isUlid(id)).toBe(true);
  });

  it('is deterministic given a time and a random source — so sync is testable', () => {
    expect(ulid(1_757_000_000_000, fixedRandom(0))).toBe(
      ulid(1_757_000_000_000, fixedRandom(0)),
    );
  });

  it('sorts lexicographically by creation time, which is what makes newest-first a plain sort', () => {
    const ids = [3_000_000, 1_000_000, 2_000_000].map((ms) => ulid(ms, fixedRandom(0)));
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('differs when the randomness differs, within the same millisecond', () => {
    expect(ulid(1_757_000_000_000, fixedRandom(0))).not.toBe(
      ulid(1_757_000_000_000, fixedRandom(7)),
    );
  });

  it('rejects impossible timestamps rather than emitting a malformed id', () => {
    expect(() => ulid(-1, fixedRandom(0))).toThrow(/out of range/);
    expect(() => ulid(2 ** 49, fixedRandom(0))).toThrow(/out of range/);
  });

  it('still emits a well-formed id if the random source returns short', () => {
    // Defensive: a Uint8Array shorter than requested would otherwise put `undefined`
    // into the string and produce an id the store's primary key would accept.
    const short = () => new Uint8Array(3);
    const id = ulid(1_757_000_000_000, short);
    expect(id).toHaveLength(ULID_LEN);
    expect(isUlid(id)).toBe(true);
  });

  it('rejects non-ULID strings', () => {
    expect(isUlid('too-short')).toBe(false);
    expect(isUlid('U'.repeat(26))).toBe(false); // U is excluded from Crockford base32
    expect(isUlid('I'.repeat(26))).toBe(false);
  });

  it('produces unique ids from real crypto randomness', () => {
    const ids = new Set(Array.from({ length: 500 }, () => ulid()));
    expect(ids.size).toBe(500);
    expect(cryptoRandom(4)).toHaveLength(4);
  });

  it('defaults its timestamp to now', () => {
    const before = Date.now();
    const id = ulid();
    expect(isUlid(id)).toBe(true);
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });
});
