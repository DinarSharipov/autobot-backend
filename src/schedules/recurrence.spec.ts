import { describe, expect, it } from 'vitest';
import { nextOccurrence, parseRecurrence } from './recurrence.js';

describe('recurrence engine', () => {
  it('supports daily, weekly and monthly rules', () => {
    const anchor = new Date('2026-01-01T10:00:00Z');
    expect(
      nextOccurrence({
        after: anchor,
        anchor,
        timezone: 'UTC',
        rule: parseRecurrence('FREQ=DAILY;INTERVAL=2'),
      }),
    ).toEqual(new Date('2026-01-03T10:00:00Z'));
    expect(
      nextOccurrence({
        after: anchor,
        anchor,
        timezone: 'UTC',
        rule: parseRecurrence('FREQ=WEEKLY;BYDAY=MO,WE'),
      }),
    ).toEqual(new Date('2026-01-05T10:00:00Z'));
    expect(
      nextOccurrence({
        after: anchor,
        anchor,
        timezone: 'UTC',
        rule: parseRecurrence('FREQ=MONTHLY;BYMONTHDAY=15'),
      }),
    ).toEqual(new Date('2026-01-15T10:00:00Z'));
  });

  it('preserves local wall-clock time across a DST transition', () => {
    const anchor = new Date('2026-03-07T15:00:00Z');
    const next = nextOccurrence({
      after: anchor,
      anchor,
      timezone: 'America/New_York',
      rule: parseRecurrence('FREQ=DAILY'),
    });
    expect(next).toEqual(new Date('2026-03-08T14:00:00Z'));
  });

  it('rejects unsupported recurrence parts', () => {
    expect(() => parseRecurrence('FREQ=HOURLY')).toThrowError(
      'RRULE FREQ must be DAILY, WEEKLY, or MONTHLY.',
    );
    expect(() => parseRecurrence('FREQ=DAILY;BYHOUR=10')).toThrowError(
      'RRULE contains an unsupported component.',
    );
  });
});
