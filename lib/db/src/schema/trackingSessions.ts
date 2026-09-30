import { pgTable, serial, text, date, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const trackingSessionsTable = pgTable("tracking_sessions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  status: text("status").notNull().default("active"),
  intervalMinutes: integer("interval_minutes").notNull().default(15),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastCheckinAt: timestamp("last_checkin_at", { withTimezone: true }),
  nextCheckinAt: timestamp("next_checkin_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [uniqueIndex("tracking_sessions_user_date_unique").on(t.userId, t.date)]);