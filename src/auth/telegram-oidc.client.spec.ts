import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ConfigService } from '@nestjs/config';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AppEnvironment, validateEnvironment } from '../config/environment.js';
import { TelegramOidcHttpClient } from './telegram-oidc.client.js';

describe('TelegramOidcHttpClient', () => {
  let server: Server;
  let issuer: string;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    const publicJwk = await exportJWK(keys.publicKey);
    Object.assign(publicJwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });

    const handleRequest = async (
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> => {
      if (request.url === '/.well-known/jwks.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }

      if (request.url === '/token' && request.method === 'POST') {
        const expectedAuthorization = `Basic ${Buffer.from('test-client:test-client-secret').toString('base64')}`;
        if (request.headers.authorization !== expectedAuthorization) {
          response.statusCode = 401;
          response.end('{}');
          return;
        }

        const now = Math.floor(Date.now() / 1000);
        const idToken = await new SignJWT({
          id: 123456789,
          nonce: 'expected-nonce',
          preferred_username: 'dinar',
          given_name: 'Dinar',
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setIssuer(issuer)
          .setAudience('test-client')
          .setSubject('telegram-subject')
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id_token: idToken }));
        return;
      }

      response.statusCode = 404;
      response.end();
    };

    server = createServer((request, response) => {
      void handleRequest(request, response).catch(() => {
        response.statusCode = 500;
        response.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    issuer = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  function createClient(): TelegramOidcHttpClient {
    const environment = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:password@localhost:5432/autobot_test',
      REDIS_URL: 'redis://localhost:6380/15',
      WEB_ALLOWED_RETURN_URLS: 'https://web.example.test/app/',
      TELEGRAM_OIDC_ISSUER: issuer,
      TELEGRAM_OIDC_CLIENT_ID: 'test-client',
      TELEGRAM_OIDC_CLIENT_SECRET: 'test-client-secret',
      TELEGRAM_OIDC_REDIRECT_URI: 'https://api.example.test/api/v1/auth/telegram/callback',
    });
    return new TelegramOidcHttpClient(new ConfigService<AppEnvironment, true>(environment));
  }

  it('builds Authorization Code + S256 parameters and verifies signed Telegram claims', async () => {
    const client = createClient();
    const authorizationUrl = client.authorizationUrl({
      state: 'state-value',
      nonce: 'expected-nonce',
      codeChallenge: 'challenge-value',
    });
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('scope')).toBe('openid profile');

    await expect(
      client.exchangeAndVerify('authorization-code', 'pkce-verifier', 'expected-nonce'),
    ).resolves.toMatchObject({
      subject: 'telegram-subject',
      telegramUserId: '123456789',
      username: 'dinar',
      firstName: 'Dinar',
    });
  });

  it('rejects a validly signed token with the wrong nonce', async () => {
    await expect(
      createClient().exchangeAndVerify('authorization-code', 'pkce-verifier', 'wrong-nonce'),
    ).rejects.toMatchObject({ response: { code: 'INVALID_TELEGRAM_ID_TOKEN' } });
  });
});
