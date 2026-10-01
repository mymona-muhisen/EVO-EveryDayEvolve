import { sql } from "drizzle-orm";
import {
  date,
  integer,
  index,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { habitsTable } from "./habits";
import { habitDaysTable } from "./habitJourney";

export const memoryVisibilityEnum = pgEnum("memory_visibility", [
  "private",
  "friends",
  "selected",
  "public",
]);

export const memoriesTable = pgTable(
  "memories",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    habitId: integer("habit_id").references(() => habitsTable.id, {
      onDelete: "set null",
    }),
    habitDayId: integer("habit_day_id").references(() => habitDaysTable.id, {
      onDelete: "set null",
    }),
    note: text("note").notNull(),
    caption: text("caption"),
    visibility: memoryVisibilityEnum("visibility").notNull().default("private"),
    // Raw object path from storage; photoUrl remains an authenticated ACL URL.
    photoObjectPath: text("photo_object_path"),
    date: date("date", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("memories_owner_date_idx").on(table.userId, table.date.desc()),
    index("memories_photo_object_path_idx").on(table.photoObjectPath),
    uniqueIndex("memories_habit_day_unique")
      .on(table.habitDayId)
      .where(sql`${table.habitDayId} IS NOT NULL`),
  ],
);

export type MemoryRow = typeof memoriesTable.$inferSelect;
