import assert from "node:assert/strict";
import { test } from "node:test";
import { addCalendarDays } from "./habitJourney";
import { evaluateJourneyLifecycle } from "./journeyLifecycle";

test("journey completion uses one real final scheduled success, not 22 successful sessions", () => {
  const startDate = "2026-09-01";
  const finalDate = addCalendarDays(startDate, 21);
  const lifecycle = evaluateJourneyLifecycle({
    startDate,
    length: 22,
    today: finalDate,
    scheduledDates: [startDate, finalDate],
    successfulDates: new Set([finalDate]),
    completedAt: null,
  });
  assert.equal(lifecycle.status, "completed");
  assert.equal(lifecycle.finalEligibility.eligible, true);
  assert.equal(lifecycle.finalEligibility.finalScheduledDate, finalDate);
  assert.equal(lifecycle.shouldCommitCompletion, true);
});

test("final-day rest uses the last scheduled date but still waits for calendar day 22", () => {
  const startDate = "2026-09-05"; // Saturday; day 22 is Saturday for a weekdays snapshot
  const endDate = addCalendarDays(startDate, 21);
  const lastScheduledDate = "2026-09-25"; // Friday is the final scheduled date; day 22 remains a rest day
  const beforeDay22 = evaluateJourneyLifecycle({
    startDate,
    length: 22,
    today: addCalendarDays(startDate, 19),
    scheduledDates: [lastScheduledDate],
    successfulDates: new Set([lastScheduledDate]),
    completedAt: null,
  });
  assert.equal(beforeDay22.status, "active");
  assert.equal(beforeDay22.finalEligibility.unmetReason, "calendar_days_remaining");
  assert.equal(beforeDay22.shouldCommitCompletion, false);

  const atDay22 = evaluateJourneyLifecycle({
    startDate,
    length: 22,
    today: endDate,
    scheduledDates: [lastScheduledDate],
    successfulDates: new Set([lastScheduledDate]),
    completedAt: null,
  });
  assert.equal(atDay22.status, "completed");
  assert.equal(atDay22.finalEligibility.finalScheduledDate, lastScheduledDate);

  const missedFinalOpportunity = evaluateJourneyLifecycle({
    startDate,
    length: 22,
    today: endDate,
    scheduledDates: [lastScheduledDate],
    successfulDates: new Set(),
    completedAt: null,
  });
  assert.equal(missedFinalOpportunity.status, "expired",
    "a rest terminal day cannot leave an already-impossible final opportunity active");
});

test("missing final success expires after the 22-calendar-day window and completion is immutable", () => {
  const startDate = "2026-08-01";
  const endDate = addCalendarDays(startDate, 21);
  const expired = evaluateJourneyLifecycle({
    startDate,
    length: 22,
    today: addCalendarDays(endDate, 1),
    scheduledDates: [endDate],
    successfulDates: new Set(),
    completedAt: null,
  });
  assert.equal(expired.status, "expired");
  assert.equal(expired.finalEligibility.eligible, false);
  assert.equal(expired.finalEligibility.unmetReason, "final_scheduled_day_not_successful");

  const committedAt = new Date("2026-08-30T12:00:00.000Z");
  const completed = evaluateJourneyLifecycle({
    startDate,
    length: 22,
    today: addCalendarDays(endDate, 10),
    scheduledDates: [endDate],
    successfulDates: new Set([endDate]),
    completedAt: committedAt,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.shouldCommitCompletion, false);
  assert.equal(completed.completedAt, committedAt);
});

test("legacy and not-yet-started habits cannot qualify for a journey completion", () => {
  const legacy = evaluateJourneyLifecycle({
    startDate: null,
    length: null,
    today: "2026-10-01",
    scheduledDates: [],
    successfulDates: new Set(),
    completedAt: null,
  });
  assert.equal(legacy.status, "not_started");
  assert.equal(legacy.finalEligibility.unmetReason, "journey_not_started");

  const future = evaluateJourneyLifecycle({
    startDate: "2026-10-02",
    length: 22,
    today: "2026-10-01",
    scheduledDates: ["2026-10-02"],
    successfulDates: new Set(["2026-10-02"]),
    completedAt: null,
  });
  assert.equal(future.status, "not_started");
  assert.equal(future.shouldCommitCompletion, false);
});