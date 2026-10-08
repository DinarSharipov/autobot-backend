import { ConsoleLogger, type LogLevel, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';

import type { AuthenticatedRequest } from './common/auth/auth-principal.js';
import { requestIdMiddleware } from './common/http/request-id.middleware.js';
import type { AppEnvironment } from './config/environment.js';

export type ConfigureApplicationOptions = {
  swagger?: boolean;
};

function captureRawBody(request: Request, _response: Response, buffer: Buffer): void {
  (request as AuthenticatedRequest).rawBody = Buffer.from(buffer);
}

function preventAuthResponseCaching(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (/^\/api\/v\d+\/auth(?:\/|$)/.test(request.path)) {
    response.setHeader('Cache-Control', 'no-store');
  }
  next();
}

function enabledLogLevels(configuredLevel: string | undefined): LogLevel[] {
  switch (configuredLevel) {
    case 'fatal':
      return ['fatal'];
    case 'error':
      return ['fatal', 'error'];
    case 'warn':
      return ['fatal', 'error', 'warn'];
    case 'debug':
      return ['fatal', 'error', 'warn', 'log', 'debug'];
    case 'verbose':
      return ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];
    default:
      return ['fatal', 'error', 'warn', 'log'];
  }
}

export function createApplicationLogger(): ConsoleLogger {
  return new ConsoleLogger({
    colors: false,
    json: true,
    logLevels: enabledLogLevels(process.env.LOG_LEVEL),
    prefix: 'autobot-api',
    timestamp: true,
  });
}

export function configureApplication(
  app: NestExpressApplication,
  options: ConfigureApplicationOptions = {},
): void {
  const config = app.get<ConfigService<AppEnvironment, true>>(ConfigService);
  const httpAdapter = app.getHttpAdapter().getInstance() as {
    set(name: string, value: number): void;
  };

  httpAdapter.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));
  const requestBodyLimit = config.get('REQUEST_BODY_LIMIT', { infer: true });
  app.use(json({ limit: requestBodyLimit, verify: captureRawBody }));
  app.use(urlencoded({ extended: true, limit: requestBodyLimit, verify: captureRawBody }));
  app.use(requestIdMiddleware);
  app.use(preventAuthResponseCaching);
  app.use(helmet());
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();

  const allowedOrigins = config.get('CORS_ALLOWED_ORIGINS', { infer: true });
  if (allowedOrigins.length > 0) {
    app.enableCors({
      origin: allowedOrigins,
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'If-Match',
        'Idempotency-Key',
        'X-CSRF-Token',
        'X-Request-Id',
      ],
      exposedHeaders: ['X-Request-Id'],
    });
  }

  if (options.swagger !== false) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Autobot Backend API')
      .setDescription('Central REST API for the Autobot Telegram bot and Web Admin.')
      .setVersion('0.1.0')
      .addCookieAuth('__Host-autobot_session', { type: 'apiKey', in: 'cookie' }, 'cookieSession')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Autobot-Signature' }, 'botSignature')
      .build();

    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig), {
      jsonDocumentUrl: 'api/docs-json',
    });
  }
}
