import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';

import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import type { PublicationJobPayload } from '../infrastructure/queue/job-contracts.js';
import { QUEUE_NAMES } from '../infrastructure/queue/queue.constants.js';
import { PublishingService } from './publishing.service.js';
import { MetricsService } from '../common/observability/metrics.service.js';

@Injectable()
export class PublicationDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublicationDispatcherService.name);
  private timer: NodeJS.Timeout | undefined;
  private dispatching = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    @InjectQueue(QUEUE_NAMES.publication) private readonly queue: Queue<PublicationJobPayload>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.dispatchDue(),
      this.config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true }),
    );
    void this.dispatchDue();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async dispatchDue(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const now = new Date();
      const publications = await this.prisma.publication.findMany({
        where: { OR: [{ status: 'READY' }, { status: 'RETRY_WAIT', nextAttemptAt: { lte: now } }] },
        select: { id: true, attemptCount: true, updatedAt: true },
        orderBy: { updatedAt: 'asc' },
        take: 50,
      });
      for (const publication of publications) {
        await this.queue.add(
          'publish-telegram',
          { schemaVersion: 1, publicationId: publication.id },
          {
            jobId: `publication-${publication.id}-${publication.updatedAt.getTime()}-${publication.attemptCount + 1}`,
            removeOnComplete: 1000,
            removeOnFail: 1000,
          },
        );
      }
    } catch (error) {
      this.logger.warn({
        event: 'publication_dispatch_failed',
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      this.dispatching = false;
    }
  }
}

@Processor(QUEUE_NAMES.publication, { concurrency: 2 })
export class PublicationProcessor extends WorkerHost {
  constructor(
    private readonly publishing: PublishingService,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  async process(job: Job<PublicationJobPayload>): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.publishing.publish(job.data.publicationId);
      this.metrics.increment('autobot_queue_jobs_total', {
        queue: QUEUE_NAMES.publication,
        status: 'completed',
      });
    } catch (error) {
      this.metrics.increment('autobot_queue_jobs_total', {
        queue: QUEUE_NAMES.publication,
        status: 'failed',
      });
      throw error;
    } finally {
      this.metrics.observe(
        'autobot_queue_job_duration_seconds',
        (performance.now() - startedAt) / 1000,
        { queue: QUEUE_NAMES.publication },
      );
    }
  }
}
