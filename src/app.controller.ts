import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AppEnvironment } from './config/environment.js';

@ApiTags('System')
@Controller({ path: '', version: '1' })
export class AppController {
  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  @Get()
  @ApiOperation({ summary: 'Get API identity and deployed revision' })
  @ApiOkResponse({ description: 'API metadata.' })
  getApiInfo(): { data: { service: string; version: string } } {
    return {
      data: {
        service: 'autobot-api',
        version: this.config.get('BUILD_SHA', { infer: true }),
      },
    };
  }
}
