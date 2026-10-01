export type DashboardGreeting = "morning" | "evening" | "night";

export function dashboardGreeting(timezone: string, now: Date): DashboardGreeting {
  let hour: number;
  try {
    hour = Number(new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now));
  } catch {
    hour = now.getUTCHours();
  }
  return hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "evening" : "night";
}

export interface DashboardFocusCandidate {
  habit: { id: number; createdAt: Date };
  execution: {
    scheduled: boolean;
    status: string;
    lastResumedAt: Date | null;
  };
}

function habitOrder(a: DashboardFocusCandidate, b: DashboardFocusCandidate) {
  return a.habit.createdAt.getTime() - b.habit.createdAt.getTime() || a.habit.id - b.habit.id;
}

function focusPriority(item: DashboardFocusCandidate) {
  if (item.execution.lastResumedAt) return 0;
  if (item.execution.status === "paused") return 1;
  if (item.execution.scheduled
    && !["completed", "pending_reflection", "target_reached"].includes(item.execution.status)) return 2;
  if (item.execution.scheduled) return 3;
  return 4;
}

export function orderDashboardFocus<T extends DashboardFocusCandidate>(items: T[]): T[] {
  return [...items].sort((a, b) => focusPriority(a) - focusPriority(b) || habitOrder(a, b));
}

export interface DashboardMissedCandidate {
  habit: { id: number };
  execution: {
    date: string | Date;
    scheduled: boolean;
    status: string;
    missedReason: string | null;
    adaptationDecision: string | null;
  };
}

export function chooseDashboardMissed<T extends DashboardMissedCandidate>(items: T[]): T | null {
  return [...items].filter((item) => item.execution.scheduled
    && item.execution.status === "missed"
    && item.execution.adaptationDecision == null)
    .sort((a, b) => dateKey(b.execution.date).localeCompare(dateKey(a.execution.date))
      || a.habit.id - b.habit.id)[0] ?? null;
}

function dateKey(date: string | Date) {
  return date instanceof Date ? date.toISOString().slice(0, 10) : date;
}

function effectiveDashboardExecutionStatus(execution: {
  status: string;
  executionType?: string;
  goalType?: string;
  targetValue?: number;
  minimumValue?: number;
  actualValue?: number | null;
  checkin?: { completed: boolean } | null;
} | null) {
  if (!execution) return null;
  const { status, executionType, goalType, actualValue, targetValue, minimumValue } = execution;
  const isClosedSuccess = (status === "pending_reflection" || status === "completed")
    && execution.checkin?.completed;
  if (executionType === "boolean" || goalType === "quit") {
    if (isClosedSuccess) return "target_reached";
    if (["target_reached", "minimum_reached", "completed"].includes(status)) return "in_progress";
  }
  if ((isClosedSuccess || status === "target_reached" || status === "minimum_reached")
    && (executionType === "count" || executionType === "duration")
    && goalType === "build" && actualValue != null) {
    if (targetValue != null && actualValue >= targetValue) return "target_reached";
    if (minimumValue != null && actualValue >= minimumValue) return "minimum_reached";
    return status === "pending_reflection" || status === "completed" ? "pending" : "in_progress";
  }
  return status;
}

export function dashboardState(input: {
  missedDay: DashboardMissedCandidate | null;
  focusExecution: {
    status: string;
    executionType?: string;
    goalType?: string;
    targetValue?: number;
    minimumValue?: number;
    actualValue?: number | null;
    checkin?: { completed: boolean } | null;
  } | null;
  journeyCompleted: boolean;
  hasHabits: boolean;
  onboardingCompleted: boolean;
  trackingStatus: string | null;
  hasAnalysis: boolean;
  hasTrackedData: boolean;
}): "new_user" | "no_habit" | "tracking_active" | "tracking_paused" | "analysis_available" | "habit_not_started" | "habit_in_progress" | "minimum_reached" | "target_complete" | "missed_day" | "adaptation_required" | "journey_complete" | "rest_day" {
  const focusStatus = effectiveDashboardExecutionStatus(input.focusExecution);
  if (input.journeyCompleted && focusStatus
    && ["target_reached", "completed"].includes(focusStatus)) {
    return "journey_complete";
  }
  if (input.missedDay) {
    return input.missedDay.execution.missedReason
      && input.missedDay.execution.adaptationDecision == null ? "adaptation_required" : "missed_day";
  }
  if (input.focusExecution) {
    const status = focusStatus ?? input.focusExecution.status;
    if (status === "minimum_reached") return "minimum_reached";
    if (["target_reached", "completed"].includes(status)) return "target_complete";
    if (status === "paused") return "tracking_paused";
    if (status === "in_progress") return "habit_in_progress";
    return "habit_not_started";
  }
  if (input.journeyCompleted) return "journey_complete";
  if (!input.hasHabits) return input.onboardingCompleted ? "no_habit" : "new_user";
  if (input.trackingStatus === "active") return "tracking_active";
  if (input.trackingStatus === "paused") return "tracking_paused";
  if (input.hasAnalysis || input.hasTrackedData) return "analysis_available";
  return "rest_day";
}