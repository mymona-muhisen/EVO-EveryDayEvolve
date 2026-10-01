import { Router, type IRouter } from "express";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  coinTransactionsTable,
  decorationItemsTable,
  decorationPurchaseKeysTable,
  habitDecorationsTable,
  habitsTable,
  userDecorationsTable,
  usersTable,
} from "@workspace/db";
import {
  GetHabitDecorationsParams,
  GetHabitDecorationsResponse,
  ListDecorationCatalogResponse,
  PlaceHabitDecorationBody,
  PlaceHabitDecorationParams,
  PlaceHabitDecorationResponse,
  PurchaseDecorationItemBody,
  PurchaseDecorationItemParams,
  PurchaseDecorationItemResponse,
  RemoveHabitDecorationParams,
} from "@workspace/api-zod";
import { ensureUser } from "../lib/userService";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/decorations/catalog", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const [items, ownedRows] = await Promise.all([
    db.select().from(decorationItemsTable).orderBy(asc(decorationItemsTable.id)),
    db.select({ itemId: userDecorationsTable.itemId })
      .from(userDecorationsTable)
      .where(eq(userDecorationsTable.userId, req.userId!)),
  ]);
  const owned = new Set(ownedRows.map((row) => row.itemId));
  res.json(ListDecorationCatalogResponse.parse(items.map((item) => ({
    id: item.id,
    name: item.name,
    assetFile: item.assetFile,
    coinCost: item.coinCost,
    owned: owned.has(item.id),
  }))));
});

router.post("/decorations/items/:itemId/purchase", async (req, res): Promise<void> => {
  const userId = req.userId!;
  await ensureUser(userId);
  const params = PurchaseDecorationItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = PurchaseDecorationItemBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const result = await db.transaction(async (tx) => {
    // Serializes all purchases for this user, including replay checks, ownership
    // checks, the debit, ledger write, and idempotency record.
    const [user] = await tx.select().from(usersTable)
      .where(eq(usersTable.id, userId)).for("update");
    if (!user) throw new Error(`User ${userId} disappeared after provisioning`);
    const [item] = await tx.select().from(decorationItemsTable)
      .where(eq(decorationItemsTable.id, params.data.itemId));
    if (!item) return { kind: "not_found" } as const;

    const [committedKey] = await tx.select().from(decorationPurchaseKeysTable)
      .where(and(
        eq(decorationPurchaseKeysTable.userId, userId),
        eq(decorationPurchaseKeysTable.idempotencyKey, body.data.idempotencyKey),
      ));
    if (committedKey) {
      if (committedKey.itemId !== item.id) return { kind: "key_conflict" } as const;
      return { kind: "ok", item, walletCoins: user.coins, purchased: committedKey.purchased } as const;
    }

    const [existingOwnership] = await tx.select().from(userDecorationsTable)
      .where(and(
        eq(userDecorationsTable.userId, userId),
        eq(userDecorationsTable.itemId, item.id),
      ));
    if (existingOwnership) {
      await tx.insert(decorationPurchaseKeysTable).values({
        userId,
        idempotencyKey: body.data.idempotencyKey,
        itemId: item.id,
        purchased: false,
      });
      return { kind: "ok", item, walletCoins: user.coins, purchased: false } as const;
    }

    const [debitedUser] = await tx.update(usersTable)
      .set({ coins: sql`${usersTable.coins} - ${item.coinCost}` })
      .where(and(eq(usersTable.id, userId), gte(usersTable.coins, item.coinCost)))
      .returning();
    if (!debitedUser) return { kind: "insufficient" } as const;

    await tx.insert(coinTransactionsTable).values({
      userId,
      amount: -item.coinCost,
      reason: "item_purchase",
    });
    await tx.insert(userDecorationsTable).values({ userId, itemId: item.id });
    await tx.insert(decorationPurchaseKeysTable).values({
      userId,
      idempotencyKey: body.data.idempotencyKey,
      itemId: item.id,
      purchased: true,
    });
    return { kind: "ok", item, walletCoins: debitedUser.coins, purchased: true } as const;
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Decoration not found" });
    return;
  }
  if (result.kind === "key_conflict") {
    res.status(409).json({ error: "Idempotency key was already committed for another decoration" });
    return;
  }
  if (result.kind === "insufficient") {
    res.status(400).json({ error: "Not enough coins" });
    return;
  }
  res.json(PurchaseDecorationItemResponse.parse({
    item: {
      id: result.item.id,
      name: result.item.name,
      assetFile: result.item.assetFile,
      coinCost: result.item.coinCost,
      owned: true,
    },
    walletCoins: result.walletCoins,
    purchased: result.purchased,
  }));
});

router.get("/habits/:habitId/decorations", async (req, res): Promise<void> => {
  const userId = req.userId!;
  await ensureUser(userId);
  const params = GetHabitDecorationsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [habit] = await db.select({ id: habitsTable.id }).from(habitsTable)
    .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, userId)));
  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  const rows = await db.select({
    decorationId: decorationItemsTable.id,
    islandId: habitDecorationsTable.islandId,
    slot: habitDecorationsTable.slot,
    name: decorationItemsTable.name,
    assetFile: decorationItemsTable.assetFile,
  }).from(habitDecorationsTable)
    .innerJoin(decorationItemsTable, eq(habitDecorationsTable.itemId, decorationItemsTable.id))
    .where(eq(habitDecorationsTable.habitId, habit.id))
    .orderBy(asc(habitDecorationsTable.islandId), asc(habitDecorationsTable.slot));
  res.json(GetHabitDecorationsResponse.parse({
    habitId: habit.id,
    placements: rows,
  }));
});

router.put("/habits/:habitId/decorations/:itemId", async (req, res): Promise<void> => {
  const userId = req.userId!;
  await ensureUser(userId);
  const params = PlaceHabitDecorationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = PlaceHabitDecorationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const result = await db.transaction(async (tx) => {
    // Locking the habit serializes all placement moves for that habit, ensuring
    // that the slot check and upsert cannot displace another decoration.
    const [habit] = await tx.select({ id: habitsTable.id }).from(habitsTable)
      .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, userId)))
      .for("update");
    if (!habit) return { kind: "habit_not_found" } as const;
    const [item] = await tx.select().from(decorationItemsTable)
      .where(eq(decorationItemsTable.id, params.data.itemId));
    if (!item) return { kind: "item_not_found" } as const;
    const [ownership] = await tx.select().from(userDecorationsTable)
      .where(and(
        eq(userDecorationsTable.userId, userId),
        eq(userDecorationsTable.itemId, item.id),
      ));
    if (!ownership) return { kind: "not_owned" } as const;

    const [occupant] = await tx.select().from(habitDecorationsTable)
      .where(and(
        eq(habitDecorationsTable.habitId, habit.id),
        eq(habitDecorationsTable.islandId, body.data.islandId),
        eq(habitDecorationsTable.slot, body.data.slot),
      ));
    if (occupant && occupant.itemId !== item.id) return { kind: "collision" } as const;

    const [placement] = await tx.insert(habitDecorationsTable)
      .values({
        habitId: habit.id,
        itemId: item.id,
        islandId: body.data.islandId,
        slot: body.data.slot,
      })
      .onConflictDoUpdate({
        target: [habitDecorationsTable.habitId, habitDecorationsTable.itemId],
        set: { islandId: body.data.islandId, slot: body.data.slot },
      })
      .returning();
    return { kind: "ok", placement, item } as const;
  });

  if (result.kind === "habit_not_found") {
    res.status(404).json({ error: "Habit not found" });
    return;
  }
  if (result.kind === "item_not_found") {
    res.status(404).json({ error: "Decoration not found" });
    return;
  }
  if (result.kind === "not_owned") {
    res.status(404).json({ error: "Decoration is not owned by this user" });
    return;
  }
  if (result.kind === "collision") {
    res.status(409).json({ error: "Island slot is occupied by another decoration" });
    return;
  }
  res.json(PlaceHabitDecorationResponse.parse({
    decorationId: result.item.id,
    islandId: result.placement.islandId,
    slot: result.placement.slot,
    name: result.item.name,
    assetFile: result.item.assetFile,
  }));
});

router.delete("/habits/:habitId/decorations/:itemId", async (req, res): Promise<void> => {
  const userId = req.userId!;
  await ensureUser(userId);
  const params = RemoveHabitDecorationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [habit] = await db.select({ id: habitsTable.id }).from(habitsTable)
    .where(and(eq(habitsTable.id, params.data.habitId), eq(habitsTable.userId, userId)));
  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }
  await db.delete(habitDecorationsTable).where(and(
    eq(habitDecorationsTable.habitId, habit.id),
    eq(habitDecorationsTable.itemId, params.data.itemId),
  ));
  res.sendStatus(204);
});

export default router;