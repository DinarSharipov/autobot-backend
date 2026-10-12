import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { SchedulesService } from './schedules.service.js';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly schedules: SchedulesService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.tick(),
      this.config.get('SCHEDULER_POLL_INTERVAL_MS', { infer: true }),
    );
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.schedules.materializeDue();
    } catch (error) {
      this.logger.warn({
        event: 'schedule_materialization_failed',
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      this.running = false;
    }
  }
}
