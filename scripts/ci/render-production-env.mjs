import { chmod, writeFile } from 'node:fs/promises';
import process from 'node:process';

const outputPath = process.argv[2];

if (!outputPath) {
  throw new Error('Usage: node scripts/ci/render-production-env.mjs <output-path>');
}

const required = [
  'AUTOBOT_API_IMAGE',
  'AUTOBOT_MIGRATION_IMAGE',
  'BUILD_SHA',
  'API_PUBLIC_URL',
  'AUTOBOT_DB_PASSWORD',
  'TELEGRAM_BOT_TOKEN',
  'BOT_SERVICE_ACTIVE_KEY_ID',
  'BOT_SERVICE_ACTIVE_SECRET',
  'YOOKASSA_SHOP_ID',
  'YOOKASSA_SECRET_KEY',
];

const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length > 0) {
  throw new Error(`Missing production configuration: ${missing.join(', ')}`);
}

const apiPublicUrl = new URL(process.env.API_PUBLIC_URL);

if (apiPublicUrl.protocol !== 'https:') {
  throw new Error('API_PUBLIC_URL must use HTTPS');
}

if (
  process.env.TELEGRAM_OIDC_REDIRECT_URI &&
  new URL(process.env.TELEGRAM_OIDC_REDIRECT_URI).protocol !== 'https:'
) {
  throw new Error('TELEGRAM_OIDC_REDIRECT_URI must use HTTPS when configured');
}

for (const origin of (process.env.CORS_ALLOWED_ORIGINS || '').split(',').filter(Boolean)) {
  const normalized = origin.trim();
  const parsed = new URL(normalized);
  if (!normalized || parsed.origin !== normalized || parsed.protocol !== 'https:') {
    throw new Error('CORS_ALLOWED_ORIGINS must contain exact HTTPS origins');
  }
}

if (process.env.BOT_SERVICE_ACTIVE_SECRET.length < 32) {
  throw new Error('BOT_SERVICE_ACTIVE_SECRET must contain at least 32 characters');
}

const databaseUser = process.env.AUTOBOT_DB_USER?.trim() || 'autobot';
const databaseName = process.env.AUTOBOT_DB_NAME?.trim() || 'autobot';

for (const [name, value] of [
  ['AUTOBOT_DB_USER', databaseUser],
  ['AUTOBOT_DB_NAME', databaseName],
]) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${name} must be a PostgreSQL identifier`);
  }
}

const databaseUrl =
  `postgresql://${encodeURIComponent(databaseUser)}:` +
  `${encodeURIComponent(process.env.AUTOBOT_DB_PASSWORD)}` +
  `@autobot-postgres:5432/${encodeURIComponent(databaseName)}` +
  '?schema=public&connect_timeout=5';

const values = {
  AUTOBOT_API_IMAGE: process.env.AUTOBOT_API_IMAGE,
  AUTOBOT_MIGRATION_IMAGE: process.env.AUTOBOT_MIGRATION_IMAGE,
  BUILD_SHA: process.env.BUILD_SHA,
  API_PUBLIC_URL: process.env.API_PUBLIC_URL,
  API_HOST: new URL(process.env.API_PUBLIC_URL).host,
  LOG_LEVEL: process.env.LOG_LEVEL || 'log',
  TRUST_PROXY_HOPS: process.env.TRUST_PROXY_HOPS || '1',
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS || '',
  WEB_ALLOWED_RETURN_URLS: process.env.WEB_ALLOWED_RETURN_URLS || '',
  AUTOBOT_DB_USER: databaseUser,
  AUTOBOT_DB_PASSWORD: process.env.AUTOBOT_DB_PASSWORD,
  AUTOBOT_DB_NAME: databaseName,
  AUTOBOT_DATABASE_URL: databaseUrl,
  REDIS_KEY_PREFIX: process.env.REDIS_KEY_PREFIX || 'autobot:production',
  QUEUE_PREFIX: process.env.QUEUE_PREFIX || 'autobot:production',
  TELEGRAM_OIDC_ISSUER: process.env.TELEGRAM_OIDC_ISSUER || 'https://oauth.telegram.org',
  TELEGRAM_OIDC_CLIENT_ID: process.env.TELEGRAM_OIDC_CLIENT_ID || '',
  TELEGRAM_OIDC_CLIENT_SECRET: process.env.TELEGRAM_OIDC_CLIENT_SECRET || '',
  TELEGRAM_OIDC_REDIRECT_URI: process.env.TELEGRAM_OIDC_REDIRECT_URI || '',
  TELEGRAM_OIDC_SCOPES: process.env.TELEGRAM_OIDC_SCOPES || 'openid profile',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  GPTUNNEL_API_KEY: process.env.GPTUNNEL_API_KEY || '',
  GPTUNNEL_USE_WALLET_BALANCE: process.env.GPTUNNEL_USE_WALLET_BALANCE || 'false',
  GPTUNNEL_IMAGE_PARAMS: process.env.GPTUNNEL_IMAGE_PARAMS || '{}',
  AI_TEXT_MODEL: process.env.AI_TEXT_MODEL || 'gpt-4o-mini',
  AI_IMAGE_MODEL: process.env.AI_IMAGE_MODEL || 'gpt-image',
  AI_TEXT_MAX_TOKENS: process.env.AI_TEXT_MAX_TOKENS || '4096',
  AI_REQUEST_TIMEOUT_MS: process.env.AI_REQUEST_TIMEOUT_MS || '30000',
  AI_IMAGE_TIMEOUT_MS: process.env.AI_IMAGE_TIMEOUT_MS || '180000',
  AI_IMAGE_POLL_INTERVAL_MS: process.env.AI_IMAGE_POLL_INTERVAL_MS || '2000',
  SESSION_COOKIE_SAME_SITE: process.env.SESSION_COOKIE_SAME_SITE || 'none',
  SESSION_COOKIE_SECURE: 'true',
  BOT_SERVICE_ACTIVE_KEY_ID: process.env.BOT_SERVICE_ACTIVE_KEY_ID,
  BOT_SERVICE_ACTIVE_SECRET: process.env.BOT_SERVICE_ACTIVE_SECRET,
  YOOKASSA_SHOP_ID: process.env.YOOKASSA_SHOP_ID,
  YOOKASSA_SECRET_KEY: process.env.YOOKASSA_SECRET_KEY,
  YOOKASSA_RETURN_URL: process.env.YOOKASSA_RETURN_URL || '',
  YOOKASSA_TEST_CHECKOUT_ENABLED: 'false',
  YOOKASSA_WEBHOOK_ENABLED: 'false',
  YOOKASSA_TEST_USER_IDS: '',
  YOOKASSA_REQUEST_TIMEOUT_MS: process.env.YOOKASSA_REQUEST_TIMEOUT_MS || '10000',
};

const contents = `${Object.entries(values)
  .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
  .join('\n')}\n`;

await writeFile(outputPath, contents, { encoding: 'utf8', mode: 0o600 });
await chmod(outputPath, 0o600);
