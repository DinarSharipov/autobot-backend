import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it } from 'vitest';
import { validateEnvironment } from '../../src/config/environment.js';
import { ImageTempService } from '../../src/infrastructure/image-temp/image-temp.service.js';
import {
  nextOccurrence,
  parseRecurrence,
  zonedParts,
  zonedToUtc,
} from '../../src/schedules/recurrence.js';

function dates(expression: string, anchorText: string, count: number, timezone = 'UTC') {
  const anchor = new Date(anchorText),
    rule = parseRecurrence(expression);
  let after = anchor;
  const result: Date[] = [];
  for (let i = 0; i < count; i++) {
    const next = nextOccurrence({ after, anchor, rule, timezone });
    if (!next) break;
    result.push(next);
    after = next;
  }
  return result.map((x) => x.toISOString());
}
describe('Calendar independent catalogue expectations', () => {
  it('TC-RRU-001 five DAILY instants', () =>
    expect(dates('FREQ=DAILY', '2026-01-01T10:00:00Z', 5)).toEqual(
      [2, 3, 4, 5, 6].map((d) => `2026-01-0${d}T10:00:00.000Z`),
    ));
  it('TC-RRU-002 WEEKLY starts midweek without missing first allowed day', () =>
    expect(dates('FREQ=WEEKLY;BYDAY=MO,WE,FR', '2026-10-14T10:00:00Z', 5)).toEqual(
      ['2026-10-16', '2026-10-19', '2026-10-21', '2026-10-23', '2026-10-26'].map(
        (x) => x + 'T10:00:00.000Z',
      ),
    ));
  it('TC-RRU-003 monthly on fifteenth', () =>
    expect(dates('FREQ=MONTHLY;BYMONTHDAY=15', '2026-01-15T10:00:00Z', 3)).toEqual(
      ['2026-02-15', '2026-03-15', '2026-04-15'].map((x) => x + 'T10:00:00.000Z'),
    ));
  it.each([
    ['DAILY', '2026-01-03', '2026-01-05'],
    ['WEEKLY', '2026-01-15', '2026-01-29'],
    ['MONTHLY;BYMONTHDAY=1', '2026-03-01', '2026-05-01'],
  ])('TC-RRU-005 interval two for %s', (rule, first, second) =>
    expect(dates(`FREQ=${rule};INTERVAL=2`, '2026-01-01T10:00:00Z', 2)).toEqual(
      [first, second].map((x) => x + 'T10:00:00.000Z'),
    ),
  );
  it('TC-RRU-006 DAILY step and weekday filter combine', () =>
    expect(dates('FREQ=DAILY;INTERVAL=2;BYDAY=MO,WE,FR', '2026-10-12T10:00:00Z', 4)).toEqual(
      ['2026-10-14', '2026-10-16', '2026-10-26', '2026-10-28'].map((x) => x + 'T10:00:00.000Z'),
    ));
  it('TC-RRU-007 monthly BYDAY includes every matching weekday in selected month', () =>
    expect(dates('FREQ=MONTHLY;BYDAY=MO', '2026-01-01T10:00:00Z', 4)).toEqual(
      [5, 12, 19, 26].map((d) => `2026-01-${String(d).padStart(2, '0')}T10:00:00.000Z`),
    ));
  it('TC-RRU-008 day 31 skips short months without normalization', () =>
    expect(dates('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-31T10:00:00Z', 6)).toEqual(
      ['2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31', '2026-10-31', '2026-12-31'].map(
        (x) => x + 'T10:00:00.000Z',
      ),
    ));
  it.each([
    ['2027-01-29', '2027-03-29'],
    ['2028-01-29', '2028-02-29'],
  ])('TC-RRU-009 leap month after %s', (anchor, expected) =>
    expect(dates('FREQ=MONTHLY;BYMONTHDAY=29', anchor + 'T10:00:00Z', 1)).toEqual([
      expected + 'T10:00:00.000Z',
    ]),
  );
  it.each(['HOURLY', 'MINUTELY', 'YEARLY'])('TC-RRU-013 unsupported frequency %s', (freq) =>
    expect(() => parseRecurrence('FREQ=' + freq)).toThrow(),
  );
  it.each(['BYHOUR=10', 'BYMINUTE=15', 'BYSETPOS=1', 'WKST=MO'])(
    'TC-RRU-014 unsupported component %s',
    (part) => expect(() => parseRecurrence('FREQ=DAILY;' + part)).toThrow(),
  );
  it('TC-RRU-012 COUNT and UNTIL cannot coexist', () =>
    expect(() => parseRecurrence('FREQ=DAILY;COUNT=2;UNTIL=20300101')).toThrow());
  for (const part of ['INTERVAL', 'COUNT'])
    it.each(['0', '-1', '1.5', '10000', '10001', 'NaN'])(
      'TC-RRU-015 ' + part + '=%s bounds',
      (value) => {
        if (value === '10000')
          expect(
            parseRecurrence(`FREQ=DAILY;${part}=${value}`)[part === 'COUNT' ? 'count' : 'interval'],
          ).toBe(10000);
        else expect(() => parseRecurrence(`FREQ=DAILY;${part}=${value}`)).toThrow();
      },
    );
  it.each(['XX', '1MO', 'MO,', ',MO'])('TC-RRU-016 invalid BYDAY %s', (value) =>
    expect(() => parseRecurrence('FREQ=WEEKLY;BYDAY=' + value)).toThrow(),
  );
  it.each(['0', '-1', '32', '1.5'])('TC-RRU-017 invalid BYMONTHDAY %s', (value) =>
    expect(() => parseRecurrence('FREQ=MONTHLY;BYMONTHDAY=' + value)).toThrow(),
  );
  it.each(['FREQ=DAILY;FREQ=WEEKLY', 'FREQ=DAILY;COUNT=1;COUNT=2'])(
    'TC-RRU-018 repeated component %s',
    (value) => expect(() => parseRecurrence(value)).toThrow(),
  );
  it.each(['rrule:freq=daily;interval=2', ' RRULE: FREQ = DAILY ; INTERVAL = 2 '])(
    'TC-RRU-019 normalized syntax %s',
    (value) => expect(parseRecurrence(value)).toEqual(parseRecurrence('FREQ=DAILY;INTERVAL=2')),
  );
  it.each(['FREQ=WEEKLY;BYMONTHDAY=15', 'FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=15'])(
    'TC-RRU-020 incompatible filters %s',
    (value) => expect(() => parseRecurrence(value)).toThrow(),
  );
  it('TC-RRU-027 horizon scan is bounded and yields explicit no-date', () =>
    expect(dates('FREQ=DAILY;INTERVAL=10000', '2026-01-01T10:00:00Z', 1)).toEqual([]));
  it.each(['2026-01-31', '2026-12-31'])('TC-TZ-001 Moscow boundary %s keeps 10am local', (date) => {
    const result = dates('FREQ=DAILY', date + 'T07:00:00Z', 3, 'Europe/Moscow');
    for (const value of result) expect(zonedParts(new Date(value), 'Europe/Moscow').hour).toBe(10);
  });
  it('TC-TZ-002 New York spring gap selects first valid instant after gap', () =>
    expect(
      zonedToUtc(
        { year: 2027, month: 3, day: 14, hour: 2, minute: 30, second: 0 },
        'America/New_York',
      ).toISOString(),
    ).toBe('2027-03-14T07:00:00.000Z'));
  // Materialization for overlap is separately covered by schedule tests; this variant checks conversion only.
  it('calendar-partial NY overlap selects earlier instant', () =>
    expect(
      zonedToUtc(
        { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
        'America/New_York',
      ).toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z'));
  it.each([
    ['Europe/Berlin', '2026-03-29', 2, 30, '2026-03-29T01:00:00.000Z'],
    ['Europe/Berlin', '2026-10-25', 2, 30, '2026-10-25T00:30:00.000Z'],
  ])('TC-TZ-004 European transition %s %s', (zone, date, hour, minute, expected) => {
    const [year, month, day] = date.split('-').map(Number);
    expect(
      zonedToUtc(
        { year: year!, month: month!, day: day!, hour, minute, second: 0 },
        zone,
      ).toISOString(),
    ).toBe(expected);
  });
  it.each([
    ['2026-04-04T00:00:00Z', '2026-04-05T01:00:00.000Z'],
    ['2026-10-03T00:00:00Z', '2026-10-03T23:00:00.000Z'],
  ])('TC-TZ-005 Sydney preserves 10am after %s', (anchor, expected) =>
    expect(dates('FREQ=DAILY', anchor, 1, 'Australia/Sydney')).toEqual([expected]),
  );
  it.each([
    ['2026-04-04T00:00:00Z', '2026-04-05T00:30:00.000Z'],
    ['2026-10-03T00:00:00Z', '2026-10-03T23:30:00.000Z'],
  ])('TC-TZ-006 Lord Howe half-hour transition %s', (anchor, expected) =>
    expect(dates('FREQ=DAILY', anchor, 1, 'Australia/Lord_Howe')).toEqual([expected]),
  );
  it.each([
    ['Asia/Kathmandu', '2026-01-01T04:15:00Z'],
    ['Australia/Eucla', '2026-01-01T01:15:00Z'],
  ])('TC-TZ-007 fractional offset %s preserves local hour', (zone, anchor) => {
    const result = dates('FREQ=DAILY', anchor, 3, zone);
    for (const v of result)
      expect(zonedParts(new Date(v), zone)).toMatchObject({ hour: 10, minute: 0 });
  });
  it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'])(
    'TC-TZ-008 extreme zone %s preserves next local day and weekday',
    (zone) => {
      const anchor = zonedToUtc(
        { year: 2026, month: 12, day: 31, hour: 10, minute: 0, second: 0 },
        zone,
      );
      const result = dates('FREQ=DAILY', anchor.toISOString(), 1, zone);
      expect(zonedParts(new Date(result[0]!), zone)).toMatchObject({
        year: 2027,
        month: 1,
        day: 1,
        hour: 10,
      });
    },
  );
  it.each([
    ['2027-02-28', '2027-03-01'],
    ['2028-02-28', '2028-02-29'],
    ['2028-02-29', '2028-03-01'],
  ])('TC-TZ-010 calendar transition %s', (anchor, expected) =>
    expect(dates('FREQ=DAILY', anchor + 'T10:00:00Z', 1)).toEqual([expected + 'T10:00:00.000Z']),
  );
  it('TC-TZ-012 separate server TZ processes yield identical schedule calculations', () => {
    const source = `import {nextOccurrence,parseRecurrence} from './src/schedules/recurrence.ts'; console.log(nextOccurrence({anchor:new Date('2026-03-07T15:00:00Z'),after:new Date('2026-03-07T15:00:00Z'),timezone:'America/New_York',rule:parseRecurrence('FREQ=DAILY')}).toISOString());`;
    const run = (TZ: string) =>
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        env: { ...process.env, TZ },
        encoding: 'utf8',
      }).trim();
    expect(run('UTC')).toBe('2026-03-08T14:00:00.000Z');
    expect(run('Asia/Tokyo')).toBe(run('UTC'));
  });
});

describe('Temporary image filesystem isolation', () => {
  const roots: string[] = [];
  const services: ImageTempService[] = [];
  async function temporary(overrides: Record<string, unknown> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'autobot-image-acceptance-'));
    roots.push(root);
    const config = new ConfigService<ReturnType<typeof validateEnvironment>, true>(
      validateEnvironment({
        DATABASE_URL: 'postgresql://localhost/autobot_test',
        REDIS_URL: 'redis://localhost',
        IMAGE_TEMP_DIR: join(root, 'images'),
        IMAGE_MAX_BYTES: 16,
        IMAGE_TEMP_MAX_TOTAL_BYTES: 32,
        IMAGE_TEMP_TTL_SECONDS: 60,
        ...overrides,
      }),
    );
    const service = new ImageTempService(config);
    services.push(service);
    await service.onModuleInit();
    return { root, service };
  }
  afterEach(async () => {
    for (const s of services.splice(0)) s.onModuleDestroy();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  it('TC-TMP-001 directory and file permissions restrict access', async () => {
    const { service } = await temporary();
    const path = await service.createFile(Uint8Array.of(1));
    expect((await stat(service.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it('TC-TMP-005 expired files removed while young files survive', async () => {
    const { service } = await temporary();
    const old = await service.createFile(Uint8Array.of(1)),
      young = await service.createFile(Uint8Array.of(2));
    const past = new Date(Date.now() - 61000);
    await utimes(old, past, past);
    expect(await service.cleanupExpired()).toBe(1);
    expect(await readFile(young)).toEqual(Buffer.of(2));
    await expect(stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('TC-TMP-006 startup cleanup removes crash orphans', async () => {
    const { service } = await temporary();
    const path = await service.createFile(Uint8Array.of(1));
    const past = new Date(Date.now() - 61000);
    await utimes(path, past, past);
    service.onModuleDestroy();
    await service.onModuleInit();
    expect(await readdir(service.directory)).toEqual([]);
  });
  it('TC-TMP-008 empty file rejected without artifact', async () => {
    const { service } = await temporary();
    await expect(service.createFile(new Uint8Array())).rejects.toThrow();
    expect(await readdir(service.directory)).toEqual([]);
  });
  it.each([15, 16, 17])('TC-TMP-009 image size %s boundary', async (size) => {
    const { service } = await temporary();
    if (size <= 16)
      expect((await stat(await service.createFile(new Uint8Array(size)))).size).toBe(size);
    else {
      await expect(service.createFile(new Uint8Array(size))).rejects.toThrow();
      expect(await readdir(service.directory)).toEqual([]);
    }
  });
  it('TC-TMP-010 full directory rejects extra file', async () => {
    const { service } = await temporary();
    await service.createFile(new Uint8Array(16));
    await service.createFile(new Uint8Array(16));
    await expect(service.createFile(Uint8Array.of(1))).rejects.toThrow('full');
    expect(await readdir(service.directory)).toHaveLength(2);
  });
  it('TC-TMP-011 concurrent writes cannot exceed shared directory capacity', async () => {
    const { service } = await temporary({ IMAGE_TEMP_MAX_TOTAL_BYTES: 16 });
    const results = await Promise.allSettled([
      service.createFile(new Uint8Array(16)),
      service.createFile(new Uint8Array(16)),
    ]);
    const entries = await readdir(service.directory);
    const sizes = await Promise.all(entries.map((x) => stat(join(service.directory, x))));
    console.info(
      'ACCEPTANCE_EVIDENCE ' +
        JSON.stringify({
          caseId: 'TC-TMP-011',
          successes: results.filter((x) => x.status === 'fulfilled').length,
          totalBytes: sizes.reduce((n, x) => n + x.size, 0),
          capacity: 16,
        }),
    );
    expect(sizes.reduce((n, x) => n + x.size, 0)).toBeLessThanOrEqual(16);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });
  it.each(['/', process.cwd()])('TC-TMP-014 unsafe temp directory %s rejected', (path) => {
    const config = new ConfigService<ReturnType<typeof validateEnvironment>, true>(
      validateEnvironment({
        DATABASE_URL: 'postgresql://localhost/autobot_test',
        REDIS_URL: 'redis://localhost',
        IMAGE_TEMP_DIR: path,
      }),
    );
    expect(() => new ImageTempService(config)).toThrow();
  });
  it.each(['outside', 'traversal', 'prefix'])(
    'TC-TMP-015 remove %s path cannot delete external file',
    async (variant) => {
      const { root, service } = await temporary();
      const target = join(root, 'outside');
      await writeFile(target, 'sentinel');
      const path =
        variant === 'traversal'
          ? service.directory + '/../outside'
          : variant === 'prefix'
            ? service.directory + '-other/../outside'
            : target;
      await service.remove(path);
      expect(await readFile(target, 'utf8')).toBe('sentinel');
    },
  );
  it('TC-TMP-016 symlink create remove cleanup never touches external target', async () => {
    const { root, service } = await temporary();
    const external = join(root, 'external');
    await writeFile(external, 'sentinel');
    const link = join(service.directory, 'link');
    await symlink(external, link);
    await service.createFile(Uint8Array.of(1));
    await service.cleanupExpired(Date.now() + 120000);
    await service.remove(link);
    expect(await readFile(external, 'utf8')).toBe('sentinel');
  });
  it('TC-TMP-017 cleanup and finally removal race is safe', async () => {
    const { service } = await temporary();
    const path = await service.createFile(Uint8Array.of(1));
    await Promise.all([
      service.cleanupExpired(Date.now() + 120000),
      service.remove(path),
      service.remove(path),
    ]);
    expect(await readdir(service.directory)).toEqual([]);
  });
});
