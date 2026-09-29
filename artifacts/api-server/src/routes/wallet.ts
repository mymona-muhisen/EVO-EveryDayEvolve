import { Router, type IRouter } from "express";
import { eq, and, gte, desc } from "drizzle-orm";
import { db, coinTransactionsTable } from "@workspace/db";
import {
  GetWalletResponse,
  ListWalletTransactionsQueryParams,
  ListWalletTransactionsResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/wallet", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);

  const weekAgo = new Date();
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);

  const transactions = await db
    .select()
    .from(coinTransactionsTable)
    .where(and(eq(coinTransactionsTable.userId, req.userId!), gte(coinTransactionsTable.createdAt, weekAgo)));

  let earnedThisWeek = 0;
  let spentThisWeek = 0;
  for (const t of transactions) {
    if (t.amount > 0) earnedThisWeek += t.amount;
    else spentThisWeek += -t.amount;
  }

  res.json(GetWalletResponse.parse({ coins: user.coins, earnedThisWeek, spentThisWeek }));
});

router.get("/wallet/transactions", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const query = ListWalletTransactionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const limit = query.data.limit ?? 20;
  const transactions = await db
    .select()
    .from(coinTransactionsTable)
    .where(eq(coinTransactionsTable.userId, req.userId!))
    .orderBy(desc(coinTransactionsTable.createdAt))
    .limit(limit);

  res.json(ListWalletTransactionsResponse.parse(transactions));
});

export default router;
