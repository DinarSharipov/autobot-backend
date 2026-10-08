import { chmod, mkdir } from 'node:fs/promises';
import { isAbsolute, parse, resolve } from 'node:path';

import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../../config/environment.js';

@Injectable()
export class ImageTempService implements OnModuleInit {
  readonly directory: string;

  constructor(config: ConfigService<AppEnvironment, true>) {
    const configured = config.get('IMAGE_TEMP_DIR', { infer: true });
    this.directory = isAbsolute(configured)
      ? resolve(configured)
      : resolve(process.cwd(), configured);

    if (
      this.directory === parse(this.directory).root ||
      this.directory === resolve(process.cwd())
    ) {
      throw new Error('IMAGE_TEMP_DIR must point to a dedicated child directory');
    }
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }
}
