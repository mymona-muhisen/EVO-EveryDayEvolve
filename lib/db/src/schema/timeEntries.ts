import { pgTable, serial, integer, text, date, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { habitsTable } from "./habits";

export const timeEntriesTable = pgTable("time_entries", {
  id: serial("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  habitId: integer("habit_id").references(() => habitsTable.id, {
    onDelete: "set null",
  }),
  label: text("label").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  date: date("date", { mode: "string" }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TimeEntryRow = typeof timeEntriesTable.$inferSelect;
