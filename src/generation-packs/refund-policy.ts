import { ApiHttpException } from '../common/http/api-http.exception.js';

// Integer minor units only. Do not use floats to decide how many credits to revoke.
export function parseRefundMinor(value: string): number {
  if (!/^\d+\.\d{2}$/.test(value)) throw invalidRefund();
  const amount = BigInt(value.replace('.', ''));
  if (amount <= 0n || amount > 2147483647n) throw invalidRefund();
  return Number(amount);
}

export function cumulativeRefundUnits(
  totalMinor: number,
  priceMinor: number,
  units: number,
): number {
  if (
    !Number.isSafeInteger(totalMinor) ||
    !Number.isSafeInteger(priceMinor) ||
    !Number.isSafeInteger(units) ||
    totalMinor < 0 ||
    priceMinor <= 0 ||
    units <= 0 ||
    totalMinor > priceMinor
  )
    throw invalidRefund();
  // Cumulative flooring carries fractional credits forward across partial refunds.
  return Number((BigInt(totalMinor) * BigInt(units)) / BigInt(priceMinor));
}

function invalidRefund() {
  return new ApiHttpException(
    409,
    'REFUND_VERIFICATION_FAILED',
    'Refund amount could not be verified.',
  );
}
