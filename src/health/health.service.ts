import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../infrastructure/redis/redis.service.js';

export type HealthResponse = {
  status: 'ok';
  service: 'autobot-api';
  version: string;
  timestamp: string;
};

export type ReadinessResponse = HealthResponse & {
  dependencies: {
    postgres: 'up';
    redis: 'up';
  };
};

@Injectable()
export class HealthService {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  live(): HealthResponse {
    return this.baseResponse();
  }

  async ready(): Promise<ReadinessResponse> {
    const checks = await Promise.allSettled([this.prisma.ping(), this.redis.ping()]);
    const unavailable = [
      ...(checks[0]?.status === 'rejected' ? ['postgres'] : []),
      ...(checks[1]?.status === 'rejected' ? ['redis'] : []),
    ];

    if (unavailable.length > 0) {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'A required service is temporarily unavailable.',
        details: { unavailable },
      });
    }

    return {
      ...this.baseResponse(),
      dependencies: {
        postgres: 'up',
        redis: 'up',
      },
    };
  }

  private baseResponse(): HealthResponse {
    return {
      status: 'ok',
      service: 'autobot-api',
      version: this.config.get('BUILD_SHA', { infer: true }),
      timestamp: new Date().toISOString(),
    };
  }
}
