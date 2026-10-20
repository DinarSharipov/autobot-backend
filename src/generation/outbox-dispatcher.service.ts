import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';

import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { type PostGenerationJobPayload } from '../infrastructure/queue/job-contracts.js';
import { QUEUE_NAMES } from '../infrastructure/queue/queue.constants.js';
import { GenerationService } from './generation.service.js';
import { TextGenerationProviderError } from './text-generation.adapter.js';
import { MetricsService } from '../common/observability/metrics.service.js';

@Injectable()
export class OutboxDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private timer: NodeJS.Timeout | undefined;
  private dispatching = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    @InjectQueue(QUEUE_NAMES.postGeneration)
    private readonly generationQueue: Queue<PostGenerationJobPayload>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.dispatchPending(),
      this.config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true }),
    );
    void this.dispatchPending();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async dispatchPending(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await this.prisma.outboxEvent.updateMany({
        where: {
          status: 'PROCESSING',
          eventType: 'publication.generation.requested.v1',
          lockedAt: { lt: new Date(Date.now() - 60_000) },
        },
        data: { status: 'PENDING', lockedAt: null },
      });
      const events = await this.prisma.outboxEvent.findMany({
        where: {
          status: 'PENDING',
          availableAt: { lte: new Date() },
          eventType: 'publication.generation.requested.v1',
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      for (const event of events) await this.dispatch(event.id);
      // Reconciliation has its own bounded batch so history cannot starve new/resumed work.
      const published = await this.prisma.outboxEvent.findMany({
        where: {
          status: 'PUBLISHED',
          availableAt: { lte: new Date() },
          eventType: 'publication.generation.requested.v1',
        },
        orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
        take: 50,
      });
      for (const event of published) await this.dispatch(event.id);
    } catch (error) {
      this.logger.warn({
        event: 'outbox_poll_failed',
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      this.dispatching = false;
    }
  }

  private async dispatch(eventId: string): Promise<void> {
    const current = await this.prisma.outboxEvent.findUnique({ where: { id: eventId } });
    if (!current) return;
    if (current.status === 'PUBLISHED') {
      await this.reconcilePublished(current);
      // Rotate checked events: later published events must also get recovery checks.
      await this.prisma.outboxEvent.updateMany({
        where: { id: current.id, status: 'PUBLISHED' },
        data: { availableAt: new Date() },
      });
      return;
    }
    const claimed = await this.prisma.outboxEvent.updateMany({
      where: { id: eventId, status: 'PENDING', availableAt: { lte: new Date() } },
      data: { status: 'PROCESSING', lockedAt: new Date(), attempts: { increment: 1 } },
    });
    if (!claimed.count) return;
    // A test reset or an operator cleanup can remove a claimed event between the
    // atomic claim and this read. Treat that as already handled instead of
    // leaking an unhandled rejection from the polling loop.
    const event = await this.prisma.outboxEvent.findUnique({ where: { id: eventId } });
    if (!event) return;
    const payload = event.payload as { schemaVersion?: unknown; publicationId?: unknown };
    if (payload.schemaVersion !== 1 || typeof payload.publicationId !== 'string') {
      await this.prisma.outboxEvent.updateMany({
        where: { id: eventId },
        data: { status: 'FAILED', lastErrorCode: 'INVALID_OUTBOX_PAYLOAD' },
      });
      return;
    }
    try {
      await this.generationQueue.add(
        'generate-post',
        { schemaVersion: 1, publicationId: payload.publicationId },
        {
          jobId: `generation-${event.id}`,
          attempts: this.config.get('PUBLICATION_MAX_ATTEMPTS', { infer: true }),
          backoff: { type: 'gptunnel', delay: 1000 },
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      );
      await this.prisma.outboxEvent.updateMany({
        where: { id: eventId },
        data: { status: 'PUBLISHED', processedAt: new Date() },
      });
    } catch (error) {
      await this.prisma.outboxEvent.updateMany({
        where: { id: eventId },
        data: {
          status: 'PENDING',
          availableAt: new Date(Date.now() + 5000),
          lastErrorCode: 'QUEUE_UNAVAILABLE',
        },
      });
      this.logger.warn({
        event: 'outbox_dispatch_failed',
        outboxEventId: eventId,
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  private async reconcilePublished(event: { id: string; payload: unknown }): Promise<void> {
    const payload = event.payload as { schemaVersion?: unknown; publicationId?: unknown };
    if (payload.schemaVersion !== 1 || typeof payload.publicationId !== 'string') return;
    const publication = await this.prisma.publication.findUnique({
      where: { id: payload.publicationId },
      select: { status: true, fundingStatus: true },
    });
    if (
      !publication ||
      publication.fundingStatus === 'BLOCKED_FUNDS' ||
      (publication.status !== 'PENDING' && publication.status !== 'GENERATING')
    )
      return;
    const jobId = `generation-${event.id}`;
    if (await this.generationQueue.getJob(jobId)) return;
    await this.generationQueue.add(
      'generate-post',
      { schemaVersion: 1, publicationId: payload.publicationId },
      {
        jobId,
        attempts: this.config.get('PUBLICATION_MAX_ATTEMPTS', { infer: true }),
        backoff: { type: 'gptunnel', delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
  }
}

@Processor(QUEUE_NAMES.postGeneration, {
  concurrency: 2,
  settings: {
    backoffStrategy: (attemptsMade: number, _type?: string, error?: Error) =>
      Math.max(
        Math.min(3_600_000, 1000 * 2 ** Math.max(0, attemptsMade - 1)),
        error instanceof TextGenerationProviderError ? (error.retryAfterSeconds ?? 0) * 1000 : 0,
      ),
  },
})
export class PostGenerationProcessor extends WorkerHost {
  constructor(
    private readonly generation: GenerationService,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  async process(job: Job<PostGenerationJobPayload>): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.generation.generate(
        job.data.publicationId,
        job.attemptsMade > 0 || job.stalledCounter > 0,
      );
      this.metrics.increment('autobot_queue_jobs_total', {
        queue: QUEUE_NAMES.postGeneration,
        status: 'completed',
      });
    } catch (error) {
      if (
        error instanceof TextGenerationProviderError &&
        error.retryable &&
        job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
      ) {
        await this.generation.failAfterRetries(job.data.publicationId, error.code);
        this.metrics.increment('autobot_queue_jobs_total', {
          queue: QUEUE_NAMES.postGeneration,
          status: 'terminal_failure',
        });
        return;
      }
      this.metrics.increment('autobot_queue_jobs_total', {
        queue: QUEUE_NAMES.postGeneration,
        status: 'failed',
      });
      throw error;
    } finally {
      this.metrics.observe(
        'autobot_queue_job_duration_seconds',
        (performance.now() - startedAt) / 1000,
        { queue: QUEUE_NAMES.postGeneration },
      );
    }
  }
}
