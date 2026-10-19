process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.API_PUBLIC_URL = 'http://localhost:3001';
process.env.DATABASE_URL =
  process.env.AUTOBOT_TEST_DATABASE_URL ??
  'postgresql://autobot:autobot@localhost:5432/autobot_test?schema=public&connect_timeout=5';
process.env.REDIS_URL = process.env.AUTOBOT_TEST_REDIS_URL ?? 'redis://localhost:6380/15';
process.env.REDIS_KEY_PREFIX = 'autobot:test';
process.env.QUEUE_PREFIX = 'autobot:test';
process.env.IMAGE_TEMP_DIR = '.tmp/test-images';
process.env.WEB_ALLOWED_RETURN_URLS = 'https://web.example.test/app/';
process.env.CORS_ALLOWED_ORIGINS = 'https://web.example.test';
process.env.TELEGRAM_OIDC_CLIENT_ID = '123456789';
process.env.TELEGRAM_OIDC_CLIENT_SECRET = 'test-oidc-client-secret';
process.env.TELEGRAM_OIDC_REDIRECT_URI = 'https://api.example.test/api/v1/auth/telegram/callback';
process.env.SESSION_COOKIE_SECURE = 'true';
process.env.BOT_SERVICE_ACTIVE_KEY_ID = 'test-key';
process.env.BOT_SERVICE_ACTIVE_SECRET = 'test-secret-32-bytes-long-1234567890';
process.env.BOT_SERVICE_PREVIOUS_KEY_ID = 'previous-key';
process.env.BOT_SERVICE_PREVIOUS_SECRET = 'previous-secret-32-bytes-long-123456';
process.env.AUTH_RATE_LIMIT_MAX = '1000';

// Keep provider fixtures deterministic and never inherit a real key/model from local .env.
process.env.GPTUNNEL_API_KEY = 'test-gptunnel-secret';
process.env.GPTUNNEL_USE_WALLET_BALANCE = 'false';
process.env.GPTUNNEL_IMAGE_PARAMS = '{}';
process.env.AI_TEXT_MODEL = 'gpt-4o-mini';
process.env.AI_IMAGE_MODEL = 'gpt-image';
process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
