import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db, usersTable, type UserRow } from "@workspace/db";

/**
 * Fetches the current user's row, JIT-provisioning it on first access.
 * Every route that touches user-scoped data should call this instead of a
 * raw select, so a fresh Clerk sign-in always has a backing row before any
 * foreign-key-dependent insert runs.
 */
export async function ensureUser(userId: string): Promise<UserRow> {
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (existing) return existing;

  let displayName = "مستخدم جديد";
  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    displayName =
      clerkUser.firstName?.trim() ||
      clerkUser.username?.trim() ||
      clerkUser.emailAddresses[0]?.emailAddress?.split("@")[0] ||
      displayName;
  } catch {
    // Best-effort — fall back to the default name if Clerk lookup fails.
  }

  const [created] = await db
    .insert(usersTable)
    .values({ id: userId, displayName })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  // Concurrent request provisioned it first — fetch that row instead.
  const [row] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return row;
}
