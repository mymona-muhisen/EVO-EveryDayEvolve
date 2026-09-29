import { pgTable, serial, integer, text, date, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { habitsTable } from "./habits";

export const memoriesTable = pgTable("memories", {
  id: serial("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  habitId: integer("habit_id").references(() => habitsTable.id, {
    onDelete: "set null",
  }),
  note: text("note").notNull(),
  // Raw object path from the storage upload flow (e.g. "/objects/uploads/uuid").
  // Mapped to the public `photoUrl` field (/api/storage${photoObjectPath}) in routes.
  photoObjectPath: text("photo_object_path"),
  date: date("date", { mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type MemoryRow = typeof memoriesTable.$inferSelect;
