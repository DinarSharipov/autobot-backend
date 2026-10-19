import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://autobot:autobot@localhost:5432/autobot_test';
process.env.REDIS_URL = 'redis://localhost:6380/15';

describe('application module graph', () => {
  it('resolves every provider before integration tests start', async () => {
    const [{ AppModule }, { RedisService }] = await Promise.all([
      import('./app.module.js'),
      import('./infrastructure/redis/redis.service.js'),
    ]);
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisService)
      .useValue({})
      .compile();

    expect(moduleReference).toBeDefined();
    await moduleReference.close();
  });
});
