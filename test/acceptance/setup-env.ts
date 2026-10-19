import '../setup-env.js';

// Acceptance must be explicitly pointed at disposable services, never the default .env.
if (!process.env.AUTOBOT_TEST_DATABASE_URL || !process.env.AUTOBOT_TEST_REDIS_URL) {
  throw new Error('Acceptance requires AUTOBOT_TEST_DATABASE_URL and AUTOBOT_TEST_REDIS_URL');
}
for (const value of [process.env.AUTOBOT_TEST_DATABASE_URL, process.env.AUTOBOT_TEST_REDIS_URL]) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)) {
    throw new Error('Acceptance accepts only explicitly configured loopback services');
  }
}
if (!new URL(process.env.AUTOBOT_TEST_DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Acceptance database name must end with _test');
}
process.env.GPTUNNEL_API_KEY = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.QUEUE_PREFIX = 'autobot:acceptance';
process.env.REDIS_KEY_PREFIX = 'autobot:acceptance';
process.env.IMAGE_TEMP_DIR = '.tmp/acceptance-images';

process.env.BOT_SERVICE_CLOCK_SKEW_SECONDS = '60';
process.env.BOT_SERVICE_NONCE_TTL_SECONDS = '300';
