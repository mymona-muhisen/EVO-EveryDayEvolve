import { pgEnum, pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const coinTransactionReasonEnum = pgEnum("coin_transaction_reason", [
  "checkin",
  "streak_bonus",
  "streak_recovery",
  "reward_redemption",
  "item_purchase",
  "challenge_bonus",
  "manual",
]);

export const coinTransactionsTable = pgTable("coin_transactions", {
  id: serial("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  amount: integer("amount").notNull(),
  reason: coinTransactionReasonEnum("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CoinTransactionRow = typeof coinTransactionsTable.$inferSelect;
