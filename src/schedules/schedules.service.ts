import { HttpStatus, Injectable } from '@nestjs/common';

import {
  type Prisma,
  MisfirePolicy,
  PublicationStatus,
  ScheduleKind,
  ScheduleStatus,
} from '../generated/prisma/client.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { decodeCursor, encodeCursor } from '../common/http/pagination.js';
import { IdempotencyService } from '../common/idempotency/idempotency.service.js';
import { serializableTransaction } from '../common/database/serializable-transaction.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { UsageService } from '../subscriptions/usage.service.js';
import type { ScheduleCreateDto, ScheduleListQuery, ScheduleUpdateDto } from './schedules.dto.js';
import { toScheduleView, type ScheduleView } from './schedule.types.js';

@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly usage: UsageService,
  ) {}

  async list(userId: string, query: ScheduleListQuery) {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.postSchedule.findMany({
      where: {
        post: { userId },
        ...(query.status
          ? { status: query.status }
          : { status: { not: ScheduleStatus.CANCELLED } }),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const data = rows.slice(0, query.limit);
    const last = data.at(-1);
    return {
      data: data.map(toScheduleView),
      page: {
        nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
        hasMore: rows.length > query.limit,
      },
    };
  }

  async get(userId: string, scheduleId: string): Promise<ScheduleView> {
    return toScheduleView(await this.owned(userId, scheduleId));
  }

  create(userId: string, dto: ScheduleCreateDto, key: string): Promise<ScheduleView> {
    const input = this.normalized(dto);
    return this.idempotency.execute({
      userId,
      operation: 'schedules.create',
      key,
      requestHash: this.idempotency.digest(input),
      handler: async (transaction) => {
        await this.assertPost(userId, input.postId, transaction);
        const schedule = await transaction.postSchedule.create({
          data: {
            postId: input.postId,
            kind: ScheduleKind.ONCE,
            timezone: input.timezone,
            runAt: input.runAt,
            nextRunAt: input.runAt,
            misfirePolicy: input.misfirePolicy,
            misfireGraceSeconds: input.misfireGraceSeconds,
          },
        });
        await transaction.auditEvent.create({
          data: {
            userId,
            actorType: 'USER',
            actorId: userId,
            action: 'schedule.created',
            entityType: 'PostSchedule',
            entityId: schedule.id,
            metadata: { postId: input.postId, runAt: input.runAt.toISOString() },
          },
        });
        return toScheduleView(schedule);
      },
    });
  }

  async update(userId: string, scheduleId: string, version: number, dto: ScheduleUpdateDto) {
    if (Object.values(dto).every((value) => value === undefined)) {
      throw new ApiHttpException(
        HttpStatus.BAD_REQUEST,
        'EMPTY_UPDATE',
        'At least one schedule field must be provided.',
      );
    }
    const current = await this.owned(userId, scheduleId);
    if (current.kind !== ScheduleKind.ONCE || current.status !== ScheduleStatus.ACTIVE)
      this.notEditable();
    const data = this.updateData(dto);
    const result = await this.prisma.postSchedule.updateMany({
      where: { id: scheduleId, version, status: ScheduleStatus.ACTIVE, post: { userId } },
      data: { ...data, version: { increment: 1 }, nextRunAt: data.runAt ?? current.runAt },
    });
    if (!result.count) await this.throwMutationMiss(userId, scheduleId);
    return this.get(userId, scheduleId);
  }

  async cancel(userId: string, scheduleId: string, version: number): Promise<void> {
    const result = await this.prisma.postSchedule.updateMany({
      where: {
        id: scheduleId,
        version,
        status: { in: [ScheduleStatus.ACTIVE, ScheduleStatus.PAUSED] },
        post: { userId },
      },
      data: {
        status: ScheduleStatus.CANCELLED,
        cancelledAt: new Date(),
        nextRunAt: null,
        version: { increment: 1 },
      },
    });
    if (!result.count) await this.throwMutationMiss(userId, scheduleId);
  }

  pause(userId: string, scheduleId: string, version: number, key: string) {
    return this.transition(
      userId,
      scheduleId,
      version,
      key,
      ScheduleStatus.PAUSED,
      ScheduleStatus.ACTIVE,
      'schedule.paused',
    );
  }

  resume(userId: string, scheduleId: string, version: number, key: string) {
    return this.transition(
      userId,
      scheduleId,
      version,
      key,
      ScheduleStatus.ACTIVE,
      ScheduleStatus.PAUSED,
      'schedule.resumed',
    );
  }

  async materializeDue(now = new Date()): Promise<number> {
    const due = await this.prisma.postSchedule.findMany({
      where: { kind: ScheduleKind.ONCE, status: ScheduleStatus.ACTIVE, nextRunAt: { lte: now } },
      select: { id: true },
      orderBy: { nextRunAt: 'asc' },
      take: 50,
    });
    let count = 0;
    for (const schedule of due) if (await this.materializeOne(schedule.id, now)) count += 1;
    return count;
  }

  private async materializeOne(scheduleId: string, now: Date): Promise<boolean> {
    return serializableTransaction(this.prisma, async (transaction) => {
      const schedule = await transaction.postSchedule.findUnique({
        where: { id: scheduleId },
        include: { post: true },
      });
      if (
        !schedule ||
        schedule.kind !== ScheduleKind.ONCE ||
        schedule.status !== ScheduleStatus.ACTIVE ||
        !schedule.nextRunAt ||
        schedule.nextRunAt > now
      )
        return false;
      const scheduledFor = schedule.nextRunAt;
      const existing = await transaction.publication.findFirst({
        where: { scheduleId: schedule.id, scheduledFor },
      });
      if (existing) {
        await transaction.postSchedule.update({
          where: { id: schedule.id },
          data: { status: ScheduleStatus.COMPLETED, nextRunAt: null, lastEvaluatedAt: now },
        });
        return false;
      }
      const skip =
        schedule.misfirePolicy === MisfirePolicy.SKIP &&
        now.getTime() - scheduledFor.getTime() > schedule.misfireGraceSeconds * 1000;
      const publication = await transaction.publication.create({
        data: {
          postId: schedule.postId,
          scheduleId: schedule.id,
          scheduledFor,
          status: skip ? PublicationStatus.SKIPPED : PublicationStatus.PENDING,
          ...(skip ? { errorCode: 'MISSED_SCHEDULE' } : {}),
        },
      });
      if (!skip) {
        await this.usage.reserve({
          userId: schedule.post.userId,
          metric: 'TEXT_GENERATION',
          amount: 1,
          operationKey: `publication:${publication.id}:text-generation:reserve`,
          metadata: { publicationId: publication.id },
          database: transaction,
        });
        await transaction.outboxEvent.create({
          data: {
            aggregateType: 'Publication',
            aggregateId: publication.id,
            eventType: 'publication.generation.requested.v1',
            payload: { schemaVersion: 1, publicationId: publication.id },
          },
        });
      }
      await transaction.postSchedule.update({
        where: { id: schedule.id },
        data: {
          status: ScheduleStatus.COMPLETED,
          nextRunAt: null,
          lastEvaluatedAt: now,
          version: { increment: 1 },
        },
      });
      return true;
    });
  }

  private async transition(
    userId: string,
    scheduleId: string,
    version: number,
    key: string,
    target: ScheduleStatus,
    source: ScheduleStatus,
    action: string,
  ): Promise<ScheduleView> {
    return this.idempotency.execute({
      userId,
      operation: `${action}:${scheduleId}`,
      key,
      requestHash: this.idempotency.digest({ scheduleId, version }),
      handler: async (transaction) => {
        const result = await transaction.postSchedule.updateMany({
          where: { id: scheduleId, version, status: source, post: { userId } },
          data: {
            status: target,
            version: { increment: 1 },
            ...(target === ScheduleStatus.PAUSED
              ? { nextRunAt: null }
              : {
                  nextRunAt: {
                    set: (
                      await transaction.postSchedule.findUniqueOrThrow({
                        where: { id: scheduleId },
                      })
                    ).runAt,
                  },
                }),
          },
        });
        if (!result.count) await this.throwMutationMiss(userId, scheduleId, transaction);
        const schedule = await transaction.postSchedule.findUniqueOrThrow({
          where: { id: scheduleId },
        });
        await transaction.auditEvent.create({
          data: {
            userId,
            actorType: 'USER',
            actorId: userId,
            action,
            entityType: 'PostSchedule',
            entityId: scheduleId,
          },
        });
        return toScheduleView(schedule);
      },
    });
  }

  private normalized(dto: ScheduleCreateDto) {
    if (!this.validTimezone(dto.timezone))
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_TIMEZONE',
        'Timezone must be a valid IANA timezone.',
      );
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(dto.runAt))
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'RUN_AT_OFFSET_REQUIRED',
        'runAt must include a UTC offset.',
      );
    const runAt = new Date(dto.runAt);
    if (Number.isNaN(runAt.getTime()))
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_RUN_AT',
        'runAt must be a valid date-time.',
      );
    if (dto.misfirePolicy === MisfirePolicy.LATEST_ONLY)
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'MISFIRE_POLICY_NOT_SUPPORTED',
        'LATEST_ONLY is only supported for recurring schedules.',
      );
    return {
      postId: dto.postId,
      timezone: dto.timezone,
      runAt,
      misfirePolicy: dto.misfirePolicy,
      misfireGraceSeconds: dto.misfireGraceSeconds,
    };
  }

  private updateData(dto: ScheduleUpdateDto): Prisma.PostScheduleUpdateInput {
    if (dto.timezone !== undefined && !this.validTimezone(dto.timezone))
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_TIMEZONE',
        'Timezone must be a valid IANA timezone.',
      );
    if (dto.runAt !== undefined && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(dto.runAt))
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'RUN_AT_OFFSET_REQUIRED',
        'runAt must include a UTC offset.',
      );
    const runAt = dto.runAt === undefined ? undefined : new Date(dto.runAt);
    if (runAt && Number.isNaN(runAt.getTime()))
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_RUN_AT',
        'runAt must be a valid date-time.',
      );
    if (dto.misfirePolicy === MisfirePolicy.LATEST_ONLY)
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'MISFIRE_POLICY_NOT_SUPPORTED',
        'LATEST_ONLY is only supported for recurring schedules.',
      );
    return {
      ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
      ...(runAt ? { runAt } : {}),
      ...(dto.misfirePolicy !== undefined ? { misfirePolicy: dto.misfirePolicy } : {}),
      ...(dto.misfireGraceSeconds !== undefined
        ? { misfireGraceSeconds: dto.misfireGraceSeconds }
        : {}),
    };
  }

  private validTimezone(value: string): boolean {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }

  private async assertPost(
    userId: string,
    postId: string,
    database: PrismaService | Prisma.TransactionClient,
  ) {
    const post = await database.post.findFirst({ where: { id: postId, userId, status: 'ACTIVE' } });
    if (!post)
      throw new ApiHttpException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'POST_NOT_ACTIVE',
        'Schedule post must be active.',
      );
  }

  private async owned(userId: string, scheduleId: string) {
    const schedule = await this.prisma.postSchedule.findFirst({
      where: { id: scheduleId, post: { userId } },
    });
    if (!schedule)
      throw new ApiHttpException(HttpStatus.NOT_FOUND, 'SCHEDULE_NOT_FOUND', 'Schedule not found.');
    return schedule;
  }

  private async throwMutationMiss(
    userId: string,
    scheduleId: string,
    database: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<never> {
    const existing = await database.postSchedule.findFirst({
      where: { id: scheduleId, post: { userId } },
    });
    if (!existing)
      throw new ApiHttpException(HttpStatus.NOT_FOUND, 'SCHEDULE_NOT_FOUND', 'Schedule not found.');
    throw new ApiHttpException(
      HttpStatus.CONFLICT,
      'STALE_RESOURCE_VERSION',
      'The schedule version is stale.',
      { currentVersion: existing.version },
    );
  }

  private notEditable(): never {
    throw new ApiHttpException(
      HttpStatus.CONFLICT,
      'SCHEDULE_NOT_EDITABLE',
      'Only active one-time schedules can be edited.',
    );
  }
}
