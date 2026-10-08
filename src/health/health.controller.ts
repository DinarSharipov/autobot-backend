import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HealthService, type HealthResponse, type ReadinessResponse } from './health.service.js';

@ApiTags('Health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Process liveness probe' })
  @ApiOkResponse({ description: 'The API process is responsive.' })
  live(): HealthResponse {
    return this.health.live();
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dependency readiness probe' })
  @ApiOkResponse({ description: 'PostgreSQL and Redis are available.' })
  ready(): Promise<ReadinessResponse> {
    return this.health.ready();
  }
}
