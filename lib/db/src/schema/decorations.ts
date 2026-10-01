import {
  check,
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { habitsTable } from "./habits";

export const decorationItemsTable = pgTable("decoration_items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  assetFile: text("asset_file").notNull().unique(),
  sourceAsset: text("source_asset").notNull().unique(),
  coinCost: integer("coin_cost").notNull(),
}, (table) => [check("decoration_items_coin_cost_positive", sql`${table.coinCost} > 0`)]);

export const userDecorationsTable = pgTable("user_decorations", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => decorationItemsTable.id, { onDelete: "cascade" }),
  purchasedAt: timestamp("purchased_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique("user_decorations_user_item_unique").on(table.userId, table.itemId)]);

export const habitDecorationsTable = pgTable("habit_decorations", {
  id: serial("id").primaryKey(),
  habitId: integer("habit_id").notNull().references(() => habitsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => decorationItemsTable.id, { onDelete: "cascade" }),
  islandId: text("island_id").notNull(),
  slot: integer("slot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("habit_decorations_habit_item_unique").on(table.habitId, table.itemId),
  unique("habit_decorations_habit_island_slot_unique").on(table.habitId, table.islandId, table.slot),
  check("habit_decorations_island_valid", sql`${table.islandId} IN ('beginnings', 'study', 'forest', 'dreams', 'heart', 'adventure')`),
  check("habit_decorations_slot_valid", sql`${table.slot} BETWEEN 0 AND 5`),
]);

export const decorationPurchaseKeysTable = pgTable("decoration_purchase_keys", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  itemId: integer("item_id").notNull().references(() => decorationItemsTable.id, { onDelete: "cascade" }),
  purchased: boolean("purchased").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("decoration_purchase_keys_user_key_unique").on(table.userId, table.idempotencyKey),
  check("decoration_purchase_keys_key_length", sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 128`),
]);

export type DecorationItemRow = typeof decorationItemsTable.$inferSelect;
export type UserDecorationRow = typeof userDecorationsTable.$inferSelect;
export type HabitDecorationRow = typeof habitDecorationsTable.$inferSelect;