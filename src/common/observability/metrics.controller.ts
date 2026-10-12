import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

import type { AppEnvironment } from '../../config/environment.js';
import { MetricsService } from './metrics.service.js';

@ApiExcludeController()
@Controller({ path: 'internal/metrics', version: '1' })
export class MetricsController {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly metrics: MetricsService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  get(@Req() request: Request): string {
    if (!this.config.get('METRICS_ENABLED', { infer: true })) {
      throw new NotFoundException();
    }

    const expected = this.config.get('METRICS_AUTH_TOKEN', { infer: true });
    const provided = request.header('x-metrics-token');
    if (!expected || !provided) throw new UnauthorizedException();

    const expectedBytes = Buffer.from(expected);
    const providedBytes = Buffer.from(provided);
    if (
      expectedBytes.length !== providedBytes.length ||
      !timingSafeEqual(expectedBytes, providedBytes)
    ) {
      throw new UnauthorizedException();
    }

    return this.metrics.renderPrometheus();
  }
}
