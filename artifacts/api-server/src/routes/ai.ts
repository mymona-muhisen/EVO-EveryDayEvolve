import { Router, type IRouter } from "express";
import { eq, and, gte } from "drizzle-orm";
import { db, habitsTable, checkinsTable } from "@workspace/db";
import {
  AiBreakdownGoalBody,
  AiBreakdownGoalResponse,
  AiDailyInsightResponse,
  AiCheckinFeedbackBody,
  AiCheckinFeedbackResponse,
  AiRelapseRecoveryBody,
  AiRelapseRecoveryResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { toDateOnly } from "../lib/dates";
import {
  breakdownGoalMessages,
  dailyInsightMessage,
  checkinFeedbackMessage,
  relapseRecoveryMessages,
} from "../lib/aiMessages";

const router: IRouter = Router();
router.use(requireAuth);

router.post("/ai/breakdown-goal", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = AiBreakdownGoalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { targetValue } = parsed.data;
  const fractions = [0.25, 0.5, 0.75, 1];
  const steps = fractions.map((f, i) => ({
    targetValue: Math.max(1, Math.round(targetValue * f)),
    order: i + 1,
  }));

  const { stepTexts, coachMessage } = await breakdownGoalMessages(parsed.data, steps);

  res.json(
    AiBreakdownGoalResponse.parse({
      milestones: steps.map((s, i) => ({
        title: stepTexts[i]?.title ?? `الخطوة ${i + 1}`,
        description: stepTexts[i]?.description ?? "",
        targetValue: s.targetValue,
        order: s.order,
      })),
      coachMessage,
    }),
  );
});

router.get("/ai/daily-insight", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);

  const weekAgo = new Date();
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setUTCDate(twoWeeksAgo.getUTCDate() - 14);

  const recentCheckins = await db
    .select()
    .from(checkinsTable)
    .where(
      and(
        eq(checkinsTable.userId, req.userId!),
        eq(checkinsTable.completed, true),
        gte(checkinsTable.date, toDateOnly(twoWeeksAgo)),
      ),
    );

  const weekAgoStr = toDateOnly(weekAgo);
  const thisWeekCount = recentCheckins.filter((c) => c.date >= weekAgoStr).length;
  const prevWeekCount = recentCheckins.filter((c) => c.date < weekAgoStr).length;

  let trend: "up" | "down" | "steady" = "steady";
  if (thisWeekCount > prevWeekCount) trend = "up";
  else if (thisWeekCount < prevWeekCount) trend = "down";

  const highlightMetric = `${thisWeekCount} تسجيلات مكتملة هذا الأسبوع`;

  const message = await dailyInsightMessage({
    displayName: user.displayName,
    trend,
    highlightMetric,
    completionRateThisWeek: thisWeekCount,
    completionRatePrevWeek: prevWeekCount,
  });

  res.json(AiDailyInsightResponse.parse({ message, highlightMetric, trend }));
});

router.post("/ai/checkin-feedback", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = AiCheckinFeedbackBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [habit] = await db
    .select()
    .from(habitsTable)
    .where(and(eq(habitsTable.id, parsed.data.habitId), eq(habitsTable.userId, req.userId!)));
  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  const { completed, streak, value } = parsed.data;
  let tone: "celebratory" | "encouraging" | "supportive" = "encouraging";
  if (!completed) tone = "supportive";
  else if (streak > 0 && (streak % 7 === 0 || streak >= 3)) tone = "celebratory";

  const message = await checkinFeedbackMessage({ habitTitle: habit.title, completed, value, streak, tone });

  res.json(AiCheckinFeedbackResponse.parse({ message, tone }));
});

router.post("/ai/relapse-recovery", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = AiRelapseRecoveryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [habit] = await db
    .select()
    .from(habitsTable)
    .where(and(eq(habitsTable.id, parsed.data.habitId), eq(habitsTable.userId, req.userId!)));
  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  const suggestedTargetValue = Math.max(1, Math.round(habit.targetValue * 0.5));

  const { message, encouragement } = await relapseRecoveryMessages({
    habitTitle: habit.title,
    missedDays: parsed.data.missedDays,
    suggestedTargetValue,
    unit: habit.unit,
  });

  res.json(AiRelapseRecoveryResponse.parse({ message, suggestedTargetValue, encouragement }));
});

export default router;
