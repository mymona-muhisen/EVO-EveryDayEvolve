import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, journeyMilestonesTable, userJourneyMilestonesTable } from "@workspace/db";
import { GetJourneyProgressResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";
import { xpToNextLevel } from "../lib/rules";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/journey/progress", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);

  const milestones = await db
    .select()
    .from(journeyMilestonesTable)
    .orderBy(journeyMilestonesTable.levelRequired);
  const reached = await db
    .select()
    .from(userJourneyMilestonesTable)
    .where(eq(userJourneyMilestonesTable.userId, req.userId!));
  const reachedIds = new Set(reached.map((r) => r.milestoneId));

  res.json(
    GetJourneyProgressResponse.parse({
      level: user.level,
      xp: user.xp,
      xpToNextLevel: xpToNextLevel(user.level),
      milestones: milestones.map((m) => ({
        id: m.id,
        levelRequired: m.levelRequired,
        title: m.title,
        description: m.description,
        emoji: m.emoji,
        rewardCoins: m.rewardCoins,
        reached: reachedIds.has(m.id),
      })),
    }),
  );
});

export default router;
