import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://autobot:autobot@localhost:5432/autobot_test';
process.env.REDIS_URL = 'redis://localhost:6380/15';

import { AppModule } from './app.module.js';
import { RedisService } from './infrastructure/redis/redis.service.js';

describe('application module graph', () => {
  it('resolves every provider before integration tests start', async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisService)
      .useValue({})
      .compile();

    expect(moduleReference).toBeDefined();
    await moduleReference.close();
  });
});
