/** Formats a Date as a "YYYY-MM-DD" string in UTC, matching DB date columns. */
export function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's date as "YYYY-MM-DD" in the given IANA timezone. */
export function todayInTimezone(timezone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return toDateOnly(now);
  }
}

/** Server-authoritative habit start suggestion: tomorrow from 21:00 local, today otherwise. */
export function suggestedJourneyStartDate(timezone: string, now = new Date()): string {
  let today: string;
  try {
    today = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    const localParts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(localParts.find((part) => part.type === "hour")?.value ?? "0");
    if (hour < 21) return today;
  } catch {
    today = toDateOnly(now);
    const hour = now.getUTCHours();
    if (hour < 21) return today;
  }
  const tomorrow = new Date(`${today}T00:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return toDateOnly(tomorrow);
}

/**
 * Some generated `@workspace/api-zod` query-param schemas use a plain
 * `zod.date()` (not `zod.coerce.date()`) for date-format fields — unlike
 * numeric query params, these are NOT auto-coerced from the query string.
 * Call this on `req.query` before `.safeParse()` for any schema with a
 * `zod.date()` field (e.g. ListHabitCheckinsQueryParams' from/to,
 * ListTimeEntriesQueryParams' date, GetTimeEntriesSummaryQueryParams' date).
 * Leaves unparseable strings alone so zod still reports a validation error.
 */
export function coerceQueryDates(
  query: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const result = { ...query };
  for (const field of fields) {
    const value = result[field];
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        result[field] = parsed;
      }
    }
  }
  return result;
}
