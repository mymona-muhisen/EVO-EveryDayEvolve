import type { Memory } from '@workspace/api-client-react';

/** A legacy habit/date reference is not evidence of a saved Journey Day. */
export function memoryDayHref(memory: Pick<Memory, 'journeyId' | 'habitDayId' | 'dayNumber'>): string | null {
  if (!memory.journeyId || !memory.habitDayId || !memory.dayNumber
    || !Number.isInteger(memory.dayNumber) || memory.dayNumber < 1 || memory.dayNumber > 22) return null;
  return `/habits/${memory.journeyId}/journey?day=${memory.dayNumber}`;
}

export function journeyDayFromSearch(search: string): number | null {
  const value = new URLSearchParams(search).get('day');
  if (!value || !/^\d+$/.test(value)) return null;
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 22 ? day : null;
}