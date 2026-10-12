import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AnyAuthenticatedGuard } from '../auth/any-authenticated.guard.js';
import { MutationAuthGuard } from '../auth/mutation-auth.guard.js';
import type { AuthPrincipal } from '../common/auth/auth-principal.js';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator.js';
import {
  parseIfMatch,
  requireIdempotencyKey,
  requirePrincipalUserId,
} from '../common/http/request-contracts.js';
import { ScheduleCreateDto, ScheduleListQuery, ScheduleUpdateDto } from './schedules.dto.js';
import { SchedulesService } from './schedules.service.js';

@ApiTags('Schedules')
@Controller({ path: 'schedules', version: '1' })
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  @UseGuards(AnyAuthenticatedGuard)
  @ApiOkResponse({ description: 'Owned schedule page.' })
  list(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Query() query: ScheduleListQuery,
  ) {
    return this.schedules.list(requirePrincipalUserId(principal), query);
  }

  @Post()
  @UseGuards(MutationAuthGuard)
  @ApiCreatedResponse({ description: 'Created one-time schedule.' })
  async create(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: ScheduleCreateDto,
  ) {
    return {
      data: await this.schedules.create(
        requirePrincipalUserId(principal),
        dto,
        requireIdempotencyKey(key),
      ),
    };
  }

  @Get(':scheduleId')
  @UseGuards(AnyAuthenticatedGuard)
  async get(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('scheduleId', ParseUUIDPipe) id: string,
  ) {
    return { data: await this.schedules.get(requirePrincipalUserId(principal), id) };
  }

  @Patch(':scheduleId')
  @UseGuards(MutationAuthGuard)
  async update(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('scheduleId', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: ScheduleUpdateDto,
  ) {
    return {
      data: await this.schedules.update(
        requirePrincipalUserId(principal),
        id,
        parseIfMatch(ifMatch),
        dto,
      ),
    };
  }

  @Delete(':scheduleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(MutationAuthGuard)
  @ApiNoContentResponse({ description: 'Schedule cancelled.' })
  async cancel(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('scheduleId', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<void> {
    await this.schedules.cancel(requirePrincipalUserId(principal), id, parseIfMatch(ifMatch));
  }

  @Post(':scheduleId/pause')
  @UseGuards(MutationAuthGuard)
  async pause(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('scheduleId', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.schedules.pause(
        requirePrincipalUserId(principal),
        id,
        parseIfMatch(ifMatch),
        requireIdempotencyKey(key),
      ),
    };
  }

  @Post(':scheduleId/resume')
  @UseGuards(MutationAuthGuard)
  async resume(
    @CurrentPrincipal() principal: AuthPrincipal | undefined,
    @Param('scheduleId', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return {
      data: await this.schedules.resume(
        requirePrincipalUserId(principal),
        id,
        parseIfMatch(ifMatch),
        requireIdempotencyKey(key),
      ),
    };
  }
}
