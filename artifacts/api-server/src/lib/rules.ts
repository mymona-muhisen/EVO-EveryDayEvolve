/**
 * Deterministic rule engine for gamification math: XP/leveling, coin
 * rewards, and streak continuation. No AI involved — the text provider only
 * phrases messages around numbers computed here.
 */

export type Difficulty = "easy" | "medium" | "hard";
export type Cadence = "daily" | "weekdays" | "weekly" | "custom_days";

const BASE_COINS_BY_DIFFICULTY: Record<Difficulty, number> = {
  easy: 5,
  medium: 10,
  hard: 15,
};

const XP_BY_DIFFICULTY: Record<Difficulty, number> = {
  easy: 10,
  medium: 20,
  hard: 30,
};

const WEEKLY_STREAK_BONUS = 10;

export function getXpForNextLevel(level: number): number {
  return 100 + (level - 1) * 20;
}

/** Backwards-compatible name used by existing API responses. */
export function xpToNextLevel(level: number): number {
  return getXpForNextLevel(level);
}

/** Returns the current level for a lifetime XP total using applyXp's thresholds. */
export function getLevelFromXP(totalXp: number): number {
  let level = 1;
  let remainingXp = Math.max(0, totalXp);
  while (remainingXp >= getXpForNextLevel(level)) {
    remainingXp -= getXpForNextLevel(level);
    level += 1;
  }
  return level;
}

/** Lifetime-equivalent XP for the stored level and within-level XP pair. */
export function getTotalXp(level: number, xp: number): number {
  let totalXp = Math.max(0, xp);
  for (let previousLevel = 1; previousLevel < level; previousLevel += 1) {
    totalXp += getXpForNextLevel(previousLevel);
  }
  return totalXp;
}

/** Progress calculated with the same per-level threshold consumed by applyXp. */
export function getLevelProgress(
  level: number,
  xp: number,
): { nextLevelXp: number; progressPercent: number } {
  const nextLevelXp = getXpForNextLevel(level);
  const progressPercent = Math.min(100, Math.max(0, (xp / nextLevelXp) * 100));
  return { nextLevelXp, progressPercent };
}

export function xpForDifficulty(difficulty: Difficulty): number {
  return XP_BY_DIFFICULTY[difficulty];
}

export interface AppliedXp {
  level: number;
  xp: number;
  leveledUp: boolean;
}

/** Applies gained XP, rolling over as many level-ups as the XP covers. */
export function applyXp(
  currentLevel: number,
  currentXp: number,
  xpGained: number,
): AppliedXp {
  let level = currentLevel;
  let xp = currentXp + xpGained;
  let leveledUp = false;
  while (xp >= getXpForNextLevel(level)) {
    xp -= getXpForNextLevel(level);
    level += 1;
    leveledUp = true;
  }
  return { level, xp, leveledUp };
}

export function coinsForCheckin(
  difficulty: Difficulty,
  newStreak: number,
): { base: number; bonus: number } {
  const base = BASE_COINS_BY_DIFFICULTY[difficulty];
  const bonus = newStreak > 0 && newStreak % 7 === 0 ? WEEKLY_STREAK_BONUS : 0;
  return { base, bonus };
}

/** Coin cost to recover a just-broken streak; scales with what was lost. */
export function recoverStreakCost(lastBrokenStreak: number): number {
  return 20 + lastBrokenStreak * 2;
}

function daysBetween(a: string, b: string): number {
  const d1 = Date.parse(`${a}T00:00:00Z`);
  const d2 = Date.parse(`${b}T00:00:00Z`);
  return Math.round((d2 - d1) / 86_400_000);
}

/**
 * Whether checking in on `date` continues the streak last extended on
 * `lastDate`, given the habit's cadence. `lastDate`/`date` are "YYYY-MM-DD".
 */
export function continuesStreak(
  cadence: Cadence,
  lastDate: string | null,
  date: string,
  customDays: number[] | null | undefined,
): boolean {
  if (!lastDate) return true; // first-ever check-in always starts a streak
  const gap = daysBetween(lastDate, date);
  if (gap <= 0) return false; // same day or backfilled before the last date

  switch (cadence) {
    case "daily":
      return gap === 1;
    case "weekly":
      return gap <= 7;
    case "weekdays":
      return gap <= 3; // covers Fri -> Mon and any shorter same-week gap
    case "custom_days": {
      if (!customDays || customDays.length === 0) return gap === 1;
      for (let i = 1; i < gap; i++) {
        const d = new Date(`${lastDate}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        if (customDays.includes(d.getUTCDay())) return false; // missed a scheduled day
      }
      return true;
    }
    default:
      return gap === 1;
  }
}

/** Whether a habit is scheduled on the given calendar date. */
export function isScheduledOn(
  cadence: Cadence,
  customDays: number[] | null | undefined,
  date: Date,
): boolean {
  const day = date.getUTCDay();
  switch (cadence) {
    case "daily":
      return true;
    case "weekdays":
      return day >= 1 && day <= 5;
    case "weekly":
      return true;
    case "custom_days":
      return !!customDays && customDays.includes(day);
    default:
      return true;
  }
}
