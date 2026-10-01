import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  habitsTable,
  journeyRewardsTable,
  usersTable,
  type JourneyRewardRow,
} from "@workspace/db";
import {
  ClaimJourneyRewardParams,
  ClaimJourneyRewardResponse,
  CreateJourneyRewardBody,
  CreateJourneyRewardResponse,
  GetJourneyRewardParams,
  GetJourneyRewardResponse,
  ListJourneyRewardsResponse,
  UpdateJourneyRewardBody,
  UpdateJourneyRewardParams,
  UpdateJourneyRewardResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { todayInTimezone } from "../lib/dates";
import { HABIT_JOURNEY_LENGTH } from "../lib/habitJourney";
import {
  type JourneyLifecycleSnapshot,
  journeyRewardResponse,
  prepareJourneyRewardImage,
  prepareJourneyRewardInput,
  synchronizeJourneyCompletion,
} from "../lib/journeyRewardService";

const router: IRouter = Router();
router.use(requireAuth);

type JourneyRewardTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
interface RewardSnapshot {
  reward: JourneyRewardRow;
  currentDay: number | null;
  lifecycle: JourneyLifecycleSnapshot | null;
}

const CREATE_KEYS = new Set([
  "habitId", "title", "type", "description", "imageObjectPath", "estimatedValue",
]);
const UPDATE_KEYS = new Set([
  "confirm", "habitId", "title", "type", "description", "imageObjectPath", "estimatedValue",
]);

function onlyKeys(value: unknown, keys: Set<string>): boolean {
  return value != null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.has(key));
}

function postgresErrorCode(error: unknown): string | null {
  const visited = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current == null || visited.has(current)) return null;
    visited.add(current);
    if ("code" in current && typeof (current as { code?: unknown }).code === "string") {
      return (current as { code: string }).code;
    }
    const wrapped = current as { cause?: unknown; originalError?: unknown };
    current = wrapped.cause ?? wrapped.originalError;
  }
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return postgresErrorCode(error) === "23505";
}

async function lockOwner(tx: JourneyRewardTransaction, userId: string) {
  const [user] = await tx.select().from(usersTable)
    .where(eq(usersTable.id, userId)).for("update");
  return user ?? null;
}

async function loadJourneyRewardSnapshot(
  tx: JourneyRewardTransaction,
  userId: string,
  rewardId: number,
  now = new Date(),
): Promise<RewardSnapshot | null> {
  const user = await lockOwner(tx, userId);
  if (!user) return null;
  const [reward] = await tx.select().from(journeyRewardsTable).where(and(
    eq(journeyRewardsTable.id, rewardId),
    eq(journeyRewardsTable.userId, userId),
  )).for("update");
  if (!reward) return null;

  if (reward.habitId == null) {
    return {
      reward,
      currentDay: null,
      lifecycle: null,
    };
  }

  const [habit] = await tx.select().from(habitsTable).where(and(
    eq(habitsTable.id, reward.habitId),
    eq(habitsTable.userId, userId),
  )).for("update");
  // A deleted journey is detached by its FK; a foreign association is never
  // returned to the caller and cannot be claimed.
  if (!habit) return null;

  const synchronized = await synchronizeJourneyCompletion(
    tx,
    userId,
    habit,
    todayInTimezone(user.timezone, now),
    now,
  );
  const currentReward = synchronized.reward
    ?? (await tx.select().from(journeyRewardsTable).where(and(
      eq(journeyRewardsTable.id, reward.id),
      eq(journeyRewardsTable.userId, userId),
    )).limit(1))[0]
    ?? reward;
  return {
    reward: currentReward,
    currentDay: synchronized.lifecycle.calendarDay,
    lifecycle: synchronized.lifecycle,
  };
}

function validatedOutput(snapshot: NonNullable<RewardSnapshot>) {
  return journeyRewardResponse(snapshot.reward, snapshot.currentDay);
}

router.get("/journey-rewards", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const rows = await db.select({ id: journeyRewardsTable.id })
    .from(journeyRewardsTable)
    .where(eq(journeyRewardsTable.userId, req.userId!))
    .orderBy(journeyRewardsTable.createdAt, journeyRewardsTable.id);
  const snapshots = [];
  for (const row of rows) {
    const snapshot = await db.transaction((tx) =>
      loadJourneyRewardSnapshot(tx, req.userId!, row.id));
    if (snapshot) snapshots.push(validatedOutput(snapshot));
  }
  res.json(ListJourneyRewardsResponse.parse(snapshots));
});

router.post("/journey-rewards", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  if (!onlyKeys(req.body, CREATE_KEYS)) {
    res.status(400).json({ error: "Unsupported journey reward fields" });
    return;
  }
  const parsed = CreateJourneyRewardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const user = await lockOwner(tx, req.userId!);
      if (!user) return { kind: "owner_not_found" } as const;
      const habitId = parsed.data.habitId ?? null;
      let habit = null;
      if (habitId != null) {
        const [matched] = await tx.select().from(habitsTable).where(and(
          eq(habitsTable.id, habitId),
          eq(habitsTable.userId, req.userId!),
        )).for("update");
        if (!matched) return { kind: "habit_not_found" } as const;
        if (matched.journeyStartDate == null || matched.journeyLength !== HABIT_JOURNEY_LENGTH) {
          return { kind: "invalid_journey" } as const;
        }
        habit = matched;
      }

      let content: Awaited<ReturnType<typeof prepareJourneyRewardInput>>;
      try {
        content = await prepareJourneyRewardInput(tx, req.userId!, parsed.data);
      } catch (error) {
        return {
          kind: "invalid_image",
          message: error instanceof Error ? error.message : "Invalid private reward image",
        } as const;
      }

      const [reward] = await tx.insert(journeyRewardsTable).values({
        userId: req.userId!,
        habitId,
        ...content,
      }).returning();
      if (!reward) throw new Error("Journey reward insert returned no row");
      if (!habit) return { kind: "ok", reward, currentDay: null } as const;
      const synchronized = await synchronizeJourneyCompletion(
        tx,
        req.userId!,
        habit,
        todayInTimezone(user.timezone),
      );
      return {
        kind: "ok",
        reward: synchronized.reward ?? reward,
        currentDay: synchronized.lifecycle.calendarDay,
      } as const;
    });
    if (result.kind === "owner_not_found") {
      res.status(404).json({ error: "Owner not found" });
      return;
    }
    if (result.kind === "habit_not_found") {
      res.status(404).json({ error: "Journey not found for this user" });
      return;
    }
    if (result.kind === "invalid_journey") {
      res.status(400).json({ error: "A reward can only attach to a started 22-day journey" });
      return;
    }
    if (result.kind === "invalid_image") {
      res.status(400).json({ error: result.message });
      return;
    }
    res.status(201).json(CreateJourneyRewardResponse.parse(
      journeyRewardResponse(result.reward, result.currentDay),
    ));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "This journey already has a real-world reward" });
      return;
    }
    throw error;
  }
});

router.get("/journey-rewards/:journeyRewardId", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = GetJourneyRewardParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const snapshot = await db.transaction((tx) =>
    loadJourneyRewardSnapshot(tx, req.userId!, params.data.journeyRewardId));
  if (!snapshot) {
    res.status(404).json({ error: "Journey reward not found" });
    return;
  }
  res.json(GetJourneyRewardResponse.parse(validatedOutput(snapshot)));
});

router.patch("/journey-rewards/:journeyRewardId", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = UpdateJourneyRewardParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!onlyKeys(req.body, UPDATE_KEYS)) {
    res.status(400).json({ error: "Unsupported journey reward fields" });
    return;
  }
  const parsed = UpdateJourneyRewardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.title !== undefined && !parsed.data.title.trim()) {
    res.status(400).json({ error: "Reward title cannot be blank" });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const user = await lockOwner(tx, req.userId!);
      if (!user) return { kind: "not_found" } as const;
      const [before] = await tx.select().from(journeyRewardsTable).where(and(
        eq(journeyRewardsTable.id, params.data.journeyRewardId),
        eq(journeyRewardsTable.userId, req.userId!),
      )).for("update");
      if (!before) return { kind: "not_found" } as const;

      let oldHabit = null;
      if (before.habitId != null) {
        const [matched] = await tx.select().from(habitsTable).where(and(
          eq(habitsTable.id, before.habitId),
          eq(habitsTable.userId, req.userId!),
        )).for("update");
        if (!matched) return { kind: "not_found" } as const;
        oldHabit = matched;
        await synchronizeJourneyCompletion(
          tx,
          req.userId!,
          oldHabit,
          todayInTimezone(user.timezone),
        );
        const [synchronizedReward] = await tx.select({ status: journeyRewardsTable.status })
          .from(journeyRewardsTable).where(eq(journeyRewardsTable.id, before.id)).limit(1);
        if (synchronizedReward?.status !== "pending") {
          return { kind: "not_pending" } as const;
        }
      } else if (before.status !== "pending") {
        return { kind: "not_pending" } as const;
      }

      const nextHabitId = parsed.data.habitId === undefined
        ? before.habitId
        : parsed.data.habitId ?? null;
      let nextHabit = nextHabitId == null ? null : oldHabit;
      if (nextHabitId != null && nextHabitId !== before.habitId) {
        const [matched] = await tx.select().from(habitsTable).where(and(
          eq(habitsTable.id, nextHabitId),
          eq(habitsTable.userId, req.userId!),
        )).for("update");
        if (!matched) return { kind: "habit_not_found" } as const;
        if (matched.journeyStartDate == null || matched.journeyLength !== HABIT_JOURNEY_LENGTH) {
          return { kind: "invalid_journey" } as const;
        }
        nextHabit = matched;
      }

      let preparedImage: string | null | undefined;
      if (Object.hasOwn(parsed.data, "imageObjectPath")) {
        try {
          preparedImage = await prepareJourneyRewardImage(
            tx,
            req.userId!,
            parsed.data.imageObjectPath,
          );
        } catch (error) {
          return {
            kind: "invalid_image",
            message: error instanceof Error ? error.message : "Invalid private reward image",
          } as const;
        }
      }

      const update: Partial<typeof journeyRewardsTable.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (nextHabitId !== before.habitId) update.habitId = nextHabitId;
      if (parsed.data.title !== undefined) update.title = parsed.data.title.trim();
      if (parsed.data.type !== undefined) update.type = parsed.data.type;
      if (Object.hasOwn(parsed.data, "description")) update.description = parsed.data.description?.trim() || null;
      if (Object.hasOwn(parsed.data, "imageObjectPath")) update.imageUrl = preparedImage ?? null;
      if (Object.hasOwn(parsed.data, "estimatedValue")) update.estimatedValue = parsed.data.estimatedValue ?? null;
      const [updated] = await tx.update(journeyRewardsTable).set(update).where(and(
        eq(journeyRewardsTable.id, before.id),
        eq(journeyRewardsTable.userId, req.userId!),
        eq(journeyRewardsTable.status, "pending"),
      )).returning();
      if (!updated) return { kind: "not_pending" } as const;

      if (!nextHabit) return { kind: "ok", reward: updated, currentDay: null } as const;
      const synchronized = await synchronizeJourneyCompletion(
        tx,
        req.userId!,
        nextHabit,
        todayInTimezone(user.timezone),
      );
      return {
        kind: "ok",
        reward: synchronized.reward ?? updated,
        currentDay: synchronized.lifecycle.calendarDay,
      } as const;
    });
    if (result.kind === "not_found") {
      res.status(404).json({ error: "Journey reward not found" });
      return;
    }
    if (result.kind === "habit_not_found") {
      res.status(404).json({ error: "Journey not found for this user" });
      return;
    }
    if (result.kind === "invalid_journey") {
      res.status(400).json({ error: "A reward can only attach to a started 22-day journey" });
      return;
    }
    if (result.kind === "not_pending") {
      res.status(409).json({ error: "Only pending journey rewards can be changed" });
      return;
    }
    if (result.kind === "invalid_image") {
      res.status(400).json({ error: result.message });
      return;
    }
    res.json(UpdateJourneyRewardResponse.parse(
      journeyRewardResponse(result.reward, result.currentDay),
    ));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "This journey already has a real-world reward" });
      return;
    }
    throw error;
  }
});

router.post("/journey-rewards/:journeyRewardId/claim", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = ClaimJourneyRewardParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (req.body != null && (
    typeof req.body !== "object"
    || Array.isArray(req.body)
    || Object.keys(req.body).length > 0
  )) {
    res.status(400).json({ error: "Claim accepts no client fields" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const snapshot = await loadJourneyRewardSnapshot(
      tx,
      req.userId!,
      params.data.journeyRewardId,
    );
    if (!snapshot) return { kind: "not_found" } as const;
    if (snapshot.reward.status === "claimed") {
      return { kind: "ok", snapshot } as const;
    }
    if (snapshot.reward.status !== "unlocked" || snapshot.reward.unlockedAt == null) {
      return { kind: "locked" } as const;
    }

    const claimedAt = new Date();
    const [claimed] = await tx.update(journeyRewardsTable).set({
      status: "claimed",
      claimedAt,
      updatedAt: claimedAt,
    }).where(and(
      eq(journeyRewardsTable.id, snapshot.reward.id),
      eq(journeyRewardsTable.userId, req.userId!),
      eq(journeyRewardsTable.status, "unlocked"),
    )).returning();
    return {
      kind: "ok",
      snapshot: {
        ...snapshot,
        reward: claimed ?? snapshot.reward,
      },
    } as const;
  });
  if (result.kind === "not_found") {
    res.status(404).json({ error: "Journey reward not found" });
    return;
  }
  if (result.kind === "locked") {
    res.status(409).json({ error: "Complete the attached journey before claiming this reward" });
    return;
  }
  res.json(ClaimJourneyRewardResponse.parse(validatedOutput(result.snapshot)));
});

export default router;
