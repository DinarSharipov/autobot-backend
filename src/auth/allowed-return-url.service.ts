import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiHttpException } from '../common/http/api-http.exception.js';
import type { AppEnvironment } from '../config/environment.js';

@Injectable()
export class AllowedReturnUrlService {
  private readonly allowed: URL[];

  constructor(config: ConfigService<AppEnvironment, true>) {
    this.allowed = config
      .get('WEB_ALLOWED_RETURN_URLS', { infer: true })
      .map((value) => new URL(value));
  }

  validate(value: string): string {
    let candidate: URL;
    try {
      candidate = new URL(value);
    } catch {
      return this.reject();
    }

    candidate.hash = '';
    const accepted = this.allowed.some((allowed) => {
      if (candidate.origin !== allowed.origin) return false;
      if (allowed.pathname.endsWith('/')) {
        return candidate.pathname.startsWith(allowed.pathname);
      }
      return candidate.pathname === allowed.pathname;
    });

    return accepted ? candidate.toString() : this.reject();
  }

  private reject(): never {
    throw new ApiHttpException(
      HttpStatus.BAD_REQUEST,
      'INVALID_RETURN_URL',
      'The requested return URL is not allowed.',
    );
  }
}
