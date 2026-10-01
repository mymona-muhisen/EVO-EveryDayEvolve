import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Owner provenance for private upload paths minted by the authenticated upload
 * URL endpoint. It lets resource creation prove an unowned object path belongs
 * to the user before attaching it and setting its private ACL.
 */
export const objectUploadsTable = pgTable("object_uploads", {
  objectPath: text("object_path").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("object_uploads_owner_idx").on(table.userId),
]);

export type ObjectUploadRow = typeof objectUploadsTable.$inferSelect;