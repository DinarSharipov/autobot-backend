import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiHttpException } from '../common/http/api-http.exception.js';
import type { AppEnvironment } from '../config/environment.js';
import { RedisService } from '../infrastructure/redis/redis.service.js';
import { sha256Hex } from './crypto.js';

@Injectable()
export class AuthRateLimitService {
  private readonly maximum: number;
  private readonly windowSeconds: number;

  constructor(
    config: ConfigService<AppEnvironment, true>,
    private readonly redis: RedisService,
  ) {
    this.maximum = config.get('AUTH_RATE_LIMIT_MAX', { infer: true });
    this.windowSeconds = config.get('AUTH_RATE_LIMIT_WINDOW_SECONDS', { infer: true });
  }

  async assertAllowed(action: string, clientAddress: string): Promise<void> {
    const key = `auth-rate:${action}:${sha256Hex(clientAddress)}`;
    let count: number;
    try {
      count = await this.redis.incrementFixedWindow(key, this.windowSeconds);
    } catch {
      throw new ApiHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'AUTH_DEPENDENCY_UNAVAILABLE',
        'Authentication is temporarily unavailable.',
      );
    }
    if (count > this.maximum) {
      throw new ApiHttpException(
        HttpStatus.TOO_MANY_REQUESTS,
        'AUTH_RATE_LIMITED',
        'Too many authentication attempts. Try again later.',
      );
    }
  }
}
