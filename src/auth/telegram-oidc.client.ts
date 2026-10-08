import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

import { ApiHttpException } from '../common/http/api-http.exception.js';
import type { AppEnvironment } from '../config/environment.js';
import type { TelegramOidcIdentity } from '../users/identity.service.js';
import { safeEqual } from './crypto.js';

export type TelegramAuthorizationParameters = {
  state: string;
  nonce: string;
  codeChallenge: string;
};

export abstract class TelegramOidcClient {
  abstract authorizationUrl(parameters: TelegramAuthorizationParameters): URL;
  abstract exchangeAndVerify(
    code: string,
    codeVerifier: string,
    expectedNonce: string,
  ): Promise<TelegramOidcIdentity>;
}

const tokenResponseSchema = z.object({ id_token: z.string().min(1) });
const telegramClaimsSchema = z.object({
  sub: z.string().min(1),
  id: z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive().safe()]),
  nonce: z.string().min(1),
  iat: z.number().int(),
  preferred_username: z.string().nullish(),
  given_name: z.string().nullish(),
  family_name: z.string().nullish(),
  name: z.string().nullish(),
  picture: z.url().nullish(),
});

@Injectable()
export class TelegramOidcHttpClient extends TelegramOidcClient {
  private readonly issuer: string;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly redirectUri: string | undefined;
  private readonly scopes: string;
  private readonly timeoutMs: number;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: ConfigService<AppEnvironment, true>) {
    super();
    this.issuer = config.get('TELEGRAM_OIDC_ISSUER', { infer: true }).replace(/\/$/, '');
    this.clientId = config.get('TELEGRAM_OIDC_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('TELEGRAM_OIDC_CLIENT_SECRET', { infer: true });
    this.redirectUri = config.get('TELEGRAM_OIDC_REDIRECT_URI', { infer: true });
    this.scopes = config.get('TELEGRAM_OIDC_SCOPES', { infer: true });
    this.timeoutMs = config.get('OIDC_REQUEST_TIMEOUT_MS', { infer: true });
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`), {
      timeoutDuration: this.timeoutMs,
    });
  }

  authorizationUrl(parameters: TelegramAuthorizationParameters): URL {
    const { clientId, redirectUri } = this.requiredConfiguration();
    const url = new URL(`${this.issuer}/auth`);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scopes,
      state: parameters.state,
      nonce: parameters.nonce,
      code_challenge: parameters.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url;
  }

  async exchangeAndVerify(
    code: string,
    codeVerifier: string,
    expectedNonce: string,
  ): Promise<TelegramOidcIdentity> {
    const { clientId, clientSecret, redirectUri } = this.requiredConfiguration();
    const tokenUrl = new URL(`${this.issuer}/token`);
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    let response: Response;

    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ApiHttpException(
        HttpStatus.BAD_GATEWAY,
        'TELEGRAM_OIDC_UNAVAILABLE',
        'Telegram authentication is temporarily unavailable.',
      );
    }

    if (!response.ok) {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'TELEGRAM_LOGIN_FAILED',
        'Telegram authentication failed.',
      );
    }

    let rawTokenResponse: unknown;
    try {
      rawTokenResponse = await response.json();
    } catch {
      rawTokenResponse = null;
    }
    const tokenResponse = tokenResponseSchema.safeParse(rawTokenResponse);
    if (!tokenResponse.success) {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'TELEGRAM_LOGIN_FAILED',
        'Telegram authentication failed.',
      );
    }

    return this.verifyIdToken(tokenResponse.data.id_token, expectedNonce);
  }

  private async verifyIdToken(
    idToken: string,
    expectedNonce: string,
  ): Promise<TelegramOidcIdentity> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, {
        issuer: this.issuer,
        audience: this.requiredConfiguration().clientId,
        clockTolerance: 5,
      }));
    } catch {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'INVALID_TELEGRAM_ID_TOKEN',
        'Telegram identity token validation failed.',
      );
    }

    const claims = telegramClaimsSchema.safeParse(payload);
    if (!claims.success || !safeEqual(claims.data.nonce, expectedNonce)) {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'INVALID_TELEGRAM_ID_TOKEN',
        'Telegram identity token validation failed.',
      );
    }

    if (claims.data.iat > Math.floor(Date.now() / 1000) + 60) {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'INVALID_TELEGRAM_ID_TOKEN',
        'Telegram identity token validation failed.',
      );
    }

    return {
      subject: claims.data.sub,
      telegramUserId: String(claims.data.id),
      username: claims.data.preferred_username ?? null,
      firstName: claims.data.given_name ?? claims.data.name ?? null,
      lastName: claims.data.family_name ?? null,
      photoUrl: claims.data.picture ?? null,
    };
  }

  private requiredConfiguration(): {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  } {
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new ApiHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'TELEGRAM_OIDC_NOT_CONFIGURED',
        'Telegram authentication is not configured.',
      );
    }

    return {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
    };
  }
}
