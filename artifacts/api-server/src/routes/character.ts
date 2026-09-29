import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, characterItemsTable, userCharacterItemsTable } from "@workspace/db";
import {
  ListCharacterCatalogResponse,
  GetMyCharacterResponse,
  PurchaseCharacterItemParams,
  PurchaseCharacterItemResponse,
  EquipCharacterItemParams,
  EquipCharacterItemResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { spendCoins } from "../lib/gamificationService";
import { xpToNextLevel } from "../lib/rules";

const router: IRouter = Router();
router.use(requireAuth);

interface CatalogEntry {
  id: number;
  name: string;
  slot: string;
  emoji: string;
  coinCost: number;
  owned: boolean;
  equipped: boolean;
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
  const catalog = await catalogWithState(req.userId!);

  res.json(
    GetMyCharacterResponse.parse({
      level: user.level,
      xp: user.xp,
      xpToNextLevel: xpToNextLevel(user.level),
      equippedItems: catalog.filter((i) => i.equipped),
    }),
  );
});

router.post("/character/items/:itemId/purchase", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = PurchaseCharacterItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [item] = await db
    .select()
    .from(characterItemsTable)
    .where(eq(characterItemsTable.id, params.data.itemId));
  if (!item) {
    res.status(400).json({ error: "Item not found" });
    return;
  }

  const [alreadyOwned] = await db
    .select()
    .from(userCharacterItemsTable)
    .where(and(eq(userCharacterItemsTable.userId, req.userId!), eq(userCharacterItemsTable.itemId, item.id)));
  if (alreadyOwned) {
    res.status(400).json({ error: "Item already owned" });
    return;
  }

  const spendResult = await spendCoins(req.userId!, item.coinCost, "item_purchase");
  if (!spendResult) {
    res.status(400).json({ error: "Not enough coins" });
    return;
  }

  await db.insert(userCharacterItemsTable).values({ userId: req.userId!, itemId: item.id });

  res.json(
    PurchaseCharacterItemResponse.parse({
      id: item.id,
      name: item.name,
      slot: item.slot,
      emoji: item.emoji,
      coinCost: item.coinCost,
      owned: true,
      equipped: false,
    }),
  );
});

router.post("/character/items/:itemId/equip", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const params = EquipCharacterItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [item] = await db
    .select()
    .from(characterItemsTable)
    .where(eq(characterItemsTable.id, params.data.itemId));
  if (!item) {
    res.status(400).json({ error: "Item not found" });
    return;
  }

  const [owned] = await db
    .select()
    .from(userCharacterItemsTable)
    .where(and(eq(userCharacterItemsTable.userId, req.userId!), eq(userCharacterItemsTable.itemId, item.id)));
  if (!owned) {
    res.status(400).json({ error: "Item not owned" });
    return;
  }

  const slotItems = await db
    .select({ id: characterItemsTable.id })
    .from(characterItemsTable)
    .where(eq(characterItemsTable.slot, item.slot));
  const slotItemIds = slotItems.map((i) => i.id);
  if (slotItemIds.length > 0) {
    await db
      .update(userCharacterItemsTable)
      .set({ equipped: false })
      .where(
        and(
          eq(userCharacterItemsTable.userId, req.userId!),
          inArray(userCharacterItemsTable.itemId, slotItemIds),
        ),
      );
  }

  await db
    .update(userCharacterItemsTable)
    .set({ equipped: true })
    .where(and(eq(userCharacterItemsTable.userId, req.userId!), eq(userCharacterItemsTable.itemId, item.id)));

  res.json(
    EquipCharacterItemResponse.parse({
      id: item.id,
      name: item.name,
      slot: item.slot,
      emoji: item.emoji,
      coinCost: item.coinCost,
      owned: true,
      equipped: true,
    }),
  );
});

export default router;
