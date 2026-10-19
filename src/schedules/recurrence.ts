import { ApiHttpException } from '../common/http/api-http.exception.js';

const DAY_MS = 86_400_000;
const MAX_SCAN_DAYS = 366 * 20;

const WEEKDAYS = new Map([
  ['MO', 1],
  ['TU', 2],
  ['WE', 3],
  ['TH', 4],
  ['FR', 5],
  ['SA', 6],
  ['SU', 0],
]);

export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export type ParsedRecurrence = {
  frequency: RecurrenceFrequency;
  interval: number;
  byDay: number[];
  byMonthDay: number[];
  count: number | null;
  until: Date | null;
};

export type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

export function parseRecurrence(expression: string): ParsedRecurrence {
  const normalized = expression.trim().replace(/^RRULE:/i, '');
  if (!normalized) invalid('RRULE is required.');
  const values = new Map<string, string>();
  for (const part of normalized.split(';')) {
    const [rawKey, rawValue, ...rest] = part.split('=');
    const key = rawKey?.trim().toUpperCase();
    const value = rawValue?.trim();
    if (!key || !value || rest.length > 0 || values.has(key))
      invalid('RRULE contains an invalid component.');
    values.set(key, value);
  }

  const frequency = values.get('FREQ')?.toUpperCase();
  if (frequency !== 'DAILY' && frequency !== 'WEEKLY' && frequency !== 'MONTHLY') {
    invalid('RRULE FREQ must be DAILY, WEEKLY, or MONTHLY.');
  }
  const allowed = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL']);
  if ([...values.keys()].some((key) => !allowed.has(key)))
    invalid('RRULE contains an unsupported component.');

  const interval = parsePositiveInteger(values.get('INTERVAL') ?? '1', 'INTERVAL');
  const byDay = values.get('BYDAY')
    ? values
        .get('BYDAY')!
        .split(',')
        .map((value) => {
          const day = WEEKDAYS.get(value.toUpperCase());
          if (day === undefined) invalid('BYDAY must contain two-letter weekday values.');
          return day;
        })
    : [];
  const byMonthDay = values.get('BYMONTHDAY')
    ? values
        .get('BYMONTHDAY')!
        .split(',')
        .map((value) => {
          const day = Number(value);
          if (!Number.isInteger(day) || day < 1 || day > 31)
            invalid('BYMONTHDAY must contain values from 1 to 31.');
          return day;
        })
    : [];
  const count = values.has('COUNT') ? parsePositiveInteger(values.get('COUNT')!, 'COUNT') : null;
  const until = values.has('UNTIL') ? parseUntil(values.get('UNTIL')!) : null;
  if (count !== null && until !== null) invalid('RRULE cannot contain both COUNT and UNTIL.');
  if (frequency === 'WEEKLY' && byMonthDay.length > 0)
    invalid('BYMONTHDAY is not supported with WEEKLY.');
  if (frequency === 'DAILY' && byMonthDay.length > 0)
    invalid('BYMONTHDAY is not supported with DAILY.');
  if (frequency === 'MONTHLY' && byDay.length > 0 && byMonthDay.length > 0) {
    invalid('Use either BYDAY or BYMONTHDAY with MONTHLY, not both.');
  }
  return { frequency, interval, byDay, byMonthDay, count, until };
}

export function nextOccurrence(input: {
  after: Date;
  anchor: Date;
  timezone: string;
  rule: ParsedRecurrence;
}): Date | null {
  const anchorLocal = zonedParts(input.anchor, input.timezone);
  const afterLocal = zonedParts(input.after, input.timezone);
  const anchorDate = dateOnly(anchorLocal);
  const untilLocalDate = input.rule.until
    ? dateOnly(zonedParts(input.rule.until, input.timezone))
    : null;
  let candidateDate = dateOnly(afterLocal);

  for (let index = 0; index < MAX_SCAN_DAYS; index += 1) {
    // No later local date can satisfy an UNTIL bound. This avoids scanning
    // twenty years while the schedule materialization transaction is open.
    if (untilLocalDate && compareDate(candidateDate, untilLocalDate) > 0) return null;
    if (index > 0 || compareDate(candidateDate, dateOnly(afterLocal)) !== 0) {
      const candidateLocal = { ...anchorLocal, ...dateParts(candidateDate) };
      if (matchesDate(candidateDate, anchorDate, input.rule)) {
        const candidate = zonedToUtc(candidateLocal, input.timezone);
        if (candidate > input.after && (!input.rule.until || candidate <= input.rule.until))
          return candidate;
      }
    }
    candidateDate = addDays(candidateDate, 1);
  }
  return null;
}

export function zonedParts(value: Date, timezone: string): LocalDateTime {
  const formatter = getFormatter(timezone);
  const parts = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value: text }) => [type, Number(text)]),
  ) as Record<string, number>;
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

export function zonedToUtc(local: LocalDateTime, timezone: string): Date {
  const localAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const initial = new Date(
    localAsUtc - (localAsUtcParts(zonedParts(new Date(localAsUtc), timezone)) - localAsUtc),
  );
  const matches: Date[] = [];
  for (let offset = -180; offset <= 180; offset += 1) {
    const candidate = new Date(initial.getTime() + offset * 60_000);
    if (sameLocal(zonedParts(candidate, timezone), local)) matches.push(candidate);
  }
  if (matches.length > 0) return new Date(Math.min(...matches.map((value) => value.getTime())));
  // For a DST gap choose the first valid wall-clock instant after the gap,
  // not the same minute after the transition (02:30 -> 03:00, not 03:30).
  // Search a broad UTC window because the initial offset estimate may be on
  // either side of the transition.
  let firstAfterGap: Date | null = null;
  for (let offset = -1_080; offset <= 1_080; offset += 1) {
    const candidate = new Date(localAsUtc + offset * 60_000);
    const parts = zonedParts(candidate, timezone);
    if (
      parts.year === local.year &&
      parts.month === local.month &&
      parts.day === local.day &&
      compareLocal(parts, local) >= 0 &&
      (!firstAfterGap || candidate < firstAfterGap)
    )
      firstAfterGap = candidate;
  }
  if (firstAfterGap) return firstAfterGap;
  return initial;
}

function matchesDate(date: Date, anchor: Date, rule: ParsedRecurrence): boolean {
  const dayOfWeek = date.getUTCDay();
  const days = Math.round((date.getTime() - anchor.getTime()) / DAY_MS);
  if (days < 0) return false;
  if (rule.frequency === 'DAILY' && days % rule.interval !== 0) return false;
  if (rule.frequency === 'WEEKLY') {
    if (Math.floor(days / 7) % rule.interval !== 0) return false;
    const weekdays = rule.byDay.length > 0 ? rule.byDay : [anchor.getUTCDay()];
    if (!weekdays.includes(dayOfWeek)) return false;
  }
  if (rule.frequency === 'MONTHLY') {
    const months =
      (date.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      date.getUTCMonth() -
      anchor.getUTCMonth();
    if (months < 0 || months % rule.interval !== 0) return false;
    if (rule.byMonthDay.length > 0) return rule.byMonthDay.includes(date.getUTCDate());
    const weekdays = rule.byDay.length > 0 ? rule.byDay : [anchor.getUTCDay()];
    if (!weekdays.includes(dayOfWeek)) return false;
  }
  if (rule.frequency === 'DAILY' && rule.byDay.length > 0 && !rule.byDay.includes(dayOfWeek))
    return false;
  return true;
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000)
    invalid(`${field} must be a positive integer up to 10000.`);
  return parsed;
}

function parseUntil(value: string): Date {
  if (/^\d{8}$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6));
    const day = Number(value.slice(6, 8));
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (
      month < 1 ||
      month > 12 ||
      calendar.getUTCFullYear() !== year ||
      calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day
    )
      invalid('UNTIL must contain a real calendar date.');
  }
  const normalized = /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T23:59:59Z`
    : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) invalid('UNTIL must be an ISO date-time or YYYYMMDD.');
  return parsed;
}

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timezone);
  if (existing) return existing;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timezone, formatter);
    return formatter;
  } catch {
    invalid('Timezone must be a valid IANA timezone.');
  }
}

function localAsUtcParts(local: LocalDateTime): number {
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
}

function dateOnly(value: LocalDateTime): Date {
  return new Date(Date.UTC(value.year, value.month - 1, value.day));
}
function dateParts(value: Date) {
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}
function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}
function compareDate(left: Date, right: Date): number {
  return left.getTime() - right.getTime();
}
function sameLocal(left: LocalDateTime, right: LocalDateTime): boolean {
  return compareLocal(left, right) === 0;
}
function compareLocal(left: LocalDateTime, right: LocalDateTime): number {
  return localAsUtcParts(left) - localAsUtcParts(right);
}
function invalid(message: string): never {
  throw new ApiHttpException(422, 'INVALID_RRULE', message);
}
