import { HttpStatus } from '@nestjs/common';

import type { AuthPrincipal } from '../auth/auth-principal.js';
import { ApiHttpException } from './api-http.exception.js';

export function requirePrincipalUserId(principal: AuthPrincipal | undefined): string {
  if (!principal || !('userId' in principal)) {
    throw new ApiHttpException(
      HttpStatus.UNAUTHORIZED,
      'AUTH_REQUIRED',
      'Authentication required.',
    );
  }
  return principal.userId;
}

export function parseIfMatch(value: string | undefined): number {
  if (!value) {
    throw new ApiHttpException(
      HttpStatus.BAD_REQUEST,
      'IF_MATCH_REQUIRED',
      'If-Match with the current resource version is required.',
    );
  }
  const match = /^"([1-9]\d*)"$/.exec(value);
  if (!match?.[1]) {
    throw new ApiHttpException(
      HttpStatus.BAD_REQUEST,
      'INVALID_IF_MATCH',
      'If-Match must be a quoted positive integer version.',
    );
  }
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) {
    throw new ApiHttpException(
      HttpStatus.BAD_REQUEST,
      'INVALID_IF_MATCH',
      'If-Match version is outside the supported integer range.',
    );
  }
  return version;
}

export function requireIdempotencyKey(value: string | undefined): string {
  if (!value || value.length < 16 || value.length > 128 || !/^[\x20-\x7E]+$/.test(value)) {
    throw new ApiHttpException(
      HttpStatus.BAD_REQUEST,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must contain 16 to 128 printable ASCII characters.',
    );
  }
  return value;
}
