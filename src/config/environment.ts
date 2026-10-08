import { z } from 'zod';

const commaSeparatedUrls = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url()));

const databaseUrl = z.url().refine(
  (value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'postgres:' || protocol === 'postgresql:';
  },
  { message: 'must use postgres:// or postgresql://' },
);

const optionalNonEmptyString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());

const environmentBoolean = z.preprocess((value) => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}, z.boolean());

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    API_PUBLIC_URL: z.url().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'log', 'debug', 'verbose']).default('log'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    BUILD_SHA: z.string().min(1).max(128).default('development'),
    CORS_ALLOWED_ORIGINS: commaSeparatedUrls,
    WEB_ALLOWED_RETURN_URLS: commaSeparatedUrls,
    REQUEST_BODY_LIMIT: z
      .string()
      .regex(/^\d+(?:kb|mb)$/i, 'must be a size such as 512kb or 1mb')
      .default('1mb'),
    DATABASE_URL: databaseUrl,
    REDIS_URL: z.url().refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol), {
      message: 'must use redis:// or rediss://',
    }),
    REDIS_KEY_PREFIX: z.string().min(1).max(128).default('autobot:development'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    IMAGE_TEMP_DIR: z.string().min(1).default('.tmp/images'),
    IMAGE_TEMP_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
    IMAGE_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .default(10 * 1024 * 1024),
    IMAGE_TEMP_MAX_TOTAL_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .default(500 * 1024 * 1024),
    TELEGRAM_OIDC_ISSUER: z.url().default('https://oauth.telegram.org'),
    TELEGRAM_OIDC_CLIENT_ID: optionalNonEmptyString,
    TELEGRAM_OIDC_CLIENT_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(16).optional(),
    ),
    TELEGRAM_OIDC_REDIRECT_URI: optionalUrl,
    TELEGRAM_OIDC_SCOPES: z.string().min(1).default('openid profile'),
    TELEGRAM_BOT_TOKEN: optionalNonEmptyString,
    TELEGRAM_API_BASE_URL: z.url().default('https://api.telegram.org'),
    TELEGRAM_API_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
    OIDC_FLOW_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
    OIDC_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
    SESSION_COOKIE_NAME: z.string().min(1).default('__Host-autobot_session'),
    SESSION_ABSOLUTE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(3600)
      .default(30 * 24 * 60 * 60),
    SESSION_IDLE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .default(7 * 24 * 60 * 60),
    SESSION_COOKIE_SAME_SITE: z.enum(['lax', 'none']).default('lax'),
    SESSION_COOKIE_SECURE: environmentBoolean.default(true),
    BOT_SERVICE_ACTIVE_KEY_ID: optionalNonEmptyString,
    BOT_SERVICE_ACTIVE_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional(),
    ),
    BOT_SERVICE_PREVIOUS_KEY_ID: optionalNonEmptyString,
    BOT_SERVICE_PREVIOUS_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional(),
    ),
    BOT_SERVICE_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(1).max(300).default(60),
    BOT_SERVICE_NONCE_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(20),
    AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
    QUEUE_PREFIX: z.string().min(1).max(128).default('autobot:development'),
    GENERATION_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(2),
    PUBLICATION_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(2),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
    SCHEDULER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
    SCHEDULER_LOOKAHEAD_SECONDS: z.coerce.number().int().min(1).default(300),
    PUBLICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  })
  .superRefine((environment, context) => {
    if (environment.CORS_ALLOWED_ORIGINS.includes('*')) {
      context.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'wildcard origins are forbidden',
      });
    }

    for (const origin of environment.CORS_ALLOWED_ORIGINS) {
      if (origin === '*') continue;
      if (new URL(origin).origin !== origin) {
        context.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'entries must be exact origins without paths, queries, or fragments',
        });
      }
    }

    if (
      environment.NODE_ENV === 'production' &&
      new URL(environment.API_PUBLIC_URL).protocol !== 'https:'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['API_PUBLIC_URL'],
        message: 'must use HTTPS in production',
      });
    }

    const oidcValues = [
      environment.TELEGRAM_OIDC_CLIENT_ID,
      environment.TELEGRAM_OIDC_CLIENT_SECRET,
      environment.TELEGRAM_OIDC_REDIRECT_URI,
    ];
    const oidcConfigured = oidcValues.every(Boolean);
    if (oidcValues.some(Boolean) && !oidcConfigured) {
      context.addIssue({
        code: 'custom',
        path: ['TELEGRAM_OIDC_CLIENT_ID'],
        message: 'OIDC client ID, secret, and redirect URI must be configured together',
      });
    }

    if (oidcConfigured && environment.WEB_ALLOWED_RETURN_URLS.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_ALLOWED_RETURN_URLS'],
        message: 'at least one return URL is required when Telegram OIDC is configured',
      });
    }

    const previousBotValues = [
      environment.BOT_SERVICE_PREVIOUS_KEY_ID,
      environment.BOT_SERVICE_PREVIOUS_SECRET,
    ];
    const activeBotValues = [
      environment.BOT_SERVICE_ACTIVE_KEY_ID,
      environment.BOT_SERVICE_ACTIVE_SECRET,
    ];
    if (activeBotValues.some(Boolean) && !activeBotValues.every(Boolean)) {
      context.addIssue({
        code: 'custom',
        path: ['BOT_SERVICE_ACTIVE_KEY_ID'],
        message: 'active bot key ID and secret must be configured together',
      });
    }
    if (previousBotValues.some(Boolean) && !previousBotValues.every(Boolean)) {
      context.addIssue({
        code: 'custom',
        path: ['BOT_SERVICE_PREVIOUS_KEY_ID'],
        message: 'previous bot key ID and secret must be configured together',
      });
    }

    if (
      environment.BOT_SERVICE_ACTIVE_KEY_ID &&
      environment.BOT_SERVICE_PREVIOUS_KEY_ID === environment.BOT_SERVICE_ACTIVE_KEY_ID
    ) {
      context.addIssue({
        code: 'custom',
        path: ['BOT_SERVICE_PREVIOUS_KEY_ID'],
        message: 'active and previous bot key IDs must differ',
      });
    }

    if (environment.SESSION_COOKIE_SAME_SITE === 'none' && !environment.SESSION_COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SECURE'],
        message: 'must be true when SameSite=None',
      });
    }

    if (
      environment.SESSION_COOKIE_NAME.startsWith('__Host-') &&
      !environment.SESSION_COOKIE_SECURE
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SECURE'],
        message: 'must be true for a __Host- cookie',
      });
    }

    if (environment.SESSION_IDLE_TTL_SECONDS > environment.SESSION_ABSOLUTE_TTL_SECONDS) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_IDLE_TTL_SECONDS'],
        message: 'cannot exceed the absolute session TTL',
      });
    }

    if (!environment.TELEGRAM_OIDC_SCOPES.split(/\s+/).includes('openid')) {
      context.addIssue({
        code: 'custom',
        path: ['TELEGRAM_OIDC_SCOPES'],
        message: 'must include openid',
      });
    }

    if (environment.NODE_ENV === 'production') {
      if (!oidcConfigured) {
        context.addIssue({
          code: 'custom',
          path: ['TELEGRAM_OIDC_CLIENT_ID'],
          message: 'Telegram OIDC configuration is required in production',
        });
      }

      if (!environment.BOT_SERVICE_ACTIVE_KEY_ID || !environment.BOT_SERVICE_ACTIVE_SECRET) {
        context.addIssue({
          code: 'custom',
          path: ['BOT_SERVICE_ACTIVE_KEY_ID'],
          message: 'active bot service credentials are required in production',
        });
      }

      if (!environment.TELEGRAM_BOT_TOKEN) {
        context.addIssue({
          code: 'custom',
          path: ['TELEGRAM_BOT_TOKEN'],
          message: 'Telegram bot token is required in production',
        });
      }

      if (!environment.SESSION_COOKIE_SECURE) {
        context.addIssue({
          code: 'custom',
          path: ['SESSION_COOKIE_SECURE'],
          message: 'must be true in production',
        });
      }

      if (
        environment.TELEGRAM_OIDC_REDIRECT_URI &&
        new URL(environment.TELEGRAM_OIDC_REDIRECT_URI).protocol !== 'https:'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['TELEGRAM_OIDC_REDIRECT_URI'],
          message: 'must use HTTPS in production',
        });
      }
    }
  });

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function validateEnvironment(rawEnvironment: Record<string, unknown>): AppEnvironment {
  const result = environmentSchema.safeParse(rawEnvironment);

  if (!result.success) {
    const summary = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');

    throw new Error(`Invalid environment configuration: ${summary}`);
  }

  return result.data;
}
