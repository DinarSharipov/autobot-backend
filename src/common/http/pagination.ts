import { HttpStatus } from '@nestjs/common';

import { ApiHttpException } from './api-http.exception.js';

export type PageCursor = { createdAt: Date; id: string };

export function encodeCursor(value: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: value.createdAt.toISOString(), id: value.id }),
  ).toString('base64url');
}

export function decodeCursor(value: string | undefined): PageCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    const createdAt = typeof parsed.createdAt === 'string' ? new Date(parsed.createdAt) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime()) || typeof parsed.id !== 'string') {
      throw new Error('invalid cursor');
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new ApiHttpException(HttpStatus.BAD_REQUEST, 'INVALID_CURSOR', 'Cursor is invalid.');
  }
}
