import { describe, expect, it } from 'vitest';
import {
  allocateProportionally,
  currencyExponent,
  fromMinor,
  multiplyMinor,
  percentOf,
  toMajor,
  toMinor,
} from '../../src/domain/money.js';

describe('money', () => {
  it('uses the right number of decimals per currency', () => {
    expect(currencyExponent('AUD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent(undefined)).toBe(2);
  });

  it('converts decimal strings into minor units without float drift', () => {
    expect(toMinor('12.34', 'AUD')).toBe(1234);
    expect(toMinor('12.3', 'AUD')).toBe(1230);
    expect(toMinor('0.1', 'AUD')).toBe(10);
    expect(toMinor('-5.55', 'AUD')).toBe(-555);
    expect(toMinor('1200', 'JPY')).toBe(1200);
    expect(toMinor('1.234', 'KWD')).toBe(1234);
    expect(toMinor(undefined, 'AUD')).toBe(0);
    expect(toMinor(null, 'AUD')).toBe(0);
    expect(toMinor('not a number', 'AUD')).toBe(0);
  });

  it('rounds half away from zero', () => {
    expect(toMinor('0.005', 'AUD')).toBe(1);
    expect(toMinor('-0.005', 'AUD')).toBe(-1);
    expect(toMinor('0.004', 'AUD')).toBe(0);
  });

  it('converts minor units back into decimals', () => {
    expect(fromMinor(1234, 'AUD')).toBe('12.34');
    expect(fromMinor(-555, 'AUD')).toBe('-5.55');
    expect(fromMinor(1200, 'JPY')).toBe('1200');
    expect(fromMinor(1234, 'KWD')).toBe('1.234');
    expect(toMajor(1999, 'AUD')).toBe(19.99);
  });

  it('multiplies quantities and keeps whole minor units', () => {
    expect(multiplyMinor(1000, 2.5)).toBe(2500);
    expect(multiplyMinor(333, 3)).toBe(999);
  });

  it('computes percentages', () => {
    expect(percentOf(7990, 10)).toBe(799);
    expect(percentOf(1000, 7.5)).toBe(75);
  });

  it('allocates an amount proportionally without losing a cent', () => {
    const shares = allocateProportionally(1000, [1, 1, 1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(shares).toEqual([334, 333, 333]);

    const weighted = allocateProportionally(1500, [5000, 3000, 2000]);
    expect(weighted.reduce((a, b) => a + b, 0)).toBe(1500);
    expect(weighted).toEqual([750, 450, 300]);
  });

  it('handles a zero weight basket', () => {
    expect(allocateProportionally(500, [0, 0])).toEqual([500, 0]);
  });
});
