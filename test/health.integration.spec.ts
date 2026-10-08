import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApplication } from '../src/bootstrap.js';

describe('health endpoints', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleReference = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleReference.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApplication(app, { swagger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports process liveness', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);

    expect(response.body).toMatchObject({ status: 'ok', service: 'autobot-api' });
    expect(response.headers['x-request-id']).toBeTypeOf('string');
  });

  it('proves PostgreSQL and Redis readiness', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      dependencies: { postgres: 'up', redis: 'up' },
    });
  });
});
