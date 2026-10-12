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
  'CORS_ALLOWED_ORIGINS',
  'WEB_ALLOWED_RETURN_URLS',
  'AUTOBOT_DB_PASSWORD',
  'TELEGRAM_OIDC_CLIENT_ID',
  'TELEGRAM_OIDC_CLIENT_SECRET',
  'TELEGRAM_OIDC_REDIRECT_URI',
  'TELEGRAM_BOT_TOKEN',
  'BOT_SERVICE_ACTIVE_KEY_ID',
  'BOT_SERVICE_ACTIVE_SECRET',
];

const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length > 0) {
  throw new Error(`Missing production configuration: ${missing.join(', ')}`);
}

const apiPublicUrl = new URL(process.env.API_PUBLIC_URL);
const oidcRedirectUrl = new URL(process.env.TELEGRAM_OIDC_REDIRECT_URI);

if (apiPublicUrl.protocol !== 'https:' || oidcRedirectUrl.protocol !== 'https:') {
  throw new Error('API_PUBLIC_URL and TELEGRAM_OIDC_REDIRECT_URI must use HTTPS');
}

for (const origin of process.env.CORS_ALLOWED_ORIGINS.split(',')) {
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
  LOG_LEVEL: process.env.LOG_LEVEL || 'log',
  TRUST_PROXY_HOPS: process.env.TRUST_PROXY_HOPS || '1',
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
  WEB_ALLOWED_RETURN_URLS: process.env.WEB_ALLOWED_RETURN_URLS,
  AUTOBOT_DB_USER: databaseUser,
  AUTOBOT_DB_PASSWORD: process.env.AUTOBOT_DB_PASSWORD,
  AUTOBOT_DB_NAME: databaseName,
  AUTOBOT_DATABASE_URL: databaseUrl,
  REDIS_KEY_PREFIX: process.env.REDIS_KEY_PREFIX || 'autobot:production',
  QUEUE_PREFIX: process.env.QUEUE_PREFIX || 'autobot:production',
  TELEGRAM_OIDC_ISSUER: process.env.TELEGRAM_OIDC_ISSUER || 'https://oauth.telegram.org',
  TELEGRAM_OIDC_CLIENT_ID: process.env.TELEGRAM_OIDC_CLIENT_ID,
  TELEGRAM_OIDC_CLIENT_SECRET: process.env.TELEGRAM_OIDC_CLIENT_SECRET,
  TELEGRAM_OIDC_REDIRECT_URI: process.env.TELEGRAM_OIDC_REDIRECT_URI,
  TELEGRAM_OIDC_SCOPES: process.env.TELEGRAM_OIDC_SCOPES || 'openid profile',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  SESSION_COOKIE_SAME_SITE: process.env.SESSION_COOKIE_SAME_SITE || 'none',
  SESSION_COOKIE_SECURE: 'true',
  BOT_SERVICE_ACTIVE_KEY_ID: process.env.BOT_SERVICE_ACTIVE_KEY_ID,
  BOT_SERVICE_ACTIVE_SECRET: process.env.BOT_SERVICE_ACTIVE_SECRET,
};

const contents = `${Object.entries(values)
  .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
  .join('\n')}\n`;

await writeFile(outputPath, contents, { encoding: 'utf8', mode: 0o600 });
await chmod(outputPath, 0o600);
