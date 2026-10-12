import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { MetricsService } from '../../common/observability/metrics.service.js';
import { type PostGenerationJobPayload, type PublicationJobPayload } from './job-contracts.js';
import { QUEUE_NAMES } from './queue.constants.js';

const SAMPLE_INTERVAL_MS = 15_000;

type QueueSnapshot = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
};

@Injectable()
export class QueueMetricsService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly metrics: MetricsService,
    @InjectQueue(QUEUE_NAMES.postGeneration)
    private readonly generationQueue: Queue<PostGenerationJobPayload>,
    @InjectQueue(QUEUE_NAMES.publication)
    private readonly publicationQueue: Queue<PublicationJobPayload>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref();
    void this.sample();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sample(): Promise<void> {
    await Promise.all([
      this.sampleQueue('post_generation', this.generationQueue),
      this.sampleQueue('publication', this.publicationQueue),
    ]);
  }

  private async sampleQueue<T>(name: string, queue: Queue<T>): Promise<void> {
    try {
      const snapshot = (await queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'completed',
      )) as QueueSnapshot;
      for (const [state, value] of Object.entries(snapshot)) {
        this.metrics.setGauge('autobot_queue_jobs', value, { queue: name, state });
      }
    } catch {
      this.metrics.increment('autobot_queue_observation_errors_total', { queue: name });
    }
  }
}
