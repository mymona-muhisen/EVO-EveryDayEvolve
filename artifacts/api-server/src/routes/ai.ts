import { Router, type IRouter } from "express";
import { eq, and, gte, lte, desc, inArray } from "drizzle-orm";
import { db, habitsTable, checkinsTable, timeEntriesTable } from "@workspace/db";
import {
  AiBreakdownGoalBody,
  AiBreakdownGoalResponse,
  AiDailyInsightResponse,
  AiCheckinFeedbackBody,
  AiCheckinFeedbackResponse,
  AiRelapseRecoveryBody,
  AiRelapseRecoveryResponse,
  AiHabitBuilderBody,
  AiHabitBuilderResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { toDateOnly, todayInTimezone } from "../lib/dates";
import {
  goalMilestones, phraseMilestones, checkinTone, recoveryTarget,
  missedScheduledDays,
} from "../lib/aiRules";
import {
  breakdownGoalMessages,
  dailyInsightMessage,
  checkinFeedbackMessage,
  relapseRecoveryMessages,
  habitBuilderText,
} from "../lib/aiMessages";
import { makeHabitBuilderPlan, matchedTrackingCategories } from "../lib/habitBuilder";
import { addCalendarDays } from "../lib/habitJourney";

const router: IRouter = Router();
router.use(requireAuth);

router.post("/ai/breakdown-goal", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = AiBreakdownGoalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const steps = goalMilestones(parsed.data.targetValue);

  const { stepTexts, coachMessage } = await breakdownGoalMessages(parsed.data, steps);

  res.json(
    AiBreakdownGoalResponse.parse({
      milestones: phraseMilestones(steps, stepTexts),
      coachMessage,
    }),
  );
});

router.post("/ai/habit-builder", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  const parsed = AiHabitBuilderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const preliminary = makeHabitBuilderPlan(parsed.data);
  const intentOnlyPlan = makeHabitBuilderPlan({ ...parsed.data, trackingContext: undefined });
  let trackedBaseline: number | null = null;
  if (preliminary.goalType === "quit" && parsed.data.baselineValue === undefined
    && preliminary.unit === "minutes") {
    const categories = matchedTrackingCategories(parsed.data.intent, intentOnlyPlan.category);
    if (categories.length) {
      const today = todayInTimezone(user.timezone);
      const rows = await db.select({
        date: timeEntriesTable.date,
        durationMinutes: timeEntriesTable.durationMinutes,
      }).from(timeEntriesTable).where(and(
        eq(timeEntriesTable.userId, req.userId!),
        inArray(timeEntriesTable.category, categories),
        gte(timeEntriesTable.date, addCalendarDays(today, -7)),
        lte(timeEntriesTable.date, today),
      ));
      if (rows.length) {
        const daily = new Map<string, number>();
        for (const row of rows) daily.set(row.date, (daily.get(row.date) ?? 0) + row.durationMinutes);
        trackedBaseline = Math.round((Array.from(daily.values()).reduce((sum, value) => sum + value, 0) / daily.size) * 100) / 100;
      }
    }
  }
  const plan = makeHabitBuilderPlan(parsed.data, trackedBaseline);
  const interpretation = await habitBuilderText({
    intent: parsed.data.intent,
    fallbackTitle: plan.title,
    fallbackCategory: plan.category,
    goalType: plan.goalType,
    friction: parsed.data.friction,
    fallbackFrictionTip: plan.frictionTip,
  });
  const result = {
    ...plan,
    ...(interpretation ? {
      title: interpretation.title,
      category: interpretation.category,
      understoodGoal: interpretation.understoodGoal,
      reason: interpretation.reason,
      source: "ai" as const,
    } : {}),
    frictionTip: interpretation?.frictionTip ?? plan.frictionTip,
    coachMessage: interpretation?.reason ?? plan.reason,
  };
  res.json(AiHabitBuilderResponse.parse(result));
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
  const tone = checkinTone(completed, streak);

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

  const history = await db.select({ date: checkinsTable.date })
    .from(checkinsTable)
    .where(and(eq(checkinsTable.habitId, habit.id), eq(checkinsTable.userId, req.userId!)))
    .orderBy(desc(checkinsTable.date));
  const missedDays = missedScheduledDays(
    habit.cadence, habit.customDays, history.map((row) => row.date), toDateOnly(new Date()), habit.createdAt,
  );
  const suggestedTargetValue = recoveryTarget(habit.targetValue);

  const { message, encouragement } = await relapseRecoveryMessages({
    habitTitle: habit.title,
    missedDays,
    suggestedTargetValue,
    unit: habit.unit,
  });

  res.json(AiRelapseRecoveryResponse.parse({
    message, originalTargetValue: habit.targetValue, suggestedTargetValue, encouragement, missedDays,
  }));
});

export default router;
