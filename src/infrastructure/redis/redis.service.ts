import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import type { AppEnvironment } from '../../config/environment.js';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(config: ConfigService<AppEnvironment, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      connectionName: 'autobot-api',
      connectTimeout: 5000,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      keyPrefix: `${config.get('REDIS_KEY_PREFIX', { infer: true })}:`,
    });

    this.client.on('error', (error: Error) => {
      this.logger.warn({ event: 'redis_connection_error', error: error.name });
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status !== 'end') {
      await this.client.quit();
    }
  }

  async ping(): Promise<void> {
    const response = await this.client.ping();
    if (response !== 'PONG') {
      throw new Error('Unexpected Redis ping response');
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async consumeJson<T>(key: string): Promise<T | null> {
    const value = await this.client.getdel(key);
    if (value === null) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async setIfAbsent(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.client.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async incrementFixedWindow(key: string, ttlSeconds: number): Promise<number> {
    const result = await this.client.eval(
      `
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
        end
        return count
      `,
      1,
      key,
      ttlSeconds,
    );

    return Number(result);
  }
}
