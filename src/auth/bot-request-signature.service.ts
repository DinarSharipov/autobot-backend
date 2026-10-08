import { createHash, createHmac } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { BotServicePrincipal } from '../common/auth/auth-principal.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import type { AppEnvironment } from '../config/environment.js';
import { RedisService } from '../infrastructure/redis/redis.service.js';
import { safeEqual } from './crypto.js';

const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TELEGRAM_USER_ID_PATTERN = /^[1-9]\d*$/;

function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function canonicalPathAndQuery(originalUrl: string): string {
  const url = new URL(originalUrl, 'http://autobot.internal');
  const query = [...url.searchParams.entries()]
    .map(([key, value]) => [rfc3986Encode(key), rfc3986Encode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
      if (leftValue === rightValue) return 0;
      return leftValue < rightValue ? -1 : 1;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return query ? `${url.pathname}?${query}` : url.pathname;
}

export function canonicalBotRequest(input: {
  method: string;
  originalUrl: string;
  body: Buffer;
  timestamp: string;
  nonce: string;
  telegramUserId: string;
}): string {
  const bodyHash = createHash('sha256').update(input.body).digest('hex');
  return [
    input.method.toUpperCase(),
    canonicalPathAndQuery(input.originalUrl),
    bodyHash,
    input.timestamp,
    input.nonce,
    input.telegramUserId,
  ].join('\n');
}

@Injectable()
export class BotRequestSignatureService {
  private readonly activeKeyId: string | undefined;
  private readonly activeSecret: string | undefined;
  private readonly previousKeyId: string | undefined;
  private readonly previousSecret: string | undefined;
  private readonly clockSkewSeconds: number;
  private readonly nonceTtlSeconds: number;

  constructor(
    config: ConfigService<AppEnvironment, true>,
    private readonly redis: RedisService,
  ) {
    this.activeKeyId = config.get('BOT_SERVICE_ACTIVE_KEY_ID', { infer: true });
    this.activeSecret = config.get('BOT_SERVICE_ACTIVE_SECRET', { infer: true });
    this.previousKeyId = config.get('BOT_SERVICE_PREVIOUS_KEY_ID', { infer: true });
    this.previousSecret = config.get('BOT_SERVICE_PREVIOUS_SECRET', { infer: true });
    this.clockSkewSeconds = config.get('BOT_SERVICE_CLOCK_SKEW_SECONDS', { infer: true });
    this.nonceTtlSeconds = config.get('BOT_SERVICE_NONCE_TTL_SECONDS', { infer: true });
  }

  async authenticate(request: Request & { rawBody?: Buffer }): Promise<BotServicePrincipal> {
    const service = request.get('x-autobot-service');
    const keyId = request.get('x-autobot-key-id');
    const timestamp = request.get('x-autobot-timestamp');
    const nonce = request.get('x-autobot-nonce');
    const signature = request.get('x-autobot-signature');
    const telegramUserId = request.get('x-telegram-user-id');

    if (
      service !== 'autobot-bot' ||
      !keyId ||
      !timestamp ||
      !nonce ||
      !signature ||
      !telegramUserId ||
      !/^\d+$/.test(timestamp) ||
      !UUID_PATTERN.test(nonce) ||
      !TELEGRAM_USER_ID_PATTERN.test(telegramUserId)
    ) {
      return this.reject();
    }

    const timestampSeconds = Number(timestamp);
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > this.clockSkewSeconds
    ) {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'BOT_REQUEST_EXPIRED',
        'Bot request authentication failed.',
      );
    }

    const secret = this.secretForKey(keyId);
    const signatureMatch = SIGNATURE_PATTERN.exec(signature);
    if (!secret || !signatureMatch?.[1]) return this.reject();

    const canonical = canonicalBotRequest({
      method: request.method,
      originalUrl: request.originalUrl,
      body: request.rawBody ?? Buffer.alloc(0),
      timestamp,
      nonce,
      telegramUserId,
    });
    const expected = createHmac('sha256', secret).update(canonical).digest('hex');
    if (!safeEqual(expected, signatureMatch[1])) return this.reject();

    let nonceAccepted: boolean;
    try {
      nonceAccepted = await this.redis.setIfAbsent(
        `bot-nonce:${keyId}:${nonce}`,
        this.nonceTtlSeconds,
      );
    } catch {
      throw new ApiHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'BOT_AUTH_DEPENDENCY_UNAVAILABLE',
        'Bot authentication is temporarily unavailable.',
      );
    }

    if (!nonceAccepted) {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'BOT_REQUEST_REPLAYED',
        'Bot request authentication failed.',
      );
    }

    return { kind: 'bot-service', service: 'autobot-bot', keyId, telegramUserId };
  }

  private secretForKey(keyId: string): string | undefined {
    if (keyId === this.activeKeyId) return this.activeSecret;
    if (keyId === this.previousKeyId) return this.previousSecret;
    return undefined;
  }

  private reject(): never {
    throw new ApiHttpException(
      HttpStatus.UNAUTHORIZED,
      'INVALID_BOT_SIGNATURE',
      'Bot request authentication failed.',
    );
  }
}
