import { and, desc, eq, inArray, isNotNull, or, lte } from "drizzle-orm";
import {
  characterItemsTable,
  checkinsTable,
  dayAnalysisCacheTable,
  habitDaysTable,
  habitsTable,
  journeyRewardsTable,
  memoriesTable,
  socialBlocksTable,
  socialFriendshipsTable,
  timeEntriesTable,
  trackingSessionsTable,
  userCharacterItemsTable,
  usersTable,
  db,
} from "@workspace/db";
import {
  GetTrackedDayAnalysisResponse,
  GetCurrentUserResponse,
} from "@workspace/api-zod";
import { canViewSocialResource } from "../services/social-common";
import { getLevelProgress, getTotalXp, xpToNextLevel } from "./rules";
import { addCalendarDays, isWithinJourneyWindow, journeyDayNumber } from "./habitJourney";
import {
  getReadOnlyDailyHabitStates,
  getReadOnlyPastScheduledHabitStates,
} from "./dailyExecutionService";
import { todayInTimezone } from "./dates";
import { evaluateJourneyLifecycle } from "./journeyLifecycle";
import { chooseDashboardMissed, dashboardGreeting, dashboardState, orderDashboardFocus } from "./dashboardRules";
import { getCurrentTrackedAnalysisHash } from "./trackedAnalysisCache";
import { categories as trackedCategoryLabels } from "./trackedDay";

function dateKey(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function dashboardMemoryResponse(row: {
  memory: typeof memoriesTable.$inferSelect;
  day: typeof habitDaysTable.$inferSelect | null;
  habit: typeof habitsTable.$inferSelect | null;
  checkin: typeof checkinsTable.$inferSelect | null;
}) {
  const { memory, day, habit, checkin } = row;
  const hasSavedContext = day != null
    && habit != null
    && memory.habitDayId === day.id
    && memory.habitId === habit.id
    && memory.date === day.date
    && memory.userId === habit.userId
    && day.scheduled
    && habit.journeyStartDate != null
    && habit.journeyLength === 22
    && isWithinJourneyWindow(day.date, habit.journeyStartDate, habit.journeyLength)
    && day.dayNumber === journeyDayNumber(day.date, habit.journeyStartDate);

  return {
    id: memory.id,
    habitId: memory.habitId,
    note: memory.note,
    photoUrl: memory.photoObjectPath ? `/api/storage${memory.photoObjectPath}` : null,
    date: memory.date,
    createdAt: memory.createdAt,
    caption: memory.caption ?? (
      memory.habitDayId == null && memory.note.length <= 300 ? memory.note : null
    ),
    visibility: memory.visibility,
    updatedAt: memory.updatedAt,
    journeyId: hasSavedContext ? habit.id : null,
    habitDayId: hasSavedContext ? day.id : null,
    dayNumber: hasSavedContext ? day.dayNumber : null,
    journeyLength: hasSavedContext ? habit.journeyLength : null,
    habitTitle: hasSavedContext ? day.title : null,
    targetValue: hasSavedContext ? day.targetValue : null,
    actualValue: hasSavedContext && checkin != null ? checkin.value : null,
    unit: hasSavedContext ? day.unit : null,
    difficulty: hasSavedContext && checkin != null ? checkin.difficulty : null,
  };
}

async function getCharacter(userId: string, user: any) {
  const [equipped, recentRows] = await Promise.all([
    db.select({
      id: characterItemsTable.id,
      name: characterItemsTable.name,
      slot: characterItemsTable.slot,
      emoji: characterItemsTable.emoji,
      coinCost: characterItemsTable.coinCost,
      levelRequired: characterItemsTable.levelRequired,
    }).from(userCharacterItemsTable).innerJoin(
      characterItemsTable,
      eq(characterItemsTable.id, userCharacterItemsTable.itemId),
    ).where(and(eq(userCharacterItemsTable.userId, userId), eq(userCharacterItemsTable.equipped, true))),
    db.select({
      date: checkinsTable.date,
      xpEarned: checkinsTable.xpEarned,
      coinsEarned: checkinsTable.coinsEarned,
      rewardGranted: checkinsTable.rewardGranted,
    }).from(checkinsTable).where(and(
      eq(checkinsTable.userId, userId),
      eq(checkinsTable.completed, true),
    )).orderBy(desc(checkinsTable.date), desc(checkinsTable.id)).limit(5),
  ]);
  const { progressPercent } = getLevelProgress(user.level, user.xp);
  return {
    level: user.level,
    xp: user.xp,
    xpToNextLevel: xpToNextLevel(user.level),
    totalXp: getTotalXp(user.level, user.xp),
    nextLevelXp: xpToNextLevel(user.level),
    progressPercent,
    walletCoins: user.coins,
    equippedItems: equipped.map((item) => ({ ...item, owned: true, equipped: true })),
    recentProgress: recentRows.map((row) => ({
      date: row.date,
      xpEarned: row.xpEarned,
      coinsEarned: row.rewardGranted || row.coinsEarned > 0 ? row.coinsEarned : null,
    })).filter((row) => row.xpEarned !== null || row.coinsEarned !== null),
  };
}

async function getJourneyContexts(userId: string, habits: any[], today: string, timezone: string) {
  const candidates = habits.filter((habit) => habit.journeyStartDate != null && habit.journeyLength === 22);
  if (!candidates.length) return [];
  const ids = candidates.map((habit) => habit.id);
  const [days, checkins] = await Promise.all([
    db.select().from(habitDaysTable).where(inArray(habitDaysTable.habitId, ids)),
    db.select().from(checkinsTable).where(and(
      eq(checkinsTable.userId, userId),
      inArray(checkinsTable.habitId, ids),
      lte(checkinsTable.date, today),
    )),
  ]);
  return candidates.map((habit) => {
    const endDate = addCalendarDays(habit.journeyStartDate, 21);
    const journeyDays = days.filter((day) => day.habitId === habit.id
      && day.date >= habit.journeyStartDate && day.date <= endDate);
    const habitCheckins = checkins.filter((checkin) => checkin.habitId === habit.id
      && checkin.date >= habit.journeyStartDate && checkin.date <= endDate);
    const elapsedDays = journeyDays.filter((day) => day.scheduled && day.date <= today);
    const successes = new Map(habitCheckins.filter((checkin) => checkin.completed && checkin.date <= today)
      .map((checkin) => [checkin.date, checkin]));
    const successfulDates = new Set(successes.keys());
    const successfulDays = elapsedDays.filter((day) => successes.has(day.date)).length;
    const scheduledDates = journeyDays.filter((day) => day.scheduled).map((day) => day.date);
    const lifecycle = evaluateJourneyLifecycle({
      startDate: habit.journeyStartDate,
      length: 22,
      today,
      scheduledDates,
      successfulDates,
      completedAt: habit.journeyCompletedAt,
    });
    const dateBounded = habitCheckins.filter((checkin) => checkin.completed
      && checkin.date >= habit.journeyStartDate && checkin.date <= today);
    const earningsPartial = dateBounded.some((checkin) => checkin.xpEarned == null
      || (!checkin.rewardGranted && checkin.coinsEarned === 0));
    const latestScheduledDate = [...scheduledDates].sort().at(-1) ?? null;
    const persistedCompletionDate = habit.journeyCompletedAt
      ? todayInTimezone(timezone, habit.journeyCompletedAt)
      : null;
    const completionDate = lifecycle.status !== "completed" ? null
      : persistedCompletionDate ?? (latestScheduledDate && successfulDates.has(latestScheduledDate)
        ? latestScheduledDate
        : null);
    return {
      habit,
      endDate,
      completionDate,
      preview: {
        habitId: habit.id,
        title: habit.title,
        emoji: habit.emoji,
        currentDay: lifecycle.calendarDay,
        journeyLength: 22,
        status: lifecycle.status === "not_started" ? "upcoming" : lifecycle.status,
        successfulDays,
        eligibleDays: elapsedDays.length,
        consistencyPercentage: elapsedDays.length ? Math.round(successfulDays / elapsedDays.length * 100) : null,
        daysRemaining: Math.max(0, 22 - lifecycle.calendarDay),
        progressPercent: Math.round(lifecycle.calendarDay / 22 * 100),
        coinsEarned: dateBounded.reduce((total, row) => total + row.coinsEarned, 0),
        xpEarned: dateBounded.reduce((total, row) => total + (row.xpEarned ?? 0), 0),
        earningsPartial,
      },
    };
  });
}

async function getSocial(userId: string, now: Date) {
  const friendships = await db.select().from(socialFriendshipsTable).where(or(
    eq(socialFriendshipsTable.userLowId, userId),
    eq(socialFriendshipsTable.userHighId, userId),
  )).orderBy(desc(socialFriendshipsTable.createdAt)).limit(16);
  const friends = [];
  for (const friendship of friendships) {
    const friendId = friendship.userLowId === userId ? friendship.userHighId : friendship.userLowId;
    const [blocked] = await db.select({ id: socialBlocksTable.id }).from(socialBlocksTable).where(or(
      and(eq(socialBlocksTable.blockerUserId, userId), eq(socialBlocksTable.blockedUserId, friendId)),
      and(eq(socialBlocksTable.blockerUserId, friendId), eq(socialBlocksTable.blockedUserId, userId)),
    )).limit(1);
    if (blocked) continue;
    const [friend] = await db.select({
      id: usersTable.id,
      username: usersTable.username,
      displayName: usersTable.displayName,
      avatarEmoji: usersTable.avatarEmoji,
      timezone: usersTable.timezone,
    }).from(usersTable).where(eq(usersTable.id, friendId)).limit(1);
    if (!friend) continue;
    const friendToday = todayInTimezone(friend.timezone, now);
    const characterAllowed = await db.transaction((tx) => canViewSocialResource(tx, {
      viewerUserId: userId, ownerUserId: friendId, resourceType: "character", resourceId: "profile",
    }));
    const character = characterAllowed ? await db.select({
      slot: characterItemsTable.slot,
      name: characterItemsTable.name,
      emoji: characterItemsTable.emoji,
    }).from(userCharacterItemsTable).innerJoin(
      characterItemsTable, eq(characterItemsTable.id, userCharacterItemsTable.itemId),
    ).where(and(eq(userCharacterItemsTable.userId, friendId), eq(userCharacterItemsTable.equipped, true))) : [];
    let journey: any = null;
    const candidates = await db.select().from(habitsTable).where(and(
      eq(habitsTable.userId, friendId), eq(habitsTable.journeyLength, 22),
    )).orderBy(desc(habitsTable.createdAt)).limit(4);
    for (const candidate of candidates) {
      if (!candidate.journeyStartDate || !await db.transaction((tx) => canViewSocialResource(tx, {
        viewerUserId: userId, ownerUserId: friendId, resourceType: "journey", resourceId: String(candidate.id),
      }))) continue;
      const [days, checkins] = await Promise.all([
        db.select().from(habitDaysTable).where(eq(habitDaysTable.habitId, candidate.id)),
        db.select().from(checkinsTable).where(and(
          eq(checkinsTable.habitId, candidate.id),
          eq(checkinsTable.userId, friendId),
          lte(checkinsTable.date, friendToday),
        )),
      ]);
      const successDates = new Set(checkins.filter((row) => row.completed).map((row) => row.date));
      const scheduled = days.filter((day) => day.scheduled
        && day.date >= candidate.journeyStartDate!
        && day.date <= addCalendarDays(candidate.journeyStartDate!, 21)
        && day.date <= friendToday);
      const successful = scheduled.filter((day) => successDates.has(day.date)).length;
      const lifecycle = evaluateJourneyLifecycle({
        startDate: candidate.journeyStartDate,
        length: candidate.journeyLength,
        today: friendToday,
        scheduledDates: days.filter((day) => day.scheduled
          && day.date >= candidate.journeyStartDate!
          && day.date <= addCalendarDays(candidate.journeyStartDate!, 21)).map((day) => day.date),
        successfulDates: successDates,
        completedAt: candidate.journeyCompletedAt,
      });
      journey = {
        journeyId: candidate.id,
        title: candidate.title,
        emoji: candidate.emoji,
        category: candidate.category,
        progressDay: Math.max(0, ...days.filter((day) => day.date >= candidate.journeyStartDate!
          && day.date <= addCalendarDays(candidate.journeyStartDate!, 21)
          && successDates.has(day.date)).map((day) => day.dayNumber)),
        journeyLength: 22,
        successfulDayCount: successful,
        consistencyPercentage: scheduled.length ? Math.round(successful / scheduled.length * 100) : null,
        completed: lifecycle.status === "completed",
      };
      break;
    }
    friends.push({ user: friend, journey, character });
    if (friends.length === 4) break;
  }
  return friends;
}

export async function getDashboardHome(
  userId: string,
  now = new Date(),
  onSectionError: (section: string, error?: unknown) => void = () => undefined,
) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) throw new Error("Dashboard profile unavailable");
  const profile = GetCurrentUserResponse.parse({
    ...user,
    xpToNextLevel: xpToNextLevel(user.level),
  });
  const date = todayInTimezone(user.timezone, now);
  const sectionStatus: Record<string, "ready" | "empty" | "unavailable" | "stale"> = {
    habits: "empty", journey: "empty", reward: "empty", character: "empty",
    time: "empty", coach: "empty", social: "empty", memory: "empty",
  };
  const runSection = async <T>(section: string, task: () => Promise<T>): Promise<T> => {
    try {
      const result = await task();
      sectionStatus[section] = result == null || Array.isArray(result) && result.length === 0
        || typeof result === "object" && "analysis" in result && result.analysis == null
        || typeof result === "object" && "trackedMinutes" in result
          && "session" in result && result.trackedMinutes === 0 && result.session == null
        ? "empty"
        : typeof result === "object" && "isStale" in result && result.isStale
          ? "stale"
          : "ready";
      return result;
    } catch (error) {
      sectionStatus[section] = "unavailable";
      throw error;
    }
  };
  const settled = async <T>(section: string, task: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await runSection(section, task);
    } catch (error) {
      onSectionError(section, error);
      return fallback;
    }
  };
  const [habitResult, character, timeData, coachData, friends, memoryRow] = await Promise.all([
    settled("habits", async () => {
      const [habits, executions] = await Promise.all([
        db.select().from(habitsTable).where(and(eq(habitsTable.userId, userId), eq(habitsTable.isActive, true))),
        getReadOnlyDailyHabitStates(userId, date, now),
      ]);
      const missedExecutions = await getReadOnlyPastScheduledHabitStates(userId, date, now);
      return { habits, executions, missedExecutions };
    }, { habits: [], executions: [], missedExecutions: [] }),
    settled("character", () => getCharacter(userId, user), null),
    settled("time", async () => {
      const [entries, sessions] = await Promise.all([
        db.select().from(timeEntriesTable).where(and(eq(timeEntriesTable.userId, userId), eq(timeEntriesTable.date, date))),
        db.select().from(trackingSessionsTable).where(and(eq(trackingSessionsTable.userId, userId), eq(trackingSessionsTable.date, date))).limit(1),
      ]);
      const totals = new Map<string, number>();
      for (const entry of entries) totals.set(entry.category, (totals.get(entry.category) ?? 0) + entry.durationMinutes);
      const totalMinutes = entries.reduce((sum, entry) => sum + entry.durationMinutes, 0);
      const categoryTotals = [...totals].map(([category, minutes]) => ({
        category,
        label: trackedCategoryLabels[category as keyof typeof trackedCategoryLabels] ?? trackedCategoryLabels.other,
        minutes,
        percentage: totalMinutes ? Math.round(minutes / totalMinutes * 100) : 0,
      })).sort((a, b) => b.minutes - a.minutes || a.category.localeCompare(b.category)).slice(0, 3);
      return {
        session: sessions[0] ?? null,
        trackedMinutes: totalMinutes,
        intervalMinutes: sessions[0]?.intervalMinutes ?? null,
        categoryTotals,
        opportunity: null as string | null,
      };
    }, null),
    settled("coach", async () => {
      const rows = await db.select().from(dayAnalysisCacheTable).where(eq(dayAnalysisCacheTable.userId, userId))
        .orderBy(desc(dayAnalysisCacheTable.date)).limit(1);
      const cache = rows[0];
      if (!cache) return { analysis: null, analysisDate: null, updatedAt: null, isStale: false };
      const isStale = cache.date !== date
        || cache.dataHash !== await getCurrentTrackedAnalysisHash(
          userId, date, user.timezone, user.primaryGoalCategory,
        );
      return {
        analysis: GetTrackedDayAnalysisResponse.parse(cache.analysis),
        analysisDate: cache.date,
        updatedAt: cache.createdAt,
        isStale,
      };
    }, null),
    settled("social", () => getSocial(userId, now), []),
    settled("memory", async () => {
      const rows = await db.select({
        memory: memoriesTable,
        day: habitDaysTable,
        habit: habitsTable,
        checkin: checkinsTable,
      }).from(memoriesTable)
        .leftJoin(habitDaysTable, eq(habitDaysTable.id, memoriesTable.habitDayId))
        .leftJoin(habitsTable, and(
          eq(habitsTable.id, habitDaysTable.habitId),
          eq(habitsTable.userId, memoriesTable.userId),
        ))
        .leftJoin(checkinsTable, and(
          eq(checkinsTable.habitId, habitDaysTable.habitId),
          eq(checkinsTable.userId, memoriesTable.userId),
          eq(checkinsTable.date, habitDaysTable.date),
          eq(checkinsTable.completed, true),
        ))
        .where(and(
          eq(memoriesTable.userId, userId),
          eq(memoriesTable.date, date),
        )).orderBy(desc(memoriesTable.createdAt));
      if (!rows.length) return null;
      const shaped = rows.map(dashboardMemoryResponse);
      // If old standalone history and a linked memory share a date, prefer the
      // verified journey-day memory without ever promoting the legacy row.
      return shaped.find((memory) => memory.habitDayId != null) ?? shaped[0];
    }, null),
  ]);
  const { habits, executions, missedExecutions } = habitResult;
  if (habits.length === 0 && sectionStatus.habits !== "unavailable") sectionStatus.habits = "empty";
  const habitById = new Map(habits.map((habit) => [habit.id, habit]));
  const focusCandidates = executions.map((execution: any) => ({
    habit: habitById.get(execution.habitId), execution,
  })).filter((item): item is { habit: typeof habits[number]; execution: typeof executions[number] } => item.habit != null);
  const candidates = orderDashboardFocus(focusCandidates);
  const missedCandidates = missedExecutions.map((execution: any) => ({
    habit: habitById.get(execution.habitId),
    execution,
  })).filter((item): item is { habit: typeof habits[number]; execution: typeof missedExecutions[number] } => item.habit != null);
  const unresolvedMissed = chooseDashboardMissed(missedCandidates);
  const focusItem = candidates.find((item: any) => dateKey(item.execution.date) === date
    && item.execution.scheduled) ?? null;
  const focus = focusItem ? { habit: focusItem.habit, execution: focusItem.execution } : null;
  const otherHabits = candidates.filter((item: any) => item !== focusItem
    && dateKey(item.execution.date) === date)
    .map((item: any) => ({ habit: item.habit, execution: item.execution }));
  const missedDay = unresolvedMissed ? { habit: unresolvedMissed.habit, execution: unresolvedMissed.execution } : null;
  let journey = null;
  let reward = null;
  let completion: { journey: any; reward: any } | null = null;
  let journeyContext: Awaited<ReturnType<typeof getJourneyContexts>>[number] | null = null;
  let completionContext: Awaited<ReturnType<typeof getJourneyContexts>>[number] | null = null;
  if (sectionStatus.habits === "unavailable") {
    sectionStatus.journey = "unavailable";
    sectionStatus.reward = "unavailable";
  } else {
    try {
      const journeyHabits = await db.select().from(habitsTable).where(and(
        eq(habitsTable.userId, userId),
        eq(habitsTable.journeyLength, 22),
        isNotNull(habitsTable.journeyStartDate),
      ));
      const journeyCandidatesById = new Map([
        ...habits.map((habit) => [habit.id, habit] as const),
        ...journeyHabits.map((habit) => [habit.id, habit] as const),
      ]);
      const journeyContexts = await getJourneyContexts(
        userId, [...journeyCandidatesById.values()], date, user.timezone,
      );
      const focusedJourney = focus
        ? journeyContexts.find((item) => item.habit.id === focus.habit.id
          && (item.preview.status === "active" || item.preview.status === "upcoming")) ?? null
        : null;
      const activeOrUpcoming = journeyContexts.filter((item) => item.habit.isActive
        && (item.preview.status === "active" || item.preview.status === "upcoming"))
        .sort((a, b) => {
          const aActive = a.preview.status === "active";
          const bActive = b.preview.status === "active";
          if (aActive !== bActive) return aActive ? -1 : 1;
          if (aActive) return b.preview.currentDay - a.preview.currentDay || a.habit.id - b.habit.id;
          return a.habit.journeyStartDate.localeCompare(b.habit.journeyStartDate) || a.habit.id - b.habit.id;
        });
      const completed = journeyContexts.filter((item) => item.preview.status === "completed"
        && item.completionDate != null && item.completionDate <= date)
        .sort((a, b) => b.completionDate!.localeCompare(a.completionDate!) || a.habit.id - b.habit.id);
      const expired = journeyContexts.filter((item) => item.preview.status === "expired")
        .sort((a, b) => b.endDate.localeCompare(a.endDate) || a.habit.id - b.habit.id);
      journeyContext = focusedJourney
        ?? activeOrUpcoming[0]
        ?? completed[0]
        ?? expired[0]
        ?? null;
      journey = journeyContext?.preview ?? null;

      const focusNeedsAction = focus != null && [
        "pending", "in_progress", "paused", "minimum_reached", "missed",
      ].includes(focus.execution.status);
      const activeJourneyNeedsPriority = activeOrUpcoming.some((item) => item.preview.status === "active");
      completionContext = (focusNeedsAction || activeJourneyNeedsPriority
        ? completed.filter((item) => item.completionDate === date)
        : completed)[0] ?? null;
      sectionStatus.journey = journey ? "ready" : "empty";
    } catch (error) {
      sectionStatus.journey = "unavailable";
      onSectionError("journey", error);
    }
  }
  try {
    if (sectionStatus.journey === "unavailable") {
      sectionStatus.reward = "unavailable";
    } else {
      const rewardHabitIds = [...new Set([
        journeyContext?.habit.id,
        completionContext?.habit.id,
      ].filter((id): id is number => id != null))];
      const rewardRows = rewardHabitIds.length
        ? await db.select().from(journeyRewardsTable).where(and(
          eq(journeyRewardsTable.userId, userId),
          inArray(journeyRewardsTable.habitId, rewardHabitIds),
        ))
        : [];
      const rewardsByHabit = new Map(rewardRows.map((row) => [row.habitId, row]));
      const selectedReward = journeyContext ? rewardsByHabit.get(journeyContext.habit.id) : null;
      if (selectedReward && journey) {
        reward = {
          ...selectedReward,
          currentDay: journey.currentDay,
          daysRemaining: journey.daysRemaining,
        };
      }
      const completionReward = completionContext
        ? rewardsByHabit.get(completionContext.habit.id) ?? null
        : null;
      completion = completionContext
        ? {
          journey: completionContext.preview,
          reward: completionReward
            ? {
              ...completionReward,
              currentDay: completionContext.preview.currentDay,
              daysRemaining: completionContext.preview.daysRemaining,
            }
            : null,
        }
        : null;
      sectionStatus.reward = rewardRows.length ? "ready" : "empty";
    }
  } catch (error) {
    sectionStatus.reward = "unavailable";
    onSectionError("reward", error);
    completion = completionContext ? { journey: completionContext.preview, reward: null } : null;
  }
  if (timeData) timeData.opportunity = coachData?.analysis?.opportunity ?? null;
  const hasTracking = Boolean(timeData?.session);
  const anyTrackingData = Boolean(timeData?.trackedMinutes);
  const trackingState = timeData?.session?.status;
  const state = sectionStatus.habits === "unavailable" ? "unavailable" : dashboardState({
    missedDay,
    focusExecution: focus?.execution ?? null,
    journeyCompleted: journey?.status === "completed",
    hasHabits: habits.length > 0,
    onboardingCompleted: user.onboardingCompleted,
    trackingStatus: trackingState ?? null,
    hasAnalysis: Boolean(coachData?.analysis),
    hasTrackedData: anyTrackingData,
  });
  return {
    date,
    timezone: user.timezone,
    greeting: dashboardGreeting(user.timezone, now),
    profile,
    state,
    focus,
    otherHabits,
    missedDay,
    journey,
    reward,
    completion,
    character,
    time: timeData,
    coach: coachData,
    friends,
    memory: memoryRow,
    sectionStatus: {
      ...sectionStatus,
      habits: sectionStatus.habits,
    },
  };
}