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
  evaluateHabitCheckin, missedScheduledDays, proposeHabitAdaptation, buildHabitTargets,
} from "./aiRules";
import { habitAdaptationMessages } from "./aiMessages";

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
    checkins: Array.from({ length: 3 }, () => ({ difficulty: "hard", missedReason: null, completed: true })),
  });
  assert.deepEqual(easier, { reason: "repeated_hard", missedReason: null, targetValue: 8, minimumValue: 4, busyDayValue: null });
  const easy = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 4,
    checkins: Array.from({ length: 5 }, () => ({ difficulty: "easy", missedReason: null, completed: true })),
  });
  assert.deepEqual(easy, { reason: "repeated_easy", missedReason: null, targetValue: 11, minimumValue: 5, busyDayValue: null });
  for (const missedReason of ["too_difficult", "no_time", "forgot", "lost_motivation", "unexpected"] as const) {
    const suggestion = proposeHabitAdaptation({
      targetValue: 10, minimumValue: 5,
      checkins: Array.from({ length: 2 }, () => ({ difficulty: null, missedReason, completed: false })),
    });
    assert.equal(suggestion.reason, "missed_reasons");
    assert.ok(suggestion.targetValue > 0 && suggestion.targetValue <= 10);
    assert.ok(suggestion.minimumValue > 0 && suggestion.minimumValue <= suggestion.targetValue);
  }
  const noTime = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: Array.from({ length: 2 }, () => ({ difficulty: null, missedReason: "no_time" as const, completed: false })),
  });
  assert.deepEqual(noTime, {
    reason: "missed_reasons", missedReason: "no_time", targetValue: 10, minimumValue: 5, busyDayValue: 3,
  });
  const forgot = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: Array.from({ length: 2 }, () => ({ difficulty: null, missedReason: "forgot" as const, completed: false })),
  });
  assert.equal(forgot.targetValue, 10);
  assert.equal(forgot.minimumValue, 5);
  assert.equal(forgot.missedReason, "forgot");
  const unexpected = proposeHabitAdaptation({
    targetValue: 10, minimumValue: 5,
    checkins: Array.from({ length: 2 }, () => ({ difficulty: null, missedReason: "unexpected" as const, completed: false })),
  });
  assert.equal(unexpected.targetValue, 10);
  assert.equal(unexpected.minimumValue, 5);
  assert.deepEqual(buildHabitTargets(60), { targetValue: 10, minimumValue: 5, busyDayValue: 3 });
  assert.deepEqual(buildHabitTargets(1), { targetValue: 1, minimumValue: 1, busyDayValue: 1 });
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