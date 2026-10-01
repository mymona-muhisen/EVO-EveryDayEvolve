import { evaluateHabitCheckin } from "./aiRules";

export type DailyStatus =
  | "pending"
  | "in_progress"
  | "paused"
  | "minimum_reached"
  | "target_reached"
  | "pending_reflection"
  | "completed"
  | "missed"
  | "recovery_available"
  | "recovery_active"
  | "recovered";

export type DailyAction =
  | "start"
  | "pause"
  | "resume"
  | "finish"
  | "update_progress"
  | "done";

export type DailyPlan = {
  executionType: "duration" | "count" | "boolean" | "limit";
  goalType: "build" | "quit";
  targetValue: number;
  minimumValue: number;
  successLimitValue: number | null;
};

export type DailyExecutionState = {
  executionType: "duration" | "count" | "boolean" | "limit";
  status: DailyStatus;
  startedAt: Date | null;
  lastResumedAt: Date | null;
  pausedAt: Date | null;
  pausedSeconds: number;
  elapsedBaseSeconds: number;
  segmentPausedSeconds: number;
  finishedAt: Date | null;
  actualValue: number | null;
  actualSeconds: number | null;
};

export type DailyActionInput = {
  action: DailyAction;
  value?: number;
};

export class DailyExecutionTransitionError extends Error {}

export function elapsedSecondsAt(state: DailyExecutionState, now: Date): number {
  const carriedSeconds = state.actualSeconds
    ?? (state.executionType === "duration" && state.actualValue != null
      ? Math.round(state.actualValue * 60)
      : state.elapsedBaseSeconds);
  if (state.status === "missed") return carriedSeconds;
  if (!state.startedAt) return carriedSeconds;
  const end = state.pausedAt ?? (state.lastResumedAt ? now : state.finishedAt ?? state.startedAt);
  const activeInSegment = Math.max(
    0,
    Math.floor((end.getTime() - state.startedAt.getTime()) / 1000) - state.segmentPausedSeconds,
  );
  return state.elapsedBaseSeconds + activeInSegment;
}

export function dailyProgressStatus(plan: DailyPlan, value: number | null): DailyStatus {
  if (value == null) return "pending";
  if (plan.goalType === "quit") {
    if (value <= plan.targetValue) return "target_reached";
    if (plan.successLimitValue != null && value <= plan.successLimitValue) return "minimum_reached";
    return "in_progress";
  }
  if (value >= plan.targetValue) return "target_reached";
  if (value >= plan.minimumValue) return "minimum_reached";
  return "in_progress";
}

function canChange(state: DailyExecutionState, action: DailyAction): void {
  if (state.status === "missed" || state.status === "recovered") {
    throw new DailyExecutionTransitionError("This daily execution is already closed");
  }
  if (state.status === "recovery_available" || state.status === "recovery_active") {
    throw new DailyExecutionTransitionError("Recovery Lite is disabled");
  }
  if (state.status === "pending_reflection"
    || (state.status === "completed" && action !== "update_progress")) {
    throw new DailyExecutionTransitionError("This daily execution is already closed");
  }
}

function evaluateSuccess(plan: DailyPlan, actualValue: number): boolean {
  return evaluateHabitCheckin({
    goalType: plan.goalType,
    targetValue: plan.targetValue,
    minimumValue: plan.minimumValue,
    successLimitValue: plan.successLimitValue,
    value: actualValue,
  }).completed;
}

/**
 * The sole transition policy for daily executions. Persistence and eligibility
 * stay in the service; status/progress/timer transitions stay here.
 */
export function transitionDailyExecution(
  plan: DailyPlan,
  state: DailyExecutionState,
  input: DailyActionInput,
  now: Date,
): { updates: Partial<DailyExecutionState>; shouldRecordSuccess: boolean } {
  const action = input.action;
  canChange(state, action);
  if (["start", "pause", "resume"].includes(action) && plan.executionType !== "duration") {
    throw new DailyExecutionTransitionError("Timer actions are only valid for duration executions");
  }
  if (["start", "pause", "resume"].includes(action) && input.value !== undefined) {
    throw new DailyExecutionTransitionError("Timer control actions do not accept a progress value");
  }

  if (action === "start") {
    if (state.lastResumedAt) return { updates: {}, shouldRecordSuccess: false };
    if (state.pausedAt) {
      const pausedSeconds = state.pausedSeconds
        + Math.max(0, Math.floor((now.getTime() - state.pausedAt.getTime()) / 1000));
      const segmentPausedSeconds = state.segmentPausedSeconds
        + Math.max(0, Math.floor((now.getTime() - state.pausedAt.getTime()) / 1000));
      return {
        updates: {
          status: "in_progress",
          pausedSeconds,
          segmentPausedSeconds,
          pausedAt: null,
          lastResumedAt: now,
          finishedAt: null,
        },
        shouldRecordSuccess: false,
      };
    }
    const carriedSeconds = state.startedAt
      ? elapsedSecondsAt(state, now)
      : state.actualSeconds
        ?? (state.actualValue == null ? state.elapsedBaseSeconds : Math.round(state.actualValue * 60));
    return {
      updates: {
        status: "in_progress",
        startedAt: now,
        lastResumedAt: now,
        elapsedBaseSeconds: carriedSeconds,
        segmentPausedSeconds: 0,
        finishedAt: null,
      },
      shouldRecordSuccess: false,
    };
  }

  if (action === "pause") {
    if (!state.lastResumedAt) {
      throw new DailyExecutionTransitionError("Only an active timer can be paused");
    }
    const seconds = elapsedSecondsAt(state, now);
    return {
      updates: {
        status: "paused",
        lastResumedAt: null,
        pausedAt: now,
        actualSeconds: seconds,
        actualValue: seconds / 60,
      },
      shouldRecordSuccess: false,
    };
  }

  if (action === "resume") {
    if (state.status !== "paused" || !state.pausedAt) {
      throw new DailyExecutionTransitionError("Only a paused timer can be resumed");
    }
    const pausedSeconds = state.pausedSeconds
      + Math.max(0, Math.floor((now.getTime() - state.pausedAt.getTime()) / 1000));
    return {
      updates: {
        status: "in_progress",
        pausedAt: null,
        pausedSeconds,
        segmentPausedSeconds: state.segmentPausedSeconds
          + Math.max(0, Math.floor((now.getTime() - state.pausedAt.getTime()) / 1000)),
        lastResumedAt: now,
      },
      shouldRecordSuccess: false,
    };
  }

  if (action === "update_progress") {
    if (state.lastResumedAt || state.pausedAt) {
      throw new DailyExecutionTransitionError("Stop the duration timer before setting manual progress");
    }
    if (input.value === undefined || !Number.isFinite(input.value) || input.value < 0) {
      throw new DailyExecutionTransitionError("A nonnegative progress value is required");
    }
    if (plan.executionType === "boolean" && input.value !== 0 && input.value !== 1) {
      throw new DailyExecutionTransitionError("Boolean progress must be zero or one");
    }
    const seconds = plan.executionType === "duration" ? Math.round(input.value) : null;
    const value = plan.executionType === "duration" ? seconds! / 60 : input.value;
    if (state.status === "completed" && !evaluateSuccess(plan, value)) {
      throw new DailyExecutionTransitionError("A successful daily execution cannot be downgraded");
    }
    return {
      updates: {
        status: state.status === "completed" ? "completed" : dailyProgressStatus(plan, value),
        actualValue: value,
        ...(seconds === null ? {} : { actualSeconds: seconds }),
        ...(seconds === null ? {} : {
          elapsedBaseSeconds: seconds,
          segmentPausedSeconds: 0,
          startedAt: null,
          lastResumedAt: null,
          pausedAt: null,
        }),
        finishedAt: state.status === "completed" ? state.finishedAt : null,
      },
      shouldRecordSuccess: false,
    };
  }

  if (action === "finish" && plan.executionType !== "duration") {
    throw new DailyExecutionTransitionError("Finish is only valid for duration executions");
  }
  if (action === "finish" && input.value !== undefined) {
    throw new DailyExecutionTransitionError("Duration finish is server-timed; omit the client value");
  }
  if (action === "done" && plan.executionType === "duration"
    && input.value !== undefined && (state.lastResumedAt || state.pausedAt)) {
    throw new DailyExecutionTransitionError("Stop the timer before submitting a manual duration value");
  }
  if (action === "done" && plan.executionType === "boolean"
    && input.value !== undefined && input.value !== 1) {
    throw new DailyExecutionTransitionError("Boolean completion must be an affirmative done claim");
  }

  let actualValue: number | null;
  let actualSeconds: number | null = state.actualSeconds;
  let pausedSeconds = state.pausedSeconds;
  let segmentPausedSeconds = state.segmentPausedSeconds;
  if (plan.executionType === "duration") {
    if (input.value !== undefined) {
      actualSeconds = Math.round(input.value);
    } else if (state.startedAt && (state.lastResumedAt || state.pausedAt)) {
      actualSeconds = elapsedSecondsAt(state, now);
    }
    if (actualSeconds == null || actualSeconds < 0) {
      throw new DailyExecutionTransitionError("Record duration progress or start the timer before finishing");
    }
    if (state.pausedAt) {
      const currentPause = Math.max(0, Math.floor((now.getTime() - state.pausedAt.getTime()) / 1000));
      pausedSeconds += currentPause;
      segmentPausedSeconds += currentPause;
    }
    actualValue = actualSeconds / 60;
  } else if (plan.executionType === "boolean") {
    actualValue = 1;
    actualSeconds = null;
  } else {
    actualValue = input.value ?? state.actualValue;
    if (actualValue == null || !Number.isFinite(actualValue) || actualValue < 0) {
      throw new DailyExecutionTransitionError("Record an actual value before claiming completion");
    }
  }

  const success = evaluateSuccess(plan, actualValue);
  const status = success
    ? action === "done"
      ? "pending_reflection"
      : dailyProgressStatus(plan, actualValue)
    : dailyProgressStatus(plan, actualValue);
  return {
    updates: {
      status,
      actualValue,
      actualSeconds,
      pausedSeconds,
      segmentPausedSeconds,
      ...(plan.executionType === "duration" && input.value !== undefined && actualSeconds != null
        ? {
            elapsedBaseSeconds: actualSeconds,
            segmentPausedSeconds: 0,
            startedAt: null,
            lastResumedAt: null,
            pausedAt: null,
          }
        : {}),
      lastResumedAt: null,
      pausedAt: null,
      finishedAt: now,
    },
    shouldRecordSuccess: success,
  };
}
