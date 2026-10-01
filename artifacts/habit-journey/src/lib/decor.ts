export const DECOR_ISLANDS = [
  { id: 'beginnings', name: 'البدايات' }, { id: 'study', name: 'الدراسة' }, { id: 'forest', name: 'الغابة' },
  { id: 'dreams', name: 'الأحلام' }, { id: 'heart', name: 'القلب' }, { id: 'adventure', name: 'المغامرة' },
] as const;
export type DecorIslandId = typeof DECOR_ISLANDS[number]['id'];
/** Bounded 6 slots per island: offsets (% of island box) from island centre. */
export const SLOT_POS = [
  { dx: -22, dy: -6 }, { dx: 0, dy: -12 }, { dx: 22, dy: -6 },
  { dx: -22, dy: 16 }, { dx: 0, dy: 20 }, { dx: 22, dy: 16 },
] as const;
export const SLOTS = [0, 1, 2, 3, 4, 5] as const;
export const ISLAND_FILE_TO_ID: Record<string, DecorIslandId> = {
  'island-beginnings.webp': 'beginnings', 'island-study.webp': 'study', 'island-forest.webp': 'forest',
  'island-dreams.webp': 'dreams', 'island-heart.webp': 'heart', 'island-adventure.webp': 'adventure',
};
export const LAST_HABIT_KEY = 'hj:lastJourneyHabit';
export function readLastHabit(): number | null {
  try { const v = Number(localStorage.getItem(LAST_HABIT_KEY)); return Number.isInteger(v) && v > 0 ? v : null; } catch { return null; }
}
export function writeLastHabit(id: number) { try { localStorage.setItem(LAST_HABIT_KEY, String(id)); } catch { /* ignore */ } }
export function pickHabit<T extends { id: number; isActive: boolean }>(habits: T[], last: number | null): T | undefined {
  return habits.find(h => h.id === last) ?? habits.find(h => h.isActive) ?? habits[0];
}
