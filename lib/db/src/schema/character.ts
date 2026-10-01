import {
  pgEnum,
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const characterItemSlotEnum = pgEnum("character_item_slot", [
  "outfit",
  "hat",
  "accessory",
  "pet",
  "background",
]);

// Global catalog — seeded once, shared by all users.
export const characterItemsTable = pgTable("character_items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  slot: characterItemSlotEnum("slot").notNull(),
  emoji: text("emoji").notNull(),
  coinCost: integer("coin_cost").notNull(),
  levelRequired: integer("level_required").notNull().default(0),
});

export const userCharacterItemsTable = pgTable(
  "user_character_items",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    itemId: integer("item_id")
      .notNull()
      .references(() => characterItemsTable.id, { onDelete: "cascade" }),
    equipped: boolean("equipped").notNull().default(false),
    purchasedAt: timestamp("purchased_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("user_character_items_user_item_unique").on(
      table.userId,
      table.itemId,
    ),
  ],
);

export type CharacterItemRow = typeof characterItemsTable.$inferSelect;
export type UserCharacterItemRow = typeof userCharacterItemsTable.$inferSelect;
