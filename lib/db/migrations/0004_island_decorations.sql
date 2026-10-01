CREATE TABLE decoration_items (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  asset_file text NOT NULL UNIQUE,
  source_asset text NOT NULL UNIQUE,
  coin_cost integer NOT NULL CHECK (coin_cost > 0)
);

CREATE TABLE user_decorations (
  id serial PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id integer NOT NULL REFERENCES decoration_items(id) ON DELETE CASCADE,
  purchased_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_decorations_user_item_unique UNIQUE (user_id, item_id)
);

CREATE TABLE habit_decorations (
  id serial PRIMARY KEY,
  habit_id integer NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  item_id integer NOT NULL REFERENCES decoration_items(id) ON DELETE CASCADE,
  island_id text NOT NULL CHECK (island_id IN ('beginnings', 'study', 'forest', 'dreams', 'heart', 'adventure')),
  slot integer NOT NULL CHECK (slot BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT habit_decorations_habit_item_unique UNIQUE (habit_id, item_id),
  CONSTRAINT habit_decorations_habit_island_slot_unique UNIQUE (habit_id, island_id, slot)
);

CREATE TABLE decoration_purchase_keys (
  id serial PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  item_id integer NOT NULL REFERENCES decoration_items(id) ON DELETE CASCADE,
  purchased boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decoration_purchase_keys_user_key_unique UNIQUE (user_id, idempotency_key)
);

-- Canonical assets in manifest.json with category=component and source folder=components.
-- IDs are fixed catalog identities; sourceAsset and assetFile are unique to prevent aliases.
INSERT INTO decoration_items (id, name, asset_file, source_asset, coin_cost) VALUES
  (1, 'عصفور أصفر', 'component-a-cute-yellow-bird-pixel-art-character-for-a-cozy-adven.webp', 'level-22-assets/components/A-cute-yellow-bird-pixel-art-character-for-a-cozy-adven.png', 10),
  (2, 'عربة الفن', 'component-artcart.webp', 'level-22-assets/components/artcart.webp', 20),
  (3, 'سرير', 'component-bed.webp', 'level-22-assets/components/bed.webp', 20),
  (4, 'كعكة عيد الميلاد', 'component-birthday-cake.webp', 'level-22-assets/components/birthday cake.png', 20),
  (5, 'كتاب مفتوح', 'component-book-open.webp', 'level-22-assets/components/book_open.webp', 10),
  (6, 'كومة كتب', 'component-book-stack.webp', 'level-22-assets/components/book_stack.webp', 10),
  (7, 'جسر خشبي جانبي', 'component-bridge-side.webp', 'level-22-assets/components/bridge-wooden-من الجانب.png', 30),
  (8, 'جسر خشبي', 'component-bridge-wooden.webp', 'level-22-assets/components/bridge-wooden.png', 30),
  (9, 'قفص', 'component-cage.webp', 'level-22-assets/components/cage.webp', 20),
  (10, 'كرسي', 'component-chair.webp', 'level-22-assets/components/chair.webp', 10),
  (11, 'قهوة', 'component-coffee.webp', 'level-22-assets/components/coffee.webp', 10),
  (12, 'مكتب', 'component-desk.webp', 'level-22-assets/components/desk.webp', 20),
  (13, 'حامل رسم', 'component-easel.webp', 'level-22-assets/components/easel.webp', 20),
  (14, 'سماعات', 'component-headphones.webp', 'level-22-assets/components/headphones.webp', 10),
  (15, 'حاسوب محمول', 'component-laptop.webp', 'level-22-assets/components/laptop.webp', 20),
  (16, 'نجمة متلألئة', 'component-pikura-star-20750.gif', 'level-22-assets/components/pikura-star-20750.gif', 20),
  (17, 'مشهد غرفة نوم', 'component-scene-2-bedroom-island-assets.webp', 'level-22-assets/components/scene_2_bedroom_island_assets-removebg-preview.png', 30),
  (18, 'طاولة', 'component-table.webp', 'level-22-assets/components/table.webp', 10),
  (19, 'جسر علوي', 'component-bridge-top.webp', 'level-22-assets/components/الجسر_من_فوق-removebg-preview.png', 30),
  (20, 'متاجر الجزيرة', 'component-shops.webp', 'level-22-assets/components/المتاجر_الموجودة_فوق_الجزيرة_الثانية-removebg-preview.png', 30),
  (21, 'مباني التقنية', 'component-tech-buildings.webp', 'level-22-assets/components/المواقع_فوق_جزيرة_techno-removebg-preview.png', 30),
  (22, 'جسر طويل', 'component-bridge-long.webp', 'level-22-assets/components/جسر طويل.png', 30),
  (23, 'عناصر جزيرة القلب', 'component-heart-elements.webp', 'level-22-assets/components/عناصر_جزيرة_القلب-removebg-preview.png', 30);

SELECT setval(pg_get_serial_sequence('decoration_items', 'id'), (SELECT MAX(id) FROM decoration_items));