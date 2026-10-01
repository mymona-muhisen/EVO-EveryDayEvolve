import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db,
  characterItemsTable,
  checkinsTable,
  coinTransactionsTable,
  userCharacterItemsTable,
  usersTable,
} from "@workspace/db";
import {
  ListCharacterCatalogResponse,
  GetMyCharacterResponse,
  PurchaseCharacterItemParams,
  PurchaseCharacterItemResponse,
  EquipCharacterItemParams,
  EquipCharacterItemResponse,
  UnequipCharacterItemParams,
  UnequipCharacterItemResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { getLevelProgress, getTotalXp, xpToNextLevel } from "../lib/rules";

const router: IRouter = Router();
router.use(requireAuth);

interface CatalogEntry {
  id: number;
  name: string;
  slot: string;
  emoji: string;
  coinCost: number;
  levelRequired: number;
  owned: boolean;
  equipped: boolean;
}

function isStrictlyEmptyBody(body: unknown): boolean {
  if (body === undefined) return true;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  return Object.keys(body).length === 0;
}

async function catalogWithState(userId: string): Promise<CatalogEntry[]> {
  const items = await db.select().from(characterItemsTable);
  const owned = await db
    .select()
    .from(userCharacterItemsTable)
    .where(eq(userCharacterItemsTable.userId, userId));
  const ownedMap = new Map(owned.map((o) => [o.itemId, o]));

  return items.map((item) => {
    const ownedRow = ownedMap.get(item.id);
    return {
      id: item.id,
      name: item.name,
      slot: item.slot,
      emoji: item.emoji,
      coinCost: item.coinCost,
      levelRequired: item.levelRequired,
      owned: !!ownedRow,
      equipped: !!ownedRow?.equipped,
    };
  });
}

router.get("/character/catalog", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const catalog = await catalogWithState(req.userId!);
  res.json(ListCharacterCatalogResponse.parse(catalog));
});

router.get("/character/me", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  const [catalog, recentRows] = await Promise.all([
    catalogWithState(req.userId!),
    db
      .select({
        date: checkinsTable.date,
        xpEarned: checkinsTable.xpEarned,
        coinsEarned: checkinsTable.coinsEarned,
        rewardGranted: checkinsTable.rewardGranted,
      })
      .from(checkinsTable)
      .where(and(eq(checkinsTable.userId, req.userId!), eq(checkinsTable.completed, true)))
      .orderBy(desc(checkinsTable.date), desc(checkinsTable.id))
      .limit(50),
  ]);
  const recentProgress = recentRows
    .map((row) => ({
      date: row.date,
      xpEarned: row.xpEarned,
      coinsEarned: row.rewardGranted || row.coinsEarned > 0 ? row.coinsEarned : null,
    }))
    .filter((entry) => entry.xpEarned !== null || entry.coinsEarned !== null)
    .slice(0, 5);
  const { progressPercent } = getLevelProgress(user.level, user.xp);

  res.json(
    GetMyCharacterResponse.parse({
      level: user.level,
      xp: user.xp,
      xpToNextLevel: xpToNextLevel(user.level),
      totalXp: getTotalXp(user.level, user.xp),
      nextLevelXp: xpToNextLevel(user.level),
      progressPercent,
      walletCoins: user.coins,
      equippedItems: catalog.filter((i) => i.equipped),
      recentProgress,
    }),
  );
});

router.post("/character/items/:itemId/purchase", async (req, res): Promise<void> => {
  if (!isStrictlyEmptyBody(req.body)) {
    res.status(400).json({ error: "Purchase requests must not include a body" });
    return;
  }
  await ensureUser(req.userId!);
  const params = PurchaseCharacterItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.userId!))
      .for("update");
    if (!user) return { kind: "user-not-found" as const };

    const [item] = await tx
      .select()
      .from(characterItemsTable)
      .where(eq(characterItemsTable.id, params.data.itemId));
    if (!item) return { kind: "item-not-found" as const };

    if (!Number.isSafeInteger(item.coinCost) || item.coinCost < 0) {
      return { kind: "invalid-price" as const };
    }
    if (!Number.isSafeInteger(item.levelRequired) || item.levelRequired < 0) {
      return { kind: "invalid-level-requirement" as const };
    }
    if (user.level < item.levelRequired) return { kind: "insufficient-level" as const };

    const [alreadyOwned] = await tx
      .select({ id: userCharacterItemsTable.id })
      .from(userCharacterItemsTable)
      .where(
        and(
          eq(userCharacterItemsTable.userId, req.userId!),
          eq(userCharacterItemsTable.itemId, item.id),
        ),
      );
    if (alreadyOwned) return { kind: "already-owned" as const };
    if (user.coins < item.coinCost) return { kind: "insufficient-coins" as const };

    // User row locking serializes same-user purchases; the unique constraint is
    // still treated as a conflict in case a writer bypasses this route.
    const [inventoryItem] = await tx
      .insert(userCharacterItemsTable)
      .values({ userId: req.userId!, itemId: item.id })
      .onConflictDoNothing()
      .returning();
    if (!inventoryItem) return { kind: "already-owned" as const };

    const [updatedUser] = await tx
      .update(usersTable)
      .set({ coins: sql`${usersTable.coins} - ${item.coinCost}` })
      .where(and(eq(usersTable.id, req.userId!), gte(usersTable.coins, item.coinCost)))
      .returning({ id: usersTable.id });
    if (!updatedUser) {
      // Throw so the preceding inventory insert is rolled back with the debit.
      throw new Error("Wallet changed while purchasing a character item");
    }

    await tx.insert(coinTransactionsTable).values({
      userId: req.userId!,
      amount: -item.coinCost,
      reason: "item_purchase",
    });

    return { kind: "purchased" as const, item };
  });

  if (outcome.kind === "item-not-found") {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  if (outcome.kind === "user-not-found") {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (outcome.kind === "already-owned") {
    res.status(409).json({ error: "Item already owned" });
    return;
  }
  if (outcome.kind === "insufficient-coins") {
    res.status(400).json({ error: "Not enough coins" });
    return;
  }
  if (outcome.kind === "insufficient-level") {
    res.status(400).json({ error: "Required level not reached" });
    return;
  }
  if (outcome.kind === "invalid-price" || outcome.kind === "invalid-level-requirement") {
    res.status(400).json({ error: "Invalid item purchase requirements" });
    return;
  }

  const { item } = outcome;
  res.json(
    PurchaseCharacterItemResponse.parse({
      id: item.id,
      name: item.name,
      slot: item.slot,
      emoji: item.emoji,
      coinCost: item.coinCost,
      levelRequired: item.levelRequired,
      owned: true,
      equipped: false,
    }),
  );
});

router.post("/character/items/:itemId/equip", async (req, res): Promise<void> => {
  if (!isStrictlyEmptyBody(req.body)) {
    res.status(400).json({ error: "Equip requests must not include a body" });
    return;
  }
  await ensureUser(req.userId!);
  const params = EquipCharacterItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, req.userId!))
      .for("update");
    if (!user) return { kind: "user-not-found" as const };

    const [item] = await tx
      .select()
      .from(characterItemsTable)
      .where(eq(characterItemsTable.id, params.data.itemId));
    if (!item) return { kind: "item-not-found" as const };

    const [owned] = await tx
      .select({ id: userCharacterItemsTable.id })
      .from(userCharacterItemsTable)
      .where(
        and(
          eq(userCharacterItemsTable.userId, req.userId!),
          eq(userCharacterItemsTable.itemId, item.id),
        ),
      );
    if (!owned) return { kind: "not-owned" as const };

    const slotItems = await tx
      .select({ id: characterItemsTable.id })
      .from(characterItemsTable)
      .where(eq(characterItemsTable.slot, item.slot));
    const slotItemIds = slotItems.map((slotItem) => slotItem.id);
    await tx
      .update(userCharacterItemsTable)
      .set({ equipped: false })
      .where(
        and(
          eq(userCharacterItemsTable.userId, req.userId!),
          inArray(userCharacterItemsTable.itemId, slotItemIds),
        ),
      );
    await tx
      .update(userCharacterItemsTable)
      .set({ equipped: true })
      .where(
        and(
          eq(userCharacterItemsTable.userId, req.userId!),
          eq(userCharacterItemsTable.itemId, item.id),
        ),
      );
    return { kind: "equipped" as const, item };
  });

  if (outcome.kind === "item-not-found") {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  if (outcome.kind === "user-not-found") {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (outcome.kind === "not-owned") {
    res.status(400).json({ error: "Item not owned" });
    return;
  }

  const { item } = outcome;
  res.json(
    EquipCharacterItemResponse.parse({
      id: item.id,
      name: item.name,
      slot: item.slot,
      emoji: item.emoji,
      coinCost: item.coinCost,
      levelRequired: item.levelRequired,
      owned: true,
      equipped: true,
    }),
  );
});

router.post("/character/items/:itemId/unequip", async (req, res): Promise<void> => {
  if (!isStrictlyEmptyBody(req.body)) {
    res.status(400).json({ error: "Unequip requests must not include a body" });
    return;
  }
  await ensureUser(req.userId!);
  const params = UnequipCharacterItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, req.userId!))
      .for("update");
    if (!user) return { kind: "user-not-found" as const };

    const [item] = await tx
      .select()
      .from(characterItemsTable)
      .where(eq(characterItemsTable.id, params.data.itemId));
    if (!item) return { kind: "item-not-found" as const };

    const [owned] = await tx
      .select({ id: userCharacterItemsTable.id })
      .from(userCharacterItemsTable)
      .where(
        and(
          eq(userCharacterItemsTable.userId, req.userId!),
          eq(userCharacterItemsTable.itemId, item.id),
        ),
      );
    if (!owned) return { kind: "not-owned" as const };

    await tx
      .update(userCharacterItemsTable)
      .set({ equipped: false })
      .where(
        and(
          eq(userCharacterItemsTable.userId, req.userId!),
          eq(userCharacterItemsTable.itemId, item.id),
        ),
      );
    return { kind: "unequipped" as const, item };
  });

  if (outcome.kind === "item-not-found") {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  if (outcome.kind === "user-not-found") {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (outcome.kind === "not-owned") {
    res.status(400).json({ error: "Item not owned" });
    return;
  }

  const { item } = outcome;
  res.json(
    UnequipCharacterItemResponse.parse({
      id: item.id,
      name: item.name,
      slot: item.slot,
      emoji: item.emoji,
      coinCost: item.coinCost,
      levelRequired: item.levelRequired,
      owned: true,
      equipped: false,
    }),
  );
});

export default router;