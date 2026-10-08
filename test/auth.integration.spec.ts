import { createHmac, randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request, { type Response as SupertestResponse } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppModule } from '../src/app.module.js';
import { canonicalBotRequest } from '../src/auth/bot-request-signature.service.js';
import {
  TelegramOidcClient,
  type TelegramAuthorizationParameters,
} from '../src/auth/telegram-oidc.client.js';
import { configureApplication } from '../src/bootstrap.js';
import { ApiHttpException } from '../src/common/http/api-http.exception.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { IdentityService, type TelegramOidcIdentity } from '../src/users/identity.service.js';
import { cleanTestDatabase } from './support/test-database.js';

const BOT_SECRET = 'test-secret-32-bytes-long-1234567890';
const BOT_KEY_ID = 'test-key';
const PREVIOUS_BOT_SECRET = 'previous-secret-32-bytes-long-123456';
const PREVIOUS_BOT_KEY_ID = 'previous-key';
const TELEGRAM_USER_ID = '123456789';

class FakeTelegramOidcClient extends TelegramOidcClient {
  authorizationUrl(parameters: TelegramAuthorizationParameters): URL {
    const url = new URL('https://telegram.example.test/auth');
    url.search = new URLSearchParams({
      state: parameters.state,
      nonce: parameters.nonce,
      code_challenge: parameters.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url;
  }

  exchangeAndVerify(
    code: string,
    codeVerifier: string,
    expectedNonce: string,
  ): Promise<TelegramOidcIdentity> {
    if (code !== 'valid-code' || codeVerifier.length < 43 || expectedNonce.length < 32) {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'INVALID_TELEGRAM_ID_TOKEN',
        'Telegram identity token validation failed.',
      );
    }

    return Promise.resolve({
      subject: 'telegram-oidc-subject-1',
      telegramUserId: TELEGRAM_USER_ID,
      username: 'dinar',
      firstName: 'Dinar',
      lastName: null,
      photoUrl: null,
    });
  }
}

type LoginResult = {
  cookie: string;
  state: string;
  userId: string;
};

function responseCookie(response: SupertestResponse): string {
  const header: unknown = response.headers['set-cookie'];
  const values = Array.isArray(header) ? (header as unknown[]) : [header];
  const value: unknown = values[0];
  if (typeof value !== 'string') throw new Error('Expected Set-Cookie response header');
  const cookie = value.split(';')[0];
  if (!cookie) throw new Error('Expected cookie value');
  return cookie;
}

function responseHeader(response: SupertestResponse, name: string): string {
  const value: unknown = response.headers[name];
  if (typeof value !== 'string') throw new Error(`Expected ${name} response header`);
  return value;
}

const userEnvelopeSchema = z.object({ data: z.object({ id: z.string().uuid() }) });
const sessionEnvelopeSchema = z.object({
  data: z.object({ user: z.object({ id: z.string().uuid() }) }),
});
const csrfEnvelopeSchema = z.object({ data: z.object({ token: z.string().min(1) }) });
const errorEnvelopeSchema = z.object({ error: z.object({ code: z.string() }) });

function signedBotHeaders(input: {
  method: string;
  path: string;
  body?: string;
  nonce?: string;
  telegramUserId?: string;
  keyId?: string;
  secret?: string;
  timestamp?: string;
}): Record<string, string> {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? randomUUID();
  const telegramUserId = input.telegramUserId ?? TELEGRAM_USER_ID;
  const canonical = canonicalBotRequest({
    method: input.method,
    originalUrl: input.path,
    body: Buffer.from(input.body ?? ''),
    timestamp,
    nonce,
    telegramUserId,
  });
  const signature = createHmac('sha256', input.secret ?? BOT_SECRET)
    .update(canonical)
    .digest('hex');

  return {
    'X-Autobot-Service': 'autobot-bot',
    'X-Autobot-Key-Id': input.keyId ?? BOT_KEY_ID,
    'X-Autobot-Timestamp': timestamp,
    'X-Autobot-Nonce': nonce,
    'X-Autobot-Signature': `v1=${signature}`,
    'X-Telegram-User-Id': telegramUserId,
  };
}

describe('identity and access', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TelegramOidcClient)
      .useValue(new FakeTelegramOidcClient())
      .compile();
    app = moduleReference.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApplication(app, { swagger: false });
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await cleanTestDatabase(prisma, process.env.DATABASE_URL ?? '');
  });

  afterAll(async () => {
    await app.close();
  });

  async function login(previousCookie?: string): Promise<LoginResult> {
    const start = await request(app.getHttpServer())
      .get('/api/v1/auth/telegram/start')
      .query({ returnTo: 'https://web.example.test/app/dashboard' })
      .expect(302);
    const authorizationUrl = new URL(responseHeader(start, 'location'));
    const state = authorizationUrl.searchParams.get('state');
    if (!state) throw new Error('Expected OIDC state');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');

    let callbackRequest = request(app.getHttpServer())
      .get('/api/v1/auth/telegram/callback')
      .query({ state, code: 'valid-code' });
    if (previousCookie) callbackRequest = callbackRequest.set('Cookie', previousCookie);
    const callback = await callbackRequest.expect(302);
    expect(responseHeader(callback, 'location')).toBe('https://web.example.test/app/dashboard');
    const setCookie = String(callback.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');

    const cookie = responseCookie(callback);
    const session = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', cookie)
      .expect(200);

    return {
      cookie,
      state,
      userId: sessionEnvelopeSchema.parse(session.body as unknown).data.user.id,
    };
  }

  it('shares one identity across browser and authenticated bot flows', async () => {
    const browser = await login();
    const rawSecret = browser.cookie.split('=')[1];
    const storedSession = await prisma.session.findFirstOrThrow({
      where: { userId: browser.userId },
    });
    expect(storedSession.secretHash).not.toBe(rawSecret);
    expect(storedSession.secretHash).toMatch(/^[0-9a-f]{64}$/);

    const browserMe = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Cookie', browser.cookie)
      .expect(200);
    expect(userEnvelopeSchema.parse(browserMe.body as unknown).data.id).toBe(browser.userId);

    const profileBody = JSON.stringify({ firstName: 'Dinar', username: 'dinar' });
    const resolvePath = '/api/v1/internal/telegram-users/resolve';
    const headers = signedBotHeaders({ method: 'POST', path: resolvePath, body: profileBody });
    const botResolve = await request(app.getHttpServer())
      .post(resolvePath)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(profileBody)
      .expect(200);
    expect(userEnvelopeSchema.parse(botResolve.body as unknown).data.id).toBe(browser.userId);

    const replay = await request(app.getHttpServer())
      .post(resolvePath)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(profileBody)
      .expect(401);
    expect(errorEnvelopeSchema.parse(replay.body as unknown).error.code).toBe(
      'BOT_REQUEST_REPLAYED',
    );

    const mePath = '/api/v1/me';
    const botMe = await request(app.getHttpServer())
      .get(mePath)
      .set(signedBotHeaders({ method: 'GET', path: mePath }))
      .expect(200);
    expect(userEnvelopeSchema.parse(botMe.body as unknown).data.id).toBe(browser.userId);

    const csrf = await request(app.getHttpServer())
      .get('/api/v1/auth/csrf')
      .set('Cookie', browser.cookie)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', browser.cookie)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', browser.cookie)
      .set('X-CSRF-Token', csrfEnvelopeSchema.parse(csrf.body as unknown).data.token)
      .expect(204);
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', browser.cookie)
      .expect(401);
  });

  it('consumes login state once and rejects invalid return URLs', async () => {
    const invalidReturn = await request(app.getHttpServer())
      .get('/api/v1/auth/telegram/start')
      .query({ returnTo: 'https://evil.example.test/' })
      .expect(400);
    expect(responseHeader(invalidReturn, 'cache-control')).toBe('no-store');

    const missingSession = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .expect(401);
    expect(responseHeader(missingSession, 'cache-control')).toBe('no-store');

    const loginResult = await login();
    const replay = await request(app.getHttpServer())
      .get('/api/v1/auth/telegram/callback')
      .query({ state: loginResult.state, code: 'valid-code' })
      .expect(401);
    expect(errorEnvelopeSchema.parse(replay.body as unknown).error.code).toBe(
      'INVALID_LOGIN_STATE',
    );
  });

  it('rejects invalid OIDC data and expired sessions', async () => {
    const start = await request(app.getHttpServer())
      .get('/api/v1/auth/telegram/start')
      .query({ returnTo: 'https://web.example.test/app/' })
      .expect(302);
    const state = new URL(responseHeader(start, 'location')).searchParams.get('state');
    if (!state) throw new Error('Expected OIDC state');
    const invalid = await request(app.getHttpServer())
      .get('/api/v1/auth/telegram/callback')
      .query({ state, code: 'invalid-code' })
      .expect(401);
    expect(errorEnvelopeSchema.parse(invalid.body as unknown).error.code).toBe(
      'INVALID_TELEGRAM_ID_TOKEN',
    );

    const browser = await login();
    await prisma.session.updateMany({
      where: { userId: browser.userId },
      data: { idleExpiresAt: new Date(Date.now() - 1000) },
    });
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', browser.cookie)
      .expect(401);
    const expired = await prisma.session.findFirstOrThrow({ where: { userId: browser.userId } });
    expect(expired.revokedAt).not.toBeNull();
  });

  it('rotates a prior session after a new login', async () => {
    const first = await login();
    const second = await login(first.cookie);

    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', first.cookie)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', second.cookie)
      .expect(200);
  });

  it('allows only one concurrent use of an OIDC state', async () => {
    const start = await request(app.getHttpServer())
      .get('/api/v1/auth/telegram/start')
      .query({ returnTo: 'https://web.example.test/app/' })
      .expect(302);
    const state = new URL(responseHeader(start, 'location')).searchParams.get('state');
    if (!state) throw new Error('Expected OIDC state');

    const callbacks = await Promise.all([
      request(app.getHttpServer())
        .get('/api/v1/auth/telegram/callback')
        .query({ state, code: 'valid-code' }),
      request(app.getHttpServer())
        .get('/api/v1/auth/telegram/callback')
        .query({ state, code: 'valid-code' }),
    ]);
    expect(callbacks.map((response) => response.status).sort()).toEqual([302, 401]);
    expect(await prisma.user.count()).toBe(1);
  });

  it('resolves concurrent bot onboarding to one PostgreSQL user', async () => {
    const identities = app.get(IdentityService);
    const users = await Promise.all(
      Array.from({ length: 4 }, () =>
        identities.resolveBotUser({ telegramUserId: '987654321', firstName: 'Concurrent' }),
      ),
    );
    expect(new Set(users.map((user) => user.id)).size).toBe(1);
    expect(await prisma.telegramAccount.count({ where: { telegramUserId: 987654321n } })).toBe(1);
  });

  it('refuses to merge conflicting Telegram identity mappings', async () => {
    const identities = app.get(IdentityService);
    const first = await identities.resolveBotUser({ telegramUserId: '111111111' });
    const second = await identities.resolveBotUser({ telegramUserId: '222222222' });
    expect(first.id).not.toBe(second.id);

    await identities.resolveOidcUser({
      subject: 'conflicting-subject',
      telegramUserId: '111111111',
    });
    await expect(
      identities.resolveOidcUser({
        subject: 'conflicting-subject',
        telegramUserId: '222222222',
      }),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_LINK_CONFLICT' } });
    expect(await prisma.user.count()).toBe(2);
  });

  it('allows only configured credentialed CORS origins', async () => {
    const allowed = await request(app.getHttpServer())
      .options('/api/v1/auth/session')
      .set('Origin', 'https://web.example.test')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://web.example.test');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const disallowed = await request(app.getHttpServer())
      .options('/api/v1/auth/session')
      .set('Origin', 'https://evil.example.test')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    expect(disallowed.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not accept an arbitrary Telegram user with an invalid signature', async () => {
    const path = '/api/v1/internal/telegram-users/resolve';
    const body = '{}';
    const headers = signedBotHeaders({
      method: 'POST',
      path,
      body,
      telegramUserId: '777777777',
    });
    headers['X-Autobot-Signature'] = `v1=${'0'.repeat(64)}`;

    const response = await request(app.getHttpServer())
      .post(path)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(401);
    expect(errorEnvelopeSchema.parse(response.body as unknown).error.code).toBe(
      'INVALID_BOT_SIGNATURE',
    );
    expect(await prisma.telegramAccount.count()).toBe(0);
  });

  it('accepts the previous bot key during rotation and rejects stale timestamps', async () => {
    const path = '/api/v1/internal/telegram-users/resolve';
    const body = '{}';
    const previousKeyResponse = await request(app.getHttpServer())
      .post(path)
      .set(
        signedBotHeaders({
          method: 'POST',
          path,
          body,
          keyId: PREVIOUS_BOT_KEY_ID,
          secret: PREVIOUS_BOT_SECRET,
        }),
      )
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
    expect(userEnvelopeSchema.parse(previousKeyResponse.body as unknown).data.id).toBeTypeOf(
      'string',
    );

    const stale = await request(app.getHttpServer())
      .post(path)
      .set(
        signedBotHeaders({
          method: 'POST',
          path,
          body,
          timestamp: String(Math.floor(Date.now() / 1000) - 1000),
        }),
      )
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(401);
    expect(errorEnvelopeSchema.parse(stale.body as unknown).error.code).toBe('BOT_REQUEST_EXPIRED');
  });
});
