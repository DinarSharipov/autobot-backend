import { createHash } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import type { BrowserPrincipal } from '../common/auth/auth-principal.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import type { UserWithTelegram } from '../users/user.types.js';
import { deriveCsrfToken, randomOpaqueSecret, safeEqual, sha256Hex } from './crypto.js';

export type AuthenticatedSession = {
  principal: BrowserPrincipal;
  user: UserWithTelegram;
  expiresAt: Date;
};

@Injectable()
export class SessionService {
  private readonly cookieName: string;
  private readonly absoluteTtlSeconds: number;
  private readonly idleTtlSeconds: number;
  private readonly cookieSecure: boolean;
  private readonly cookieSameSite: 'lax' | 'none';

  constructor(
    config: ConfigService<AppEnvironment, true>,
    private readonly prisma: PrismaService,
  ) {
    this.cookieName = config.get('SESSION_COOKIE_NAME', { infer: true });
    this.absoluteTtlSeconds = config.get('SESSION_ABSOLUTE_TTL_SECONDS', { infer: true });
    this.idleTtlSeconds = config.get('SESSION_IDLE_TTL_SECONDS', { infer: true });
    this.cookieSecure = config.get('SESSION_COOKIE_SECURE', { infer: true });
    this.cookieSameSite = config.get('SESSION_COOKIE_SAME_SITE', { infer: true });
  }

  async create(
    userId: string,
    request: Request,
    response: Response,
  ): Promise<AuthenticatedSession> {
    const previousSecret = this.readCookie(request);
    if (previousSecret) {
      await this.revokeBySecret(previousSecret, 'ROTATED');
    }

    const secret = randomOpaqueSecret();
    const csrfToken = deriveCsrfToken(secret);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.absoluteTtlSeconds * 1000);
    const idleExpiresAt = new Date(
      Math.min(expiresAt.getTime(), now.getTime() + this.idleTtlSeconds * 1000),
    );
    const session = await this.prisma.session.create({
      data: {
        userId,
        secretHash: sha256Hex(secret),
        csrfTokenHash: sha256Hex(csrfToken),
        userAgentHash: this.optionalHash(request.get('user-agent')),
        ipPrefixHash: this.optionalHash(this.ipPrefix(request.ip)),
        idleExpiresAt,
        expiresAt,
      },
      include: { user: { include: { telegramAccount: true } } },
    });

    response.cookie(this.cookieName, secret, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: this.cookieSameSite,
      path: '/',
      maxAge: this.absoluteTtlSeconds * 1000,
    });

    return {
      principal: { kind: 'browser', userId: session.userId, sessionId: session.id },
      user: session.user,
      expiresAt: session.expiresAt,
    };
  }

  async authenticate(request: Request): Promise<AuthenticatedSession> {
    const secret = this.readCookie(request);
    if (!secret) this.unauthorized();

    const session = await this.prisma.session.findUnique({
      where: { secretHash: sha256Hex(secret) },
      include: { user: { include: { telegramAccount: true } } },
    });
    const now = new Date();

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.idleExpiresAt <= now ||
      session.user.status !== 'ACTIVE'
    ) {
      if (session && !session.revokedAt) {
        await this.prisma.session.update({
          where: { id: session.id },
          data: { revokedAt: now, revokeReason: 'EXPIRED_OR_USER_INACTIVE' },
        });
      }
      this.unauthorized();
    }

    const idleExpiresAt = new Date(
      Math.min(session.expiresAt.getTime(), now.getTime() + this.idleTtlSeconds * 1000),
    );
    await this.prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: now, idleExpiresAt },
    });

    return {
      principal: { kind: 'browser', userId: session.userId, sessionId: session.id },
      user: session.user,
      expiresAt: session.expiresAt,
    };
  }

  csrfToken(request: Request): string {
    const secret = this.readCookie(request);
    if (!secret) this.unauthorized();
    return deriveCsrfToken(secret);
  }

  async validateCsrf(sessionId: string, token: string | undefined): Promise<void> {
    if (!token) this.invalidCsrf();
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { csrfTokenHash: true, revokedAt: true },
    });

    if (!session || session.revokedAt || !safeEqual(session.csrfTokenHash, sha256Hex(token))) {
      this.invalidCsrf();
    }
  }

  async logout(request: Request, response: Response): Promise<void> {
    const secret = this.readCookie(request);
    if (secret) await this.revokeBySecret(secret, 'LOGOUT');
    this.clearCookie(response);
  }

  clearCookie(response: Response): void {
    response.clearCookie(this.cookieName, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: this.cookieSameSite,
      path: '/',
    });
  }

  private async revokeBySecret(secret: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { secretHash: sha256Hex(secret), revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  private readCookie(request: Request): string | undefined {
    const cookies: unknown = request.cookies;
    if (!cookies || typeof cookies !== 'object') return undefined;
    const value = (cookies as Record<string, unknown>)[this.cookieName];
    return typeof value === 'string' && value.length >= 32 ? value : undefined;
  }

  private optionalHash(value: string | undefined): string | null {
    return value ? createHash('sha256').update(value).digest('hex') : null;
  }

  private ipPrefix(ip: string | undefined): string | undefined {
    if (!ip) return undefined;
    if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.');
    if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
    return ip;
  }

  private unauthorized(): never {
    throw new ApiHttpException(
      HttpStatus.UNAUTHORIZED,
      'SESSION_REQUIRED',
      'An active browser session is required.',
    );
  }

  private invalidCsrf(): never {
    throw new ApiHttpException(
      HttpStatus.FORBIDDEN,
      'INVALID_CSRF_TOKEN',
      'A valid CSRF token is required.',
    );
  }
}
