import { date, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const dayAnalysisCacheTable = pgTable("day_analysis_cache", {
  userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  dataHash: text("data_hash").notNull(),
  analysis: jsonb("analysis").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("day_analysis_cache_user_date_unique").on(table.userId, table.date)]);