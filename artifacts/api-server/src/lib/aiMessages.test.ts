import assert from "node:assert/strict";
import { test } from "node:test";
import type { AiTextProvider } from "./aiProvider";
import {
  breakdownGoalMessages,
  checkinFeedbackMessage,
  dailyInsightMessage,
  relapseRecoveryMessages,
} from "./aiMessages";
import {
  checkinTone, goalMilestones, phraseMilestones, recoveryTarget,
  checkinsForPlanRevision, defaultMinimumFloor, evaluateHabitCheckin, missedScheduledDays,
  proposeHabitAdaptation, buildHabitTargets,
} from "./aiRules";
import { habitAdaptationMessages, habitBuilderText } from "./aiMessages";
import { makeHabitBuilderPlan } from "./habitBuilder";
import { addCalendarDays, isScheduledDate, makeJourneyDays } from "./habitJourney";
import { suggestedJourneyStartDate } from "./dates";
import { validateHabitPlanUpdate } from "./aiRules";
import { UpdateHabitBody } from "../../../../lib/api-zod/src/generated/api";

test("build success boundaries and quit limits are evaluated by the deterministic rules", () => {
  const shared = { goalType: "build" as const, targetValue: 10, minimumValue: 4 };
  assert.deepEqual(evaluateHabitCheckin({ ...shared, value: 3.99 }), { completed: false, targetCompleted: false });
  assert.deepEqual(evaluateHabitCheckin({ ...shared, value: 4 }), { completed: true, targetCompleted: false });
  assert.deepEqual(evaluateHabitCheckin({ ...shared, value: 10 }), { completed: true, targetCompleted: true });
  assert.deepEqual(evaluateHabitCheckin({
    goalType: "quit", targetValue: 10, successLimitValue: 2, value: 2,
  }), { completed: true, targetCompleted: true });
  assert.deepEqual(evaluateHabitCheckin({
    goalType: "quit", targetValue: 5, successLimitValue: 3, value: 4,
  }), { completed: false, targetCompleted: true });
  assert.deepEqual(evaluateHabitCheckin({
    goalType: "quit", targetValue: 5, successLimitValue: 3, value: 3,
  }), { completed: true, targetCompleted: true });
  assert.equal(evaluateHabitCheckin({
    goalType: "quit", targetValue: 10, value: 0, legacyCompleted: true,
  }).completed, true);
});

test("missed-day totals honor cadence and adaptation proposals have bounded floors/caps", () => {
  assert.equal(missedScheduledDays("daily", null, ["2025-01-01"], "2025-01-05"), 3);
  assert.equal(missedScheduledDays("weekdays", null, ["2025-01-03"], "2025-01-07"), 1);
  assert.equal(missedScheduledDays("custom_days", [1, 3, 5], ["2025-01-03"], "2025-01-07"), 1);
  assert.equal(missedScheduledDays("daily", null, ["2025-01-01", "2025-01-04"], "2025-01-06"), 3);
  assert.equal(missedScheduledDays("daily", null, [], "2025-01-05", "2025-01-01"), 4);
  assert.ok(missedScheduledDays("daily", null, ["2024-01-01"], "2025-01-01") <= 90);
  const easier = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: Array.from({ length: 2 }, () => ({ difficulty: "hard", missedReason: null, completed: true })),
  });
  assert.deepEqual(easier, { reason: "repeated_hard", missedReason: null, targetValue: 8, minimumValue: 4, successLimitValue: null, busyDayValue: null });
  const easy = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 4,
    checkins: Array.from({ length: 3 }, () => ({ difficulty: "easy", missedReason: null, completed: true })),
  });
  assert.deepEqual(easy, { reason: "repeated_easy", missedReason: null, targetValue: 11, minimumValue: 5, successLimitValue: null, busyDayValue: null });
  const smallEasyMajority = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: [
      { difficulty: "easy", missedReason: null, completed: true },
      { difficulty: "easy", missedReason: null, completed: true },
      { difficulty: "normal", missedReason: null, completed: true },
    ],
  });
  assert.equal(smallEasyMajority.targetValue, 11);
  const noEasyMajority = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: [
      { difficulty: "easy", missedReason: null, completed: true },
      { difficulty: "normal", missedReason: null, completed: true },
      { difficulty: "normal", missedReason: null, completed: true },
    ],
  });
  assert.equal(noEasyMajority.targetValue, 10);
  for (const missedReason of ["no_time", "forgot", "lost_motivation", "unexpected"] as const) {
    const suggestion = proposeHabitAdaptation({
      targetValue: 10, minimumValue: 5,
      checkins: [{ difficulty: null, missedReason, completed: false }],
    });
    assert.equal(suggestion.reason, "missed_reasons");
    assert.equal(suggestion.missedReason, missedReason);
    assert.equal(suggestion.targetValue, 10);
    assert.equal(suggestion.minimumValue, 5);
  }
  const oneTooDifficult = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: [{ difficulty: null, missedReason: "too_difficult", completed: false }],
  });
  assert.equal(oneTooDifficult.targetValue, 10);
  const repeatedTooDifficult = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: Array.from({ length: 2 }, () => ({ difficulty: null, missedReason: "too_difficult" as const, completed: false })),
  });
  assert.equal(repeatedTooDifficult.targetValue, 8);
  for (const difficulty of ["hard", "very_hard"]) {
    const singleHard = proposeHabitAdaptation({
      targetValue: 10, minimumValue: 5,
      checkins: [{ difficulty, missedReason: null, completed: false }],
    });
    assert.equal(singleHard.targetValue, 10);
  }
  const mixedHard = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: [
      { difficulty: "hard", missedReason: null, completed: false },
      { difficulty: "normal", missedReason: null, completed: true },
      { difficulty: "easy", missedReason: null, completed: true },
    ],
  });
  assert.equal(mixedHard.targetValue, 10);
  const priorRevisionEasy = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: Array.from({ length: 12 }, () => ({ difficulty: "easy", missedReason: null, completed: true })),
    numericCheckins: [],
  });
  assert.equal(priorRevisionEasy.targetValue, 10);
  assert.deepEqual(checkinsForPlanRevision(
    [{ date: "2025-01-01" }, { date: "2025-01-02" }],
    [
      { date: "2025-01-01", planRevision: 1 },
      { date: "2025-01-02", planRevision: 2 },
    ],
    2,
  ), [{ date: "2025-01-02" }]);
  const noTime = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: Array.from({ length: 2 }, () => ({ difficulty: null, missedReason: "no_time" as const, completed: false })),
  });
  assert.deepEqual(noTime, {
    reason: "missed_reasons", missedReason: "no_time", targetValue: 10, minimumValue: 5, busyDayValue: 3,
    successLimitValue: null,
  });
  const forgot = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: [{ difficulty: null, missedReason: "forgot" as const, completed: false }],
  });
  assert.equal(forgot.targetValue, 10);
  assert.equal(forgot.minimumValue, 5);
  assert.equal(forgot.missedReason, "forgot");
  const unexpected = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: [{ difficulty: null, missedReason: "unexpected" as const, completed: false }],
  });
  assert.equal(unexpected.targetValue, 10);
  assert.equal(unexpected.minimumValue, 5);
  assert.deepEqual(buildHabitTargets(60), { targetValue: 10, minimumValue: 5, busyDayValue: 3 });
  assert.deepEqual(buildHabitTargets(1), { targetValue: 1, minimumValue: 1, busyDayValue: 1 });
});

test("reduce adaptation progresses its allowed limit carefully and never crosses its target", () => {
  const easy = proposeHabitAdaptation({
    goalType: "quit", targetValue: 5, successLimitValue: 20, baselineValue: 60,
    minimumValue: 5, minimumFloor: 0,
    checkins: Array.from({ length: 5 }, () => ({ difficulty: "easy", missedReason: null, completed: true })),
  });
  assert.equal(easy.targetValue, 5);
  assert.equal(easy.successLimitValue, 18);
  const hard = proposeHabitAdaptation({
    goalType: "quit", targetValue: 5, successLimitValue: 20, baselineValue: 60,
    minimumValue: 5, minimumFloor: 0,
    checkins: Array.from({ length: 3 }, () => ({ difficulty: "hard", missedReason: null, completed: false })),
  });
  assert.equal(hard.successLimitValue, 30);
  assert.ok(hard.successLimitValue! >= hard.targetValue);
  const veryHard = proposeHabitAdaptation({
    goalType: "quit", targetValue: 5, successLimitValue: 20, baselineValue: 60,
    minimumValue: 5, minimumFloor: 0,
    checkins: Array.from({ length: 2 }, () => ({ difficulty: "very_hard", missedReason: null, completed: false })),
  });
  assert.equal(veryHard.successLimitValue, 40);
  const strongBuildReduction = proposeHabitAdaptation({
    goalType: "build", targetValue: 10, minimumValue: 4, minimumFloor: 1,
    busyDayValue: 3,
    checkins: Array.from({ length: 2 }, () => ({ difficulty: "very_hard", missedReason: null, completed: false })),
  });
  assert.equal(strongBuildReduction.targetValue, 5);
  assert.equal(strongBuildReduction.minimumValue, 2);
  assert.equal(strongBuildReduction.busyDayValue, 2);
  const noHistory = proposeHabitAdaptation({
    goalType: "quit", targetValue: 0, successLimitValue: 0, baselineValue: 0,
    minimumFloor: 0, checkins: [],
  });
  assert.equal(noHistory.successLimitValue, 0);
  assert.equal(noHistory.targetValue, 0);
});

test("reduce target progresses in bounded steps after its success limit settles at target", () => {
  const easyScheduledDays = Array.from({ length: 3 }, () => ({
    difficulty: "easy", missedReason: null, completed: true,
  }));
  const first = proposeHabitAdaptation({
    goalType: "quit", targetValue: 160, minimumValue: 160, successLimitValue: 160,
    baselineValue: 200, checkins: easyScheduledDays,
  });
  assert.equal(first.targetValue, 140);
  assert.equal(first.minimumValue, 140);
  assert.equal(first.successLimitValue, 160);
  assert.ok(first.successLimitValue! >= first.targetValue);
  const second = proposeHabitAdaptation({
    goalType: "quit", targetValue: 140, minimumValue: 140, successLimitValue: 140,
    baselineValue: 200, checkins: easyScheduledDays,
  });
  assert.equal(second.targetValue, 120);
  assert.equal(second.minimumValue, 120);
  assert.equal(second.successLimitValue, 140);

  const explicitFloor = proposeHabitAdaptation({
    goalType: "quit", targetValue: 140, minimumValue: 140, successLimitValue: 140,
    baselineValue: 200, minimumFloor: 130, checkins: easyScheduledDays,
  });
  assert.equal(explicitFloor.targetValue, 130);
  assert.equal(defaultMinimumFloor("quit"), 0);
  assert.equal(defaultMinimumFloor("quit", 130), 130);
  assert.equal(defaultMinimumFloor("build"), 1);
});

test("frontend build and reduce acceptance payloads use guards as comparisons, not required updates", () => {
  const buildPayload = UpdateHabitBody.safeParse({
    targetValue: 12,
    minimumValue: 6,
    expectedTargetValue: 10,
    expectedMinimumValue: 5,
    expectedSuccessLimitValue: null,
  });
  assert.equal(buildPayload.success, true);
  if (!buildPayload.success) return;
  const {
    expectedTargetValue, expectedMinimumValue, expectedSuccessLimitValue, ...buildChanges
  } = buildPayload.data;
  assert.equal(validateHabitPlanUpdate({
    expectedTargetValue, expectedMinimumValue, expectedSuccessLimitValue,
  }, { targetValue: 10, minimumValue: 5, successLimitValue: null }, Object.keys(buildChanges).length > 0), null);

  const quitPayload = UpdateHabitBody.safeParse({
    successLimitValue: 7,
    expectedTargetValue: 5,
    expectedMinimumValue: 5,
    expectedSuccessLimitValue: 10,
  });
  assert.equal(quitPayload.success, true);
  if (!quitPayload.success) return;
  const {
    expectedTargetValue: quitExpectedTarget,
    expectedMinimumValue: quitExpectedMinimum,
    expectedSuccessLimitValue: quitExpectedLimit,
    ...quitChanges
  } = quitPayload.data;
  assert.equal(validateHabitPlanUpdate({
    expectedTargetValue: quitExpectedTarget,
    expectedMinimumValue: quitExpectedMinimum,
    expectedSuccessLimitValue: quitExpectedLimit,
  }, { targetValue: 5, minimumValue: 5, successLimitValue: 10 }, Object.keys(quitChanges).length > 0), null);

  assert.equal(validateHabitPlanUpdate({
    expectedTargetValue: 9,
  }, { targetValue: 10, minimumValue: 5, successLimitValue: null }, true), "conflict");
  assert.equal(validateHabitPlanUpdate({
    expectedTargetValue: 10,
  }, { targetValue: 10, minimumValue: 5, successLimitValue: null }, false), "empty");
});

test("habit builder uses safe deterministic fallback for common Arabic/English goals and never invents reduce baselines", () => {
  const read = makeHabitBuilderPlan({ intent: "Read one hour", requestedDuration: 60, unit: "pages" });
  assert.equal(read.category, "learning");
  assert.equal(read.unit, "minutes");
  assert.equal(read.targetValue, 10);
  assert.equal(makeHabitBuilderPlan({
    intent: "Read", requestedDuration: 30, unit: "minutes", friction: "phone distractions",
  }).frictionTip, "أبعد الهاتف عن مكان تنفيذ الخطوة لتقليل التشتيت.");
  const exercise = makeHabitBuilderPlan({ intent: "تمرين رياضي", requestedDuration: 30, unit: "count" });
  assert.equal(exercise.category, "health");
  const water = makeHabitBuilderPlan({ intent: "شرب الماء 8 أكواب", requestedDuration: 8, unit: "minutes" });
  assert.equal(water.category, "health");
  assert.equal(water.unit, "count");
  const sleep = makeHabitBuilderPlan({ intent: "sleep earlier", requestedDuration: 30, unit: "minutes" });
  assert.equal(sleep.category, "health");
  const study = makeHabitBuilderPlan({ intent: "Study every day", requestedDuration: 30, unit: "minutes" });
  assert.equal(study.category, "learning");
  const reduction = makeHabitBuilderPlan({ intent: "Reduce TikTok", requestedDuration: 60, unit: "minutes" });
  assert.equal(reduction.goalType, "quit");
  assert.equal(reduction.baselineValue, null);
  assert.equal(reduction.needsBaseline, true);
  assert.equal(reduction.targetValue, 0);
  const hintedOnly = makeHabitBuilderPlan({
    intent: "Reduce screen use", requestedDuration: 60, unit: "minutes", goalType: "quit",
    trackingContext: { category: "productivity", unit: "minutes" },
  });
  assert.equal(hintedOnly.needsBaseline, true);
  const serverTracked = makeHabitBuilderPlan({
    intent: "Reduce TikTok", requestedDuration: 60, unit: "minutes",
  }, 80);
  assert.equal(serverTracked.baselineValue, 80);
  assert.equal(serverTracked.needsBaseline, false);
  const confirmed = makeHabitBuilderPlan({
    intent: "Reduce TikTok", requestedDuration: 60, unit: "minutes", baselineValue: 90,
  });
  assert.equal(confirmed.baselineValue, 90);
  assert.equal(confirmed.targetValue, 67);
  assert.equal(confirmed.successLimitValue, 81);
  assert.equal(confirmed.minimumFloor, 0);
  assert.equal(makeHabitBuilderPlan({
    intent: "Read after coffee at 8:00 pm", requestedDuration: 30, unit: "minutes",
  }).cueTime, "20:00");
  assert.equal(makeHabitBuilderPlan({
    intent: "Read after coffee", requestedDuration: 30, unit: "minutes",
  }).cue, "after coffee");
  assert.equal(makeHabitBuilderPlan({
    intent: "Read", requestedDuration: 30, unit: "minutes",
  }).cue, null);
});

test("builder AI accepts only safe structured interpretation and falls back on malformed/rate limited output", async () => {
  const provider: AiTextProvider = {
    async generateText(_system, _context, json) {
      assert.equal(json, true);
      return JSON.stringify({
        title: "قراءة", category: "learning", understoodGoal: "قراءة يومية",
        reason: "اقتراح يساعد على بناء عادة قراءة.", frictionTip: "أبعد الهاتف عن مكان تنفيذ الخطوة.",
      });
    },
  };
  const text = await habitBuilderText({
    intent: "read", fallbackTitle: "read", fallbackCategory: "custom", goalType: "build",
    friction: "الهاتف يشتتني", fallbackFrictionTip: "أبعد الهاتف عن مكان تنفيذ الخطوة.",
  }, provider);
  assert.equal(text?.category, "learning");
  assert.equal(text?.frictionTip, "أبعد الهاتف عن مكان تنفيذ الخطوة.");
  const inventedTipProvider: AiTextProvider = {
    async generateText() {
      return JSON.stringify({
        title: "قراءة", category: "learning", understoodGoal: "قراءة يومية",
        reason: "اقتراح يساعد على بناء عادة قراءة.", frictionTip: "أبعد الهاتف بعد عشر دقائق.",
      });
    },
  };
  assert.equal(await habitBuilderText({
    intent: "read", fallbackTitle: "read", fallbackCategory: "learning", goalType: "build",
    friction: "الهاتف يشتتني", fallbackFrictionTip: "أبعد الهاتف عن مكان تنفيذ الخطوة.",
  }, inventedTipProvider), null);
  const malformed: AiTextProvider = { async generateText() { return "{bad json"; } };
  assert.equal(await habitBuilderText({
    intent: "read", fallbackTitle: "read", fallbackCategory: "learning", goalType: "build",
  }, malformed), null);
  const limited: AiTextProvider = { async generateText() { throw new Error("429"); } };
  assert.equal(await habitBuilderText({
    intent: "read", fallbackTitle: "read", fallbackCategory: "learning", goalType: "build",
  }, limited), null);
});

test("22-day calendar journey includes cadence rest days without scheduling them", () => {
  const days = makeJourneyDays(7, "2025-01-01", 22, {
    targetValue: 10, minimumValue: 5, busyDayValue: 2, successLimitValue: null,
    goalType: "build", planRevision: 1, cadence: "weekdays", customDays: null,
  });
  assert.equal(days.length, 22);
  assert.equal(days[0].date, "2025-01-01");
  assert.equal(days[0].scheduled, true);
  assert.equal(days[3].date, "2025-01-04");
  assert.equal(days[3].scheduled, false);
  assert.equal(addCalendarDays("2025-01-01", 21), days[21].date);
  assert.equal(isScheduledDate("2025-01-05", 5, "custom_days", [0]), true);
  const customDays = makeJourneyDays(8, "2025-01-01", 22, {
    targetValue: 5, minimumValue: 2, busyDayValue: null, successLimitValue: null,
    goalType: "build", planRevision: 1, cadence: "custom_days", customDays: [1, 3],
  });
  assert.ok(customDays.every((day) => day.scheduled
    === [1, 3].includes(new Date(`${day.date}T00:00:00Z`).getUTCDay())));
});

test("server-suggested journey start respects the saved timezone and 21:00 cutoff", () => {
  assert.equal(suggestedJourneyStartDate("America/New_York", new Date("2025-01-02T01:59:00Z")), "2025-01-01");
  assert.equal(suggestedJourneyStartDate("America/New_York", new Date("2025-01-02T02:00:00Z")), "2025-01-02");
  assert.equal(suggestedJourneyStartDate("UTC", new Date("2025-02-01T20:59:00Z")), "2025-02-01");
  assert.equal(suggestedJourneyStartDate("UTC", new Date("2025-02-01T21:00:00Z")), "2025-02-02");
});

test("adaptive phrasing accepts only the structured no-number schema and safely falls back", async () => {
  const valid = {
    headline: "تعديل مقترح", explanation: "الهدف الحالي قابل للتحسين.",
    next_step: "جرّب خيارًا أقصر.", encouragement: "التقدم خطوة خطوة.",
  };
  const provider: AiTextProvider = {
    async generateText(system, _context, json) {
      assert.match(system, /لا تخترع أو تذكر أي أرقام/);
      assert.equal(json, true);
      return JSON.stringify(valid);
    },
  };
  assert.deepEqual(await habitAdaptationMessages({
    reason: "missed_reasons", missedReason: "no_time", changedTarget: false,
    changedMinimum: false, hasBusyDayOption: true,
  }, provider), valid);
  const invalidProvider: AiTextProvider = {
    async generateText() { return JSON.stringify({ ...valid, next_step: "اجعل الهدف 5 دقائق." }); },
  };
  const fallback = await habitAdaptationMessages({
    reason: "missed_reasons", missedReason: "no_time", changedTarget: false,
    changedMinimum: false, hasBusyDayOption: true,
  }, invalidProvider);
  assert.match(fallback.next_step, /النسخة الأقصر/);
  const forgotFallback = await habitAdaptationMessages({
    reason: "missed_reasons", missedReason: "forgot", changedTarget: false,
    changedMinimum: false, hasBusyDayOption: false,
  }, invalidProvider);
  assert.match(forgotFallback.next_step, /وقت ثابت/);
});

test("milestone numbers and order remain rule-owned when the phrasing provider changes", async () => {
  const steps = goalMilestones(13);
  assert.deepEqual(steps, [
    { targetValue: 3, order: 1 },
    { targetValue: 7, order: 2 },
    { targetValue: 10, order: 3 },
    { targetValue: 13, order: 4 },
  ]);
  const input = { title: "المشي", category: "health", goalType: "count", difficulty: "easy", unit: "خطوة" };
  let calls = 0;
  const provider: AiTextProvider = {
    async generateText(system, context, json) {
      calls++;
      assert.match(system, /لا تغيّرها/);
      assert.equal(json, true);
      assert.deepEqual(context, { ...input, steps });
      return JSON.stringify({
        steps: steps.map((_, i) => ({ title: `عنوان ${i}`, description: "وصف مشجع" })),
        coachMessage: "هيا نبدأ!",
      });
    },
  };
  const messages = await breakdownGoalMessages(input, steps, provider);
  assert.equal(calls, 1);
  assert.equal(messages.stepTexts[0].title, "عنوان 0");
  const responseMilestones = phraseMilestones(steps, messages.stepTexts);
  assert.deepEqual(responseMilestones.map(({ targetValue, order }) => ({ targetValue, order })), steps);
});

test("check-in tone is selected by rules and sent unchanged to alternate providers", async () => {
  for (const [completed, streak, expected] of [
    [false, 7, "supportive"],
    [true, 0, "encouraging"],
    [true, 2, "encouraging"],
    [true, 3, "celebratory"],
    [true, 7, "celebratory"],
  ] as const) {
    const tone = checkinTone(completed, streak);
    assert.equal(tone, expected);
    const provider: AiTextProvider = {
      async generateText(system, context, json) {
        assert.match(system, new RegExp(`"${expected}"`));
        assert.deepEqual(context, { habitTitle: "المشي", completed, streak, tone });
        assert.equal(json, undefined);
        return "رد قصير";
      },
    };
    assert.equal(await checkinFeedbackMessage({ habitTitle: "المشي", completed, streak, tone }, provider), "رد قصير");
    assert.equal(tone, expected);
  }
});

test("recovery target and daily insight metrics stay rule-owned across providers", async () => {
  assert.equal(recoveryTarget(13), 7);
  assert.equal(recoveryTarget(1), 1);
  const provider: AiTextProvider = {
    async generateText(system, context, json) {
      if (json) {
        assert.equal((context as { suggestedTargetValue: number }).suggestedTargetValue, 7);
        assert.match(system, /لا تغيّر الرقم/);
        return '{"message":"ابدأ بهدوء","encouragement":"يمكنك المحاولة"}';
      }
      assert.deepEqual(context, {
        displayName: "مستخدم", trend: "up", highlightMetric: "4 تسجيلات مكتملة هذا الأسبوع",
        completionRateThisWeek: 4, completionRatePrevWeek: 2,
      });
      assert.match(system, /دون اختلاق أرقام جديدة/);
      return "تقدم جيد";
    },
  };
  const recovery = await relapseRecoveryMessages({
    habitTitle: "المشي", missedDays: 3, suggestedTargetValue: recoveryTarget(13), unit: "دقيقة",
  }, provider);
  assert.equal(recovery.message, "ابدأ بهدوء");
  assert.equal(await dailyInsightMessage({
    displayName: "مستخدم", trend: "up", highlightMetric: "4 تسجيلات مكتملة هذا الأسبوع",
    completionRateThisWeek: 4, completionRatePrevWeek: 2,
  }, provider), "تقدم جيد");
});

test("invalid JSON from a replacement provider falls back without changing target facts", async () => {
  const provider: AiTextProvider = { async generateText() { return '{"steps":[]}'; } };
  const steps = goalMilestones(8);
  const result = await breakdownGoalMessages(
    { title: "المشي", category: "health", goalType: "count", difficulty: "easy", unit: "دقيقة" },
    steps, provider,
  );
  assert.match(result.stepTexts[0].description, /2 دقيقة/);
  assert.equal(result.stepTexts.length, steps.length);
});