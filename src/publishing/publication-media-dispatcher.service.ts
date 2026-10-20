import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { QUEUE_NAMES } from '../infrastructure/queue/queue.constants.js';
import { PublicationMediaService } from './publication-media.service.js';
export type MediaJob = { schemaVersion: 1; mediaId: string };
@Injectable()
export class PublicationMediaDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublicationMediaDispatcher.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    @InjectQueue(QUEUE_NAMES.media) private readonly queue: Queue<MediaJob>,
  ) {}
  onModuleInit() {
    this.timer = setInterval(
      () => void this.dispatch(),
      this.config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true }),
    );
    void this.dispatch();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async dispatch() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.prisma.publicationMedia.findMany({
        where: {
          OR: [
            { generationStatus: 'QUEUED', nextAttemptAt: { lte: new Date() } },
            {
              generationStatus: { in: ['RUNNING', 'UPLOADING'] },
              leaseExpiresAt: { lte: new Date() },
            },
          ],
        },
        orderBy: { updatedAt: 'asc' },
        take: 50,
      });
      for (const row of rows)
        await this.queue.add(
          'generate-media',
          { schemaVersion: 1, mediaId: row.id },
          {
            jobId: `media-${row.id}-${row.updatedAt.getTime()}-${row.generationAttempts}`,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: 100,
          },
        );
    } catch {
      this.logger.warn({ event: 'media_dispatch_failed', code: 'MEDIA_QUEUE_UNAVAILABLE' });
    } finally {
      this.running = false;
    }
  }
}
@Processor(QUEUE_NAMES.media, { concurrency: 2 })
export class PublicationMediaProcessor extends WorkerHost {
  constructor(private readonly media: PublicationMediaService) {
    super();
  }
  async process(job: Job<MediaJob>) {
    if (job.data.schemaVersion === 1) await this.media.process(job.data.mediaId);
  }
}
