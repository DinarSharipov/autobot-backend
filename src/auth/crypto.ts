import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomOpaqueSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function deriveCsrfToken(sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update('autobot-csrf-v1').digest('base64url');
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
