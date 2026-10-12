import { chmod, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, parse, resolve } from 'node:path';

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppEnvironment } from '../../config/environment.js';

@Injectable()
export class ImageTempService implements OnModuleInit, OnModuleDestroy {
  readonly directory: string;
  private readonly ttlSeconds: number;
  private readonly maxBytes: number;
  private readonly maxTotalBytes: number;
  private cleanupTimer: NodeJS.Timeout | undefined;

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
    this.ttlSeconds = config.get('IMAGE_TEMP_TTL_SECONDS', { infer: true });
    this.maxBytes = config.get('IMAGE_MAX_BYTES', { infer: true });
    this.maxTotalBytes = config.get('IMAGE_TEMP_MAX_TOTAL_BYTES', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await this.cleanupExpired();
    this.cleanupTimer = setInterval(
      () => void this.cleanupExpired(),
      Math.min(this.ttlSeconds * 1000, 60_000),
    );
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async createFile(bytes: Uint8Array, extension = '.png'): Promise<string> {
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxBytes) {
      throw new Error('Generated image exceeds the configured size limit.');
    }
    const entries = await readdir(this.directory, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        total += (await stat(resolve(this.directory, entry.name))).size;
      } catch {
        // A concurrent cleanup may remove an entry between readdir and stat.
      }
    }
    if (total + bytes.byteLength > this.maxTotalBytes) {
      throw new Error('Temporary image storage is full.');
    }
    const safeExtension = /^\.[a-z0-9]{1,8}$/i.test(extension) ? extension : '.png';
    const path = resolve(this.directory, `${Date.now()}-${randomUUID()}${safeExtension}`);
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    return path;
  }

  async remove(path: string): Promise<void> {
    if (!path.startsWith(`${this.directory}${process.platform === 'win32' ? '\\' : '/'}`)) return;
    await unlink(path).catch(() => undefined);
  }

  async cleanupExpired(now = Date.now()): Promise<number> {
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = resolve(this.directory, entry.name);
      try {
        const details = await stat(path);
        if (now - details.mtimeMs > this.ttlSeconds * 1000) {
          await unlink(path);
          removed += 1;
        }
      } catch {
        // Best-effort cleanup; the publication finally block handles active files.
      }
    }
    return removed;
  }
}
