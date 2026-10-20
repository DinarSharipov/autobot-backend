import { describe, expect, it } from 'vitest';
import { cumulativeRefundUnits, parseRefundMinor } from './refund-policy.js';

describe('refund credit policy', () => {
  it('carries fractional credits across partial refunds and revokes all on full refund', () => {
    expect(cumulativeRefundUnits(1, 9900, 20)).toBe(0);
    expect(cumulativeRefundUnits(4949, 9900, 20)).toBe(9);
    expect(cumulativeRefundUnits(4950, 9900, 20)).toBe(10);
    expect(cumulativeRefundUnits(9900, 9900, 20)).toBe(20);
    expect(cumulativeRefundUnits(2147483646, 2147483647, 2147483647)).toBe(2147483646);
  });
  it.each(['0.00', '-1.00', '1.001', '1', '21474836.48', 'NaN'])(
    'rejects invalid amount %s',
    (value) => {
      expect(() => parseRefundMinor(value)).toThrow();
    },
  );
  it('uses integer money and rejects over-refunds and zero-price orders', () => {
    expect(parseRefundMinor('49.50')).toBe(4950);
    expect(() => cumulativeRefundUnits(9901, 9900, 20)).toThrow();
    expect(() => cumulativeRefundUnits(1, 0, 20)).toThrow();
  });
});
