/**
 * A deliberately small, deterministic wall-clock recurrence engine.
 *
 * The persisted anchor is an instant, but recurrence arithmetic happens in
 * its local calendar in `timeZone`. A missing wall time is skipped and an
 * ambiguous wall time resolves to its earlier instant.
 */

export type RecurrenceFrequency = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";
export type RecurrenceWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface ParsedRecurrence {
  frequency: RecurrenceFrequency;
  interval: number;
  byDay?: readonly RecurrenceWeekday[];
  byHour?: readonly number[];
  byMinute?: readonly number[];
  byMonthDay?: readonly number[];
  normalized: string;
}

export type RecurrenceErrorCode =
  | "INVALID_RULE"
  | "INVALID_TIME_ZONE"
  | "INVALID_TIMESTAMP"
  | "NO_OCCURRENCE";

export class RecurrenceError extends Error {
  readonly code: RecurrenceErrorCode;

  constructor(code: RecurrenceErrorCode, message: string) {
    super(message);
    this.name = "RecurrenceError";
    this.code = code;
  }
}

export interface NextRecurrenceOccurrenceInput {
  rule: string | ParsedRecurrence;
  /** DTSTART-like persisted instant; its local minute anchors all intervals. */
  scheduleAnchorAt: number;
  /** IANA time-zone name understood by the shipping JavaScript runtime. */
  timeZone: string;
  /** Return the first occurrence whose epoch milliseconds are strictly greater. */
  after: number;
}

const FREQUENCIES = new Set<RecurrenceFrequency>([
  "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY",
]);
const WEEKDAYS: readonly RecurrenceWeekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WEEKDAY_INDEX = new Map(WEEKDAYS.map((day, index) => [day, index]));
const MIN_YEAR = 1970;
const MAX_YEAR = 2100;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_PERIODS = 2_000_000;

const ALLOWED_KEYS: Record<RecurrenceFrequency, ReadonlySet<string>> = {
  MINUTELY: new Set(["FREQ", "INTERVAL"]),
  HOURLY: new Set(["FREQ", "INTERVAL", "BYMINUTE"]),
  DAILY: new Set(["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE"]),
  WEEKLY: new Set(["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE"]),
  MONTHLY: new Set(["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE", "BYMONTHDAY"]),
};

export function parseRecurrence(input: string): ParsedRecurrence {
  if (typeof input !== "string" || input.trim() === "") invalid("recurrence rule is empty");
  let source = input.trim();
  if (/^RRULE:/i.test(source)) source = source.slice(source.indexOf(":") + 1);

  const fields = new Map<string, string>();
  for (const rawPart of source.split(";")) {
    const part = rawPart.trim();
    const separator = part.indexOf("=");
    if (separator <= 0 || separator === part.length - 1) invalid(`invalid recurrence clause "${part}"`);
    const key = part.slice(0, separator).trim().toUpperCase();
    const value = part.slice(separator + 1).trim().toUpperCase();
    if (!/^[A-Z]+$/.test(key) || value === "") invalid(`invalid recurrence clause "${part}"`);
    if (fields.has(key)) invalid(`duplicate recurrence clause ${key}`);
    fields.set(key, value);
  }

  const frequencyValue = fields.get("FREQ");
  if (!frequencyValue || !FREQUENCIES.has(frequencyValue as RecurrenceFrequency)) {
    invalid(`unsupported recurrence frequency "${frequencyValue ?? ""}"`);
  }
  const frequency = frequencyValue as RecurrenceFrequency;
  for (const key of fields.keys()) {
    if (!ALLOWED_KEYS[frequency].has(key)) invalid(`${key} is not supported with FREQ=${frequency}`);
  }

  const interval = fields.has("INTERVAL")
    ? parseInteger(fields.get("INTERVAL")!, "INTERVAL", 1, 365)
    : 1;
  const byDay = fields.has("BYDAY") ? parseDays(fields.get("BYDAY")!) : undefined;
  const byHour = fields.has("BYHOUR") ? parseIntegers(fields.get("BYHOUR")!, "BYHOUR", 0, 23) : undefined;
  const byMinute = fields.has("BYMINUTE")
    ? parseIntegers(fields.get("BYMINUTE")!, "BYMINUTE", 0, 59)
    : undefined;
  const byMonthDay = fields.has("BYMONTHDAY")
    ? parseIntegers(fields.get("BYMONTHDAY")!, "BYMONTHDAY", 1, 31)
    : undefined;

  const normalized = [
    `FREQ=${frequency}`,
    `INTERVAL=${interval}`,
    byDay ? `BYDAY=${byDay.join(",")}` : null,
    byHour ? `BYHOUR=${byHour.join(",")}` : null,
    byMinute ? `BYMINUTE=${byMinute.join(",")}` : null,
    byMonthDay ? `BYMONTHDAY=${byMonthDay.join(",")}` : null,
  ].filter((part): part is string => part !== null).join(";");

  return {
    frequency,
    interval,
    ...(byDay ? { byDay } : {}),
    ...(byHour ? { byHour } : {}),
    ...(byMinute ? { byMinute } : {}),
    ...(byMonthDay ? { byMonthDay } : {}),
    normalized,
  };
}

export function normalizeRecurrence(input: string): string {
  return parseRecurrence(input).normalized;
}

export function nextRecurrenceOccurrence(input: NextRecurrenceOccurrenceInput): number {
  const rule = typeof input.rule === "string" ? parseRecurrence(input.rule) : validateParsed(input.rule);
  assertTimestamp(input.scheduleAnchorAt, "scheduleAnchorAt");
  assertTimestamp(input.after, "after");
  const formatters = formattersFor(input.timeZone);
  const anchor = localAt(input.scheduleAnchorAt, formatters.parts);
  if (anchor.year < MIN_YEAR || anchor.year > MAX_YEAR) {
    throw new RecurrenceError(
      "INVALID_TIMESTAMP",
      `scheduleAnchorAt must resolve to a local year from ${MIN_YEAR} through ${MAX_YEAR}`,
    );
  }
  const cursor = localAt(input.after, formatters.parts);
  const startIndex = initialPeriodIndex(rule, anchor, cursor, input.after);

  for (let step = 0; step < MAX_PERIODS; step += 1) {
    const periodIndex = startIndex + step;
    const candidates = candidatesInPeriod(rule, anchor, periodIndex);
    if (candidates === null) break;
    for (const candidate of candidates) {
      if (candidate.year < MIN_YEAR) continue;
      if (candidate.year > MAX_YEAR) return noOccurrence(rule, input.timeZone);
      const occurrence = resolveLocal(candidate, formatters, input.timeZone);
      if (occurrence !== null && occurrence >= input.scheduleAnchorAt && occurrence > input.after) {
        return occurrence;
      }
    }
  }
  return noOccurrence(rule, input.timeZone);
}

interface LocalMinute {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

interface ZoneFormatters {
  parts: Intl.DateTimeFormat;
  offset: Intl.DateTimeFormat;
}

const formatterCache = new Map<string, ZoneFormatters>();
const offsetCache = new Map<string, readonly number[]>();

function formattersFor(timeZone: string): ZoneFormatters {
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new RecurrenceError("INVALID_TIME_ZONE", "timeZone must be an IANA time-zone name");
  }
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  try {
    const base: Intl.DateTimeFormatOptions = {
      timeZone,
      calendar: "iso8601",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    };
    const value = {
      parts: new Intl.DateTimeFormat("en-US", base),
      offset: new Intl.DateTimeFormat("en-US", { ...base, timeZoneName: "longOffset" }),
    };
    // Force validation now rather than on the first candidate.
    value.parts.format(0);
    formatterCache.set(timeZone, value);
    return value;
  } catch {
    throw new RecurrenceError("INVALID_TIME_ZONE", `unsupported IANA time zone "${timeZone}"`);
  }
}

function localAt(epoch: number, formatter: Intl.DateTimeFormat): LocalMinute {
  const values = numericParts(formatter, epoch);
  return {
    year: requiredPart(values, "year"),
    month: requiredPart(values, "month"),
    day: requiredPart(values, "day"),
    hour: requiredPart(values, "hour"),
    minute: requiredPart(values, "minute"),
  };
}

function numericParts(formatter: Intl.DateTimeFormat, epoch: number): Partial<Record<string, number>> {
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(epoch)) {
    if (["year", "month", "day", "hour", "minute", "second"].includes(part.type)) {
      values[part.type] = Number(part.value);
    }
  }
  return values;
}

function requiredPart(values: Partial<Record<string, number>>, name: string): number {
  const value = values[name];
  if (value === undefined) {
    throw new RecurrenceError("INVALID_TIME_ZONE", `time-zone formatter omitted ${name}`);
  }
  return value;
}

function initialPeriodIndex(
  rule: ParsedRecurrence,
  anchor: LocalMinute,
  cursor: LocalMinute,
  after: number,
): number {
  if (after < 0 || civilMinute(cursor) < civilMinute(anchor)) return 0;
  let elapsed: number;
  switch (rule.frequency) {
    case "MINUTELY": elapsed = civilMinute(cursor) - civilMinute(anchor); break;
    case "HOURLY": elapsed = civilHour(cursor) - civilHour(anchor); break;
    case "DAILY": elapsed = civilDay(cursor) - civilDay(anchor); break;
    case "WEEKLY": elapsed = Math.floor((weekStart(cursor) - weekStart(anchor)) / 7); break;
    case "MONTHLY": elapsed = monthIndex(cursor) - monthIndex(anchor); break;
  }
  return Math.max(0, Math.floor(elapsed / rule.interval));
}

function candidatesInPeriod(
  rule: ParsedRecurrence,
  anchor: LocalMinute,
  periodIndex: number,
): LocalMinute[] | null {
  const increment = periodIndex * rule.interval;
  switch (rule.frequency) {
    case "MINUTELY": {
      const candidate = minuteFromCivil(civilMinute(anchor) + increment);
      return candidate.year > MAX_YEAR ? null : [candidate];
    }
    case "HOURLY": {
      const base = hourFromCivil(civilHour(anchor) + increment);
      if (base.year > MAX_YEAR) return null;
      return (rule.byMinute ?? [anchor.minute]).map((minute) => ({ ...base, minute }));
    }
    case "DAILY": {
      const date = dateFromCivil(civilDay(anchor) + increment);
      if (date.year > MAX_YEAR) return null;
      return timesFor(date, rule, anchor);
    }
    case "WEEKLY": {
      const monday = weekStart(anchor) + increment * 7;
      const days = rule.byDay ?? [weekdayOf(anchor)];
      const result: LocalMinute[] = [];
      for (const day of days) {
        const date = dateFromCivil(monday + WEEKDAY_INDEX.get(day)!);
        if (date.year > MAX_YEAR) return result.length ? result : null;
        result.push(...timesFor(date, rule, anchor));
      }
      return result;
    }
    case "MONTHLY": {
      const index = monthIndex(anchor) + increment;
      const year = Math.floor(index / 12);
      const month = (index % 12) + 1;
      if (year > MAX_YEAR) return null;
      const result: LocalMinute[] = [];
      for (const day of rule.byMonthDay ?? [anchor.day]) {
        if (day <= daysInMonth(year, month)) result.push(...timesFor({ year, month, day }, rule, anchor));
      }
      return result;
    }
  }
}

function timesFor(
  date: Pick<LocalMinute, "year" | "month" | "day">,
  rule: ParsedRecurrence,
  anchor: LocalMinute,
): LocalMinute[] {
  const result: LocalMinute[] = [];
  for (const hour of rule.byHour ?? [anchor.hour]) {
    for (const minute of rule.byMinute ?? [anchor.minute]) result.push({ ...date, hour, minute });
  }
  return result;
}

function resolveLocal(candidate: LocalMinute, formatters: ZoneFormatters, timeZone: string): number | null {
  const naive = civilMinute(candidate) * MINUTE_MS;
  const matches: number[] = [];
  for (const offset of offsetsNear(naive, formatters.offset, timeZone)) {
    const epoch = naive - offset;
    const parts = numericParts(formatters.parts, epoch);
    if (
      parts.year === candidate.year && parts.month === candidate.month && parts.day === candidate.day &&
      parts.hour === candidate.hour && parts.minute === candidate.minute && parts.second === 0
    ) matches.push(epoch);
  }
  return matches.length ? Math.min(...new Set(matches)) : null;
}

function offsetsNear(naive: number, formatter: Intl.DateTimeFormat, timeZone: string): readonly number[] {
  const date = new Date(naive);
  const key = `${timeZone}:${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
  const cached = offsetCache.get(key);
  if (cached) return cached;
  const offsets = new Set<number>();
  for (const hours of [-48, -24, 0, 24, 48]) {
    const name = formatter.formatToParts(naive + hours * HOUR_MS)
      .find((part) => part.type === "timeZoneName")?.value;
    const offset = parseOffset(name);
    if (offset !== null) offsets.add(offset);
  }
  const result = [...offsets];
  offsetCache.set(key, result);
  return result;
}

function parseOffset(value: string | undefined): number | null {
  if (value === "GMT" || value === "UTC") return 0;
  const match = /^GMT([+-])(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value ?? "");
  if (!match) return null;
  const milliseconds = (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0)) * 1000;
  return match[1] === "+" ? milliseconds : -milliseconds;
}

function civilMinute(value: LocalMinute): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute) / MINUTE_MS;
}

function civilHour(value: LocalMinute): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour) / HOUR_MS;
}

function civilDay(value: Pick<LocalMinute, "year" | "month" | "day">): number {
  return Date.UTC(value.year, value.month - 1, value.day) / DAY_MS;
}

function minuteFromCivil(value: number): LocalMinute {
  return localFromUtcDate(new Date(value * MINUTE_MS));
}

function hourFromCivil(value: number): LocalMinute {
  return localFromUtcDate(new Date(value * HOUR_MS));
}

function dateFromCivil(value: number): Pick<LocalMinute, "year" | "month" | "day"> {
  const date = new Date(value * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function localFromUtcDate(date: Date): LocalMinute {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function monthIndex(value: Pick<LocalMinute, "year" | "month">): number {
  return value.year * 12 + value.month - 1;
}

function weekdayOf(value: Pick<LocalMinute, "year" | "month" | "day">): RecurrenceWeekday {
  const sundayFirst = new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCDay();
  return WEEKDAYS[(sundayFirst + 6) % 7]!;
}

function weekStart(value: Pick<LocalMinute, "year" | "month" | "day">): number {
  const day = civilDay(value);
  return day - WEEKDAY_INDEX.get(weekdayOf(value))!;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseDays(value: string): RecurrenceWeekday[] {
  const result = value.split(",").map((part) => part.trim() as RecurrenceWeekday);
  if (result.length === 0 || result.some((day) => !WEEKDAY_INDEX.has(day))) invalid(`invalid BYDAY "${value}"`);
  if (new Set(result).size !== result.length) invalid(`duplicate value in BYDAY "${value}"`);
  return result.sort((a, b) => WEEKDAY_INDEX.get(a)! - WEEKDAY_INDEX.get(b)!);
}

function parseIntegers(value: string, name: string, minimum: number, maximum: number): number[] {
  const result = value.split(",").map((part) => parseInteger(part.trim(), name, minimum, maximum));
  if (new Set(result).size !== result.length) invalid(`duplicate value in ${name} "${value}"`);
  return result.sort((a, b) => a - b);
}

function parseInteger(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) invalid(`${name} must be an integer from ${minimum} through ${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function validateParsed(value: ParsedRecurrence): ParsedRecurrence {
  // Reparse the canonical representation so callers cannot bypass bounds with
  // a hand-built object that merely satisfies TypeScript at compile time.
  if (!value || typeof value.normalized !== "string") invalid("invalid parsed recurrence");
  return parseRecurrence(value.normalized);
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Number.isNaN(new Date(value).getTime())) {
    throw new RecurrenceError("INVALID_TIMESTAMP", `${name} must be finite integer epoch milliseconds`);
  }
}

function invalid(message: string): never {
  throw new RecurrenceError("INVALID_RULE", message);
}

function noOccurrence(rule: ParsedRecurrence, timeZone: string): never {
  throw new RecurrenceError(
    "NO_OCCURRENCE",
    `no ${rule.normalized} occurrence exists through local year ${MAX_YEAR} in ${timeZone}`,
  );
}
