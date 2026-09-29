import { describe, expect, it } from 'vitest';
import { SEAT_NAME_MAX, sanitizeSeatName } from './names';

describe('sanitizeSeatName', () => {
  it('leaves an ordinary name alone', () => {
    expect(sanitizeSeatName('Ada')).toBe('Ada');
    expect(sanitizeSeatName('Mossbottom the Bold')).toBe('Mossbottom the Bold');
  });

  it('strips the bidi override and NUL the audit found, keeping the letters', () => {
    // RTL override, NUL, and a Cyrillic "\u0430": the first two go, the letter stays.
    expect(sanitizeSeatName('\u202Eeman\u0000 Ad\u0430')).toBe('eman Ad\u0430');
  });

  it('strips invisible format characters', () => {
    expect(sanitizeSeatName('A\u200Bd\u200Da\uFEFF')).toBe('Ada');
    expect(sanitizeSeatName('\u2066Bo\u2069')).toBe('Bo');
    expect(sanitizeSeatName('Bo\u00AD')).toBe('Bo'); // soft hyphen
    expect(sanitizeSeatName('Bo\uE000')).toBe('Bo'); // private use
  });

  it('turns line breaks and tabs into single spaces', () => {
    expect(sanitizeSeatName('Ada\n\n  Lovelace\t')).toBe('Ada Lovelace');
    expect(sanitizeSeatName('Ada\u2028Bo')).toBe('AdaBo');
  });

  it('keeps any script and emoji — this is a guest name, not a username', () => {
    expect(sanitizeSeatName('Мишка')).toBe('Мишка');
    expect(sanitizeSeatName('🍄 Mo')).toBe('🍄 Mo');
  });

  it('NFKC-normalises', () => {
    expect(sanitizeSeatName('Ａｄａ')).toBe('Ada'); // fullwidth letters
  });

  it('caps by code point and never splits a surrogate pair', () => {
    const name = sanitizeSeatName('🍄'.repeat(30));
    expect(Array.from(name!)).toHaveLength(SEAT_NAME_MAX);
    expect(name).toBe('🍄'.repeat(SEAT_NAME_MAX));
    expect(sanitizeSeatName('x'.repeat(100))).toHaveLength(SEAT_NAME_MAX);
  });

  it('does not end on a space after capping', () => {
    expect(sanitizeSeatName(`${'a'.repeat(SEAT_NAME_MAX - 1)} bcd`)).toBe('a'.repeat(SEAT_NAME_MAX - 1));
  });

  it('yields null when nothing usable is left', () => {
    for (const v of ['', '   ', '\u202E\u0000', 123, null, undefined, {}, ['Ada']]) {
      expect(sanitizeSeatName(v), JSON.stringify(v)).toBeNull();
    }
  });
});
