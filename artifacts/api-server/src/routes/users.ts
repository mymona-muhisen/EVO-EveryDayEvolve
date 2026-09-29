import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  GetCurrentUserResponse,
  UpdateCurrentUserBody,
  UpdateCurrentUserResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { ensureUser } from "../lib/userService";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/users/me", async (req, res): Promise<void> => {
  const user = await ensureUser(req.userId!);
  res.json(GetCurrentUserResponse.parse(user));
});

router.patch("/users/me", async (req, res): Promise<void> => {
  await ensureUser(req.userId!);
  const parsed = UpdateCurrentUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set(parsed.data)
    .where(eq(usersTable.id, req.userId!))
    .returning();

  res.json(UpdateCurrentUserResponse.parse(updated));
});

export default router;
