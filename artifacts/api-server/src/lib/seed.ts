import { db, characterItemsTable, journeyMilestonesTable } from "@workspace/db";
import { logger } from "./logger";
import { seedDecorationCatalog } from "./decorationCatalog";

// Global catalogs, seeded once and shared by all users. Idempotent via
// onConflictDoNothing (unique on name / levelRequired) — safe to run on
// every server startup.
const CHARACTER_ITEMS = [
  { name: "قميص المسافر", slot: "outfit", emoji: "👕", coinCost: 0 },
  { name: "سترة الرحالة", slot: "outfit", emoji: "🧥", coinCost: 40 },
  { name: "بدلة المغامر", slot: "outfit", emoji: "🥾", coinCost: 90 },
  { name: "قبعة الصيف", slot: "hat", emoji: "👒", coinCost: 20 },
  { name: "قبعة الاستكشاف", slot: "hat", emoji: "🧢", coinCost: 35 },
  { name: "تاج الإنجاز", slot: "hat", emoji: "👑", coinCost: 150 },
  { name: "نظارة شمسية", slot: "accessory", emoji: "🕶️", coinCost: 25 },
  { name: "حقيبة الظهر", slot: "accessory", emoji: "🎒", coinCost: 45 },
  { name: "وشاح النجوم", slot: "accessory", emoji: "🧣", coinCost: 60 },
  { name: "قطة رفيقة", slot: "pet", emoji: "🐱", coinCost: 50 },
  { name: "طائر مرافق", slot: "pet", emoji: "🦜", coinCost: 70 },
  { name: "تنين صغير", slot: "pet", emoji: "🐉", coinCost: 200 },
  { name: "غروب الشمس", slot: "background", emoji: "🌅", coinCost: 30 },
  { name: "غابة هادئة", slot: "background", emoji: "🌲", coinCost: 55 },
  { name: "سماء مرصعة بالنجوم", slot: "background", emoji: "🌌", coinCost: 100 },
] as const;

const JOURNEY_MILESTONES = [
  { levelRequired: 1, title: "بداية الرحلة", description: "انطلقت في رحلة بناء عاداتك الجديدة.", emoji: "🌱", rewardCoins: 0 },
  { levelRequired: 3, title: "أولى الخطوات", description: "أثبتّ أنك قادر على الالتزام.", emoji: "🥾", rewardCoins: 20 },
  { levelRequired: 5, title: "عبور الوادي", description: "تجاوزت أول تحدٍ حقيقي في رحلتك.", emoji: "🏞️", rewardCoins: 30 },
  { levelRequired: 8, title: "قمة التركيز", description: "وصلت إلى مستوى جديد من الانضباط.", emoji: "⛰️", rewardCoins: 40 },
  { levelRequired: 12, title: "واحة الاستقرار", description: "عاداتك أصبحت جزءًا من روتينك اليومي.", emoji: "🌴", rewardCoins: 60 },
  { levelRequired: 16, title: "جسر التحول", description: "أنت شخص مختلف عمّن بدأ هذه الرحلة.", emoji: "🌉", rewardCoins: 80 },
  { levelRequired: 20, title: "قلعة الإنجاز", description: "وصلت إلى إنجاز يستحق الفخر.", emoji: "🏰", rewardCoins: 120 },
  { levelRequired: 25, title: "قمة الرحلة", description: "بلغت ذروة رحلتك... وما زال أمامك المزيد.", emoji: "🏔️", rewardCoins: 200 },
] as const;

export async function seedCatalogs(): Promise<void> {
  await db.insert(characterItemsTable).values([...CHARACTER_ITEMS]).onConflictDoNothing();
  await db.insert(journeyMilestonesTable).values([...JOURNEY_MILESTONES]).onConflictDoNothing();
  await seedDecorationCatalog();
  logger.info("Catalog seed check complete (character items + journey milestones + island decorations)");
}
