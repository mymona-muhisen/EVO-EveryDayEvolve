import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";

/**
 * Requires a valid Clerk session. On success, sets `req.userId` to the
 * Clerk user id for downstream handlers to use. Responds 401 otherwise.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  next();
}
