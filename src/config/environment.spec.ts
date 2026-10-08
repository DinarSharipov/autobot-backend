import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment.js';

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/autobot',
  REDIS_URL: 'redis://localhost:6379/0',
};

describe('validateEnvironment', () => {
  it('applies safe defaults and parses numeric values', () => {
    const environment = validateEnvironment({ ...validEnvironment, PORT: '3100' });

    expect(environment.PORT).toBe(3100);
    expect(environment.CORS_ALLOWED_ORIGINS).toEqual([]);
    expect(environment.IMAGE_TEMP_DIR).toBe('.tmp/images');
  });

  it('rejects wildcard credentialed CORS configuration', () => {
    expect(() => validateEnvironment({ ...validEnvironment, CORS_ALLOWED_ORIGINS: '*' })).toThrow(
      'wildcard origins are forbidden',
    );
  });

  it('rejects a non-HTTPS public URL in production', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        API_PUBLIC_URL: 'http://api.example.com',
      }),
    ).toThrow('must use HTTPS in production');
  });

  it('does not include secret values in validation errors', () => {
    const secret = 'postgresql://secret-user:secret-password@localhost:5432/autobot';

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        DATABASE_URL: secret.replace('postgresql', 'ftp'),
      }),
    ).toThrowError(/DATABASE_URL/);

    try {
      validateEnvironment({
        ...validEnvironment,
        DATABASE_URL: secret.replace('postgresql', 'ftp'),
      });
    } catch (error) {
      expect(String(error)).not.toContain('secret-password');
    }
  });

  it('requires complete OIDC and rotated bot key pairs', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        TELEGRAM_OIDC_CLIENT_ID: '123',
      }),
    ).toThrow('must be configured together');

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        BOT_SERVICE_PREVIOUS_KEY_ID: 'previous',
      }),
    ).toThrow('must be configured together');
  });

  it('requires secure cookies for SameSite=None', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        SESSION_COOKIE_SAME_SITE: 'none',
        SESSION_COOKIE_SECURE: 'false',
      }),
    ).toThrow('must be true when SameSite=None');
  });
});
