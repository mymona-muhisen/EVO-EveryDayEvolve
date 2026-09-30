import assert from "node:assert/strict";
import { test } from "node:test";
import type { AiTextProvider } from "./aiProvider";
import {
  breakdownGoalMessages,
  checkinFeedbackMessage,
  dailyInsightMessage,
  relapseRecoveryMessages,
} from "./aiMessages";
import { checkinTone, goalMilestones, phraseMilestones, recoveryTarget } from "./aiRules";

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