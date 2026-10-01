import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseDashboardMissed,
  dashboardGreeting,
  dashboardState,
  orderDashboardFocus,
} from "./dashboardRules";

test("dashboard greeting uses the user's own IANA timezone", () => {
  assert.equal(dashboardGreeting("Asia/Riyadh", new Date("2025-06-12T08:59:00Z")), "morning");
  assert.equal(dashboardGreeting("Asia/Riyadh", new Date("2025-06-12T09:00:00Z")), "evening");
  assert.equal(dashboardGreeting("America/Los_Angeles", new Date("2025-06-12T08:00:00Z")), "night");
});

test("focus is deterministic: running, paused, incomplete, then earliest created/id", () => {
  const createdAt = new Date("2025-01-01T00:00:00Z");
  const candidate = (id: number, status: string, resumed = false) => ({
    habit: { id, createdAt },
    execution: { scheduled: true, status, lastResumedAt: resumed ? createdAt : null },
  });
  const list = [
    candidate(1, "completed"),
    candidate(2, "pending"),
    candidate(4, "paused"),
    candidate(5, "in_progress", true),
    candidate(3, "pending"),
  ];
  assert.deepEqual(orderDashboardFocus(list).map((item) => item.habit.id), [5, 4, 2, 3, 1]);
});

test("missed-day precedence chooses latest known unresolved date and stable habit tie-break", () => {
  const missed = (id: number, date: string, decision: string | null = null) => ({
    habit: { id },
    execution: {
      date, scheduled: true, status: "missed", missedReason: null, adaptationDecision: decision,
    },
  });
  assert.equal(chooseDashboardMissed([
    missed(9, "2025-05-01"),
    missed(8, "2025-05-03"),
    missed(2, "2025-05-03"),
    missed(1, "2025-05-04", "accepted"),
  ])?.habit.id, 2);
});

test("major dashboard state precedence keeps reflection and current action ahead of context", () => {
  const common = {
    journeyCompleted: true,
    hasHabits: true,
    onboardingCompleted: true,
    trackingStatus: "active",
    hasAnalysis: true,
    hasTrackedData: true,
  };
  assert.equal(dashboardState({
    ...common,
    journeyCompleted: false,
    missedDay: {
      habit: { id: 1 },
      execution: {
        date: "2025-05-01", scheduled: true, status: "missed",
        missedReason: "no_time", adaptationDecision: null,
      },
    },
    focusExecution: { status: "target_reached" },
  }), "adaptation_required");
  assert.equal(dashboardState({
    ...common,
    missedDay: {
      habit: { id: 1 },
      execution: {
        date: "2025-05-01", scheduled: true, status: "missed",
        missedReason: "no_time", adaptationDecision: null,
      },
    },
    focusExecution: {
      status: "pending_reflection",
      executionType: "count",
      goalType: "build",
      targetValue: 10,
      minimumValue: 5,
      actualValue: 10,
      checkin: { completed: true },
    },
  }), "journey_complete");
  assert.equal(dashboardState({ ...common, missedDay: null, focusExecution: { status: "minimum_reached" } }), "minimum_reached");
  assert.equal(dashboardState({
    ...common,
    journeyCompleted: false,
    missedDay: null,
    focusExecution: {
      status: "pending_reflection",
      executionType: "count",
      goalType: "build",
      targetValue: 10,
      minimumValue: 5,
      actualValue: 5,
      checkin: { completed: true },
    },
  }), "minimum_reached", "a paid minimum remains distinguishable from the target while reflection is pending");
  assert.equal(dashboardState({
    ...common,
    journeyCompleted: false,
    missedDay: null,
    focusExecution: {
      status: "pending_reflection",
      executionType: "count",
      goalType: "build",
      targetValue: 10,
      minimumValue: 5,
      actualValue: 10,
      checkin: { completed: true },
    },
  }), "target_complete");
  assert.equal(dashboardState({
    ...common,
    journeyCompleted: false,
    missedDay: null,
    focusExecution: {
      status: "completed",
      executionType: "duration",
      goalType: "build",
      targetValue: 10,
      minimumValue: 5,
      actualValue: 5,
      checkin: { completed: true },
    },
  }), "minimum_reached", "reflection completion cannot turn paid-minimum activity into target completion");
  assert.equal(dashboardState({
    ...common,
    journeyCompleted: false,
    missedDay: null,
    focusExecution: { status: "target_reached", executionType: "boolean", goalType: "build" },
  }), "habit_in_progress", "a Boolean target requires an affirmative paid check-in");
  assert.equal(dashboardState({
    ...common,
    journeyCompleted: false,
    missedDay: null,
    focusExecution: {
      status: "pending_reflection", executionType: "limit", goalType: "quit",
      checkin: { completed: true },
    },
  }), "target_complete");
  assert.equal(dashboardState({
    ...common, journeyCompleted: false, missedDay: null, focusExecution: { status: "target_reached" },
  }), "target_complete");
  assert.equal(dashboardState({ ...common, missedDay: null, focusExecution: null }), "journey_complete");
  assert.equal(dashboardState({ ...common, missedDay: null, focusExecution: { status: "in_progress" } }), "habit_in_progress");
  assert.equal(dashboardState({ ...common, missedDay: null, focusExecution: { status: "pending" } }), "habit_not_started");
  assert.equal(dashboardState({
    ...common, missedDay: null, focusExecution: null, journeyCompleted: false,
  }), "tracking_active");
  assert.equal(dashboardState({
    ...common, missedDay: null, focusExecution: null, journeyCompleted: false, trackingStatus: "paused",
  }), "tracking_paused");
  assert.equal(dashboardState({
    ...common, missedDay: null, focusExecution: null, journeyCompleted: false, trackingStatus: null,
  }), "analysis_available");
  assert.equal(dashboardState({
    ...common, missedDay: null, focusExecution: null, journeyCompleted: false, hasHabits: false,
    onboardingCompleted: false,
  }), "new_user");
  assert.equal(dashboardState({
    ...common, missedDay: null, focusExecution: null, journeyCompleted: false, hasHabits: false,
  }), "no_habit");
  assert.equal(dashboardState({
    ...common, missedDay: null, focusExecution: null, journeyCompleted: false,
    trackingStatus: null, hasAnalysis: false, hasTrackedData: false,
  }), "rest_day");
});
