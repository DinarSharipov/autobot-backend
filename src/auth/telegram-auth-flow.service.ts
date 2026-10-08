import { createHash } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import { ApiHttpException } from '../common/http/api-http.exception.js';
import type { AppEnvironment } from '../config/environment.js';
import { RedisService } from '../infrastructure/redis/redis.service.js';
import type { TelegramOidcIdentity } from '../users/identity.service.js';
import { AllowedReturnUrlService } from './allowed-return-url.service.js';
import { randomOpaqueSecret, sha256Hex } from './crypto.js';
import { TelegramOidcClient } from './telegram-oidc.client.js';

const flowRecordSchema = z.object({
  codeVerifier: z.string().min(43),
  nonce: z.string().min(32),
  returnTo: z.url(),
});

export type CompletedTelegramLogin = {
  identity: TelegramOidcIdentity;
  returnTo: string;
};

@Injectable()
export class TelegramAuthFlowService {
  private readonly ttlSeconds: number;

  constructor(
    config: ConfigService<AppEnvironment, true>,
    private readonly redis: RedisService,
    private readonly returnUrls: AllowedReturnUrlService,
    private readonly oidc: TelegramOidcClient,
  ) {
    this.ttlSeconds = config.get('OIDC_FLOW_TTL_SECONDS', { infer: true });
  }

  async start(returnToValue: string): Promise<URL> {
    const returnTo = this.returnUrls.validate(returnToValue);
    const state = randomOpaqueSecret();
    const nonce = randomOpaqueSecret();
    const codeVerifier = randomOpaqueSecret();
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    try {
      await this.redis.setJson(
        this.stateKey(state),
        { codeVerifier, nonce, returnTo },
        this.ttlSeconds,
      );
    } catch {
      this.dependencyUnavailable();
    }

    return this.oidc.authorizationUrl({ state, nonce, codeChallenge });
  }

  async complete(
    code: string | undefined,
    state: string,
    providerError?: string,
  ): Promise<CompletedTelegramLogin> {
    let rawRecord: unknown;
    try {
      rawRecord = await this.redis.consumeJson<unknown>(this.stateKey(state));
    } catch {
      this.dependencyUnavailable();
    }
    const record = flowRecordSchema.safeParse(rawRecord);
    if (!record.success) {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'INVALID_LOGIN_STATE',
        'The login attempt is invalid, expired, or already used.',
      );
    }

    if (providerError || !code) {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'TELEGRAM_LOGIN_REJECTED',
        'Telegram authentication was not completed.',
      );
    }

    const identity = await this.oidc.exchangeAndVerify(
      code,
      record.data.codeVerifier,
      record.data.nonce,
    );
    return { identity, returnTo: record.data.returnTo };
  }

  private stateKey(state: string): string {
    return `oidc-state:${sha256Hex(state)}`;
  }

  private dependencyUnavailable(): never {
    throw new ApiHttpException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'AUTH_DEPENDENCY_UNAVAILABLE',
      'Authentication is temporarily unavailable.',
    );
  }
}
