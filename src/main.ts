import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import { configureApplication, createApplicationLogger } from './bootstrap.js';
import type { AppEnvironment } from './config/environment.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    bufferLogs: true,
    logger: createApplicationLogger(),
  });
  const config = app.get<ConfigService<AppEnvironment, true>>(ConfigService);

  configureApplication(app);
  await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
}

void bootstrap().catch(() => {
  process.stderr.write('Autobot API failed to start. Check configuration and dependencies.\n');
  process.exitCode = 1;
});
