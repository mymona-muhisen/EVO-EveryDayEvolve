import { sql } from "drizzle-orm";
import { db, decorationItemsTable } from "@workspace/db";

/** Stable catalog IDs match the additive 0004 seed; do not renumber existing items. */
export const DECORATION_ITEMS = [
  { id: 1, name: "عصفور أصفر", assetFile: "component-a-cute-yellow-bird-pixel-art-character-for-a-cozy-adven.webp", sourceAsset: "level-22-assets/components/A-cute-yellow-bird-pixel-art-character-for-a-cozy-adven.png", coinCost: 10 },
  { id: 2, name: "عربة الفن", assetFile: "component-artcart.webp", sourceAsset: "level-22-assets/components/artcart.webp", coinCost: 20 },
  { id: 3, name: "سرير", assetFile: "component-bed.webp", sourceAsset: "level-22-assets/components/bed.webp", coinCost: 20 },
  { id: 4, name: "كعكة عيد الميلاد", assetFile: "component-birthday-cake.webp", sourceAsset: "level-22-assets/components/birthday cake.png", coinCost: 20 },
  { id: 5, name: "كتاب مفتوح", assetFile: "component-book-open.webp", sourceAsset: "level-22-assets/components/book_open.webp", coinCost: 10 },
  { id: 6, name: "كومة كتب", assetFile: "component-book-stack.webp", sourceAsset: "level-22-assets/components/book_stack.webp", coinCost: 10 },
  { id: 7, name: "جسر خشبي جانبي", assetFile: "component-bridge-side.webp", sourceAsset: "level-22-assets/components/bridge-wooden-من الجانب.png", coinCost: 30 },
  { id: 8, name: "جسر خشبي", assetFile: "component-bridge-wooden.webp", sourceAsset: "level-22-assets/components/bridge-wooden.png", coinCost: 30 },
  { id: 9, name: "قفص", assetFile: "component-cage.webp", sourceAsset: "level-22-assets/components/cage.webp", coinCost: 20 },
  { id: 10, name: "كرسي", assetFile: "component-chair.webp", sourceAsset: "level-22-assets/components/chair.webp", coinCost: 10 },
  { id: 11, name: "قهوة", assetFile: "component-coffee.webp", sourceAsset: "level-22-assets/components/coffee.webp", coinCost: 10 },
  { id: 12, name: "مكتب", assetFile: "component-desk.webp", sourceAsset: "level-22-assets/components/desk.webp", coinCost: 20 },
  { id: 13, name: "حامل رسم", assetFile: "component-easel.webp", sourceAsset: "level-22-assets/components/easel.webp", coinCost: 20 },
  { id: 14, name: "سماعات", assetFile: "component-headphones.webp", sourceAsset: "level-22-assets/components/headphones.webp", coinCost: 10 },
  { id: 15, name: "حاسوب محمول", assetFile: "component-laptop.webp", sourceAsset: "level-22-assets/components/laptop.webp", coinCost: 20 },
  { id: 16, name: "نجمة متلألئة", assetFile: "component-pikura-star-20750.gif", sourceAsset: "level-22-assets/components/pikura-star-20750.gif", coinCost: 20 },
  { id: 17, name: "مشهد غرفة نوم", assetFile: "component-scene-2-bedroom-island-assets.webp", sourceAsset: "level-22-assets/components/scene_2_bedroom_island_assets-removebg-preview.png", coinCost: 30 },
  { id: 18, name: "طاولة", assetFile: "component-table.webp", sourceAsset: "level-22-assets/components/table.webp", coinCost: 10 },
  { id: 19, name: "جسر علوي", assetFile: "component-bridge-top.webp", sourceAsset: "level-22-assets/components/الجسر_من_فوق-removebg-preview.png", coinCost: 30 },
  { id: 20, name: "متاجر الجزيرة", assetFile: "component-shops.webp", sourceAsset: "level-22-assets/components/المتاجر_الموجودة_فوق_الجزيرة_الثانية-removebg-preview.png", coinCost: 30 },
  { id: 21, name: "مباني التقنية", assetFile: "component-tech-buildings.webp", sourceAsset: "level-22-assets/components/المواقع_فوق_جزيرة_techno-removebg-preview.png", coinCost: 30 },
  { id: 22, name: "جسر طويل", assetFile: "component-bridge-long.webp", sourceAsset: "level-22-assets/components/جسر طويل.png", coinCost: 30 },
  { id: 23, name: "عناصر جزيرة القلب", assetFile: "component-heart-elements.webp", sourceAsset: "level-22-assets/components/عناصر_جزيرة_القلب-removebg-preview.png", coinCost: 30 },
] as const;

/** Safe on every startup: existing IDs and prices are never overwritten. */
export async function seedDecorationCatalog(): Promise<void> {
  await db.insert(decorationItemsTable)
    .values([...DECORATION_ITEMS])
    .onConflictDoNothing();
  // Explicit stable IDs are used for production parity with migration 0004.
  // Keep the serial default ready for any later additive catalog entries.
  await db.execute(sql`SELECT setval(
    pg_get_serial_sequence('decoration_items', 'id'),
    GREATEST((SELECT COALESCE(MAX(id), 1) FROM decoration_items), 1),
    true
  )`);
}