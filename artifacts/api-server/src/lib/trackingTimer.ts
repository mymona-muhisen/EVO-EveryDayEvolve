export type TimerSnapshot = {
  activeElapsedMs: number;
  intervalElapsedMs: number;
  intervalMinutes: number;
  timerAnchorAt: Date | null;
};

export function projectTimer(snapshot: TimerSnapshot, now: Date): TimerSnapshot {
  if (!snapshot.timerAnchorAt) return snapshot;
  const delta = Math.max(0, now.getTime() - snapshot.timerAnchorAt.getTime());
  const intervalMs = snapshot.intervalMinutes * 60_000;
  return {
    ...snapshot,
    activeElapsedMs: snapshot.activeElapsedMs + delta,
    intervalElapsedMs: (snapshot.intervalElapsedMs + delta) % intervalMs,
  };
}

export function accrueTimer(snapshot: TimerSnapshot, now: Date): TimerSnapshot {
  return { ...projectTimer(snapshot, now), timerAnchorAt: null };
}

export function timerClock(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`
    : `${String(minutes).padStart(2, "0")}m ${String(remainder).padStart(2, "0")}s`;
}