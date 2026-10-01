import type { CharacterItem } from '@workspace/api-client-react';

// Appearance needs no prices, inventory ownership, or wallet fields. This also
// accepts the deliberately smaller, consent-filtered social projection.
type CharacterAppearanceItem = Pick<CharacterItem, 'name' | 'emoji' | 'slot'> & { id?: number };
const appearanceKey = (item: CharacterAppearanceItem) => item.id == null ? `${item.slot}:${item.name}:${item.emoji}` : String(item.id);

const BASE = import.meta.env.BASE_URL;
export const CHARACTER_SPRITE = `${BASE}journey-assets/character-idle.gif`;
export const CHARACTER_STILL = `${BASE}journey-assets/character-idle-still.webp`;
export const slotLabels: Record<string, string> = { outfit: 'ملابس', hat: 'قبعات', accessory: 'إكسسوارات', pet: 'رفقاء', background: 'خلفيات' };

const BIRD = `${BASE}journey-assets/component-a-cute-yellow-bird-pixel-art-character-for-a-cozy-adven.webp`;
// Catalog metadata (emoji key, never rendered) -> deterministic visual identity.
const kindByEmoji: Record<string, string> = {
  '👕': 'shirt', '🧥': 'jacket', '🥾': 'adventurer', '👒': 'sunhat', '🧢': 'cap', '👑': 'crown',
  '🕶️': 'glasses', '🎒': 'backpack', '🧣': 'scarf', '🐱': 'cat', '🦜': 'bird', '🐉': 'dragon',
  '🌅': 'sunset', '🌲': 'forest', '🌌': 'night',
};
const kindOf = (i: CharacterAppearanceItem) => kindByEmoji[i.emoji] ?? `${i.slot}-generic`;
const fallbackColor = ['#ce7555', '#4f8a72', '#d9a24f', '#7aa68f'];

function Attachment({ item }: { item: CharacterAppearanceItem }) {
  const k = kindOf(item);
  const colorKey = [...`${item.slot}:${item.name}:${item.emoji}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const f = fallbackColor[Math.abs(colorKey) % 4];
  switch (k) {
    case 'sunset': return <><rect width="100" height="120" fill="#f2b680" opacity=".35" /><circle cx="50" cy="92" r="26" fill="#ce7555" opacity=".4" /></>;
    case 'forest': return <><rect width="100" height="120" fill="#7aa68f" opacity=".25" /><path d="M6 110 L18 70 L30 110Z M70 110 L84 62 L98 110Z" fill="#2f6b55" opacity=".5" /></>;
    case 'night': return <><rect width="100" height="120" fill="#243f5c" opacity=".4" /><g fill="#f5d98b"><circle cx="16" cy="18" r="2" /><circle cx="80" cy="12" r="1.6" /><circle cx="88" cy="40" r="2" /><circle cx="10" cy="52" r="1.4" /></g></>;
    case 'sunhat': return <g><ellipse cx="50" cy="26" rx="30" ry="6" fill="#e8c58e" /><path d="M36 26 Q50 6 64 26Z" fill="#e8c58e" /><rect x="36" y="22" width="28" height="3" fill="#ce7555" /></g>;
    case 'cap': return <g><path d="M34 26 Q50 8 66 26Z" fill="#4f8a72" /><path d="M60 25 L82 27 L60 29Z" fill="#245448" /></g>;
    case 'crown': return <g><path d="M33 26 L35 10 L43 19 L50 7 L57 19 L65 10 L67 26Z" fill="#d9a24f" stroke="#b26648" strokeWidth="1.5" /></g>;
    case 'shirt': return <rect x="33" y="62" width="34" height="18" rx="5" fill="#7aa68f" />;
    case 'jacket': return <g><rect x="31" y="60" width="38" height="22" rx="5" fill="#b26648" /><rect x="49" y="60" width="2" height="22" fill="#fffaf0" /></g>;
    case 'adventurer': return <g><rect x="31" y="60" width="38" height="22" rx="5" fill="#245448" /><rect x="31" y="70" width="38" height="3" fill="#d9a24f" /><rect x="36" y="88" width="10" height="6" rx="2" fill="#6b4a36" /><rect x="54" y="88" width="10" height="6" rx="2" fill="#6b4a36" /></g>;
    case 'glasses': return <g fill="#173b34"><rect x="36" y="42" width="12" height="8" rx="3" /><rect x="52" y="42" width="12" height="8" rx="3" /><rect x="48" y="45" width="4" height="2" /></g>;
    case 'backpack': return <g><rect x="64" y="58" width="16" height="24" rx="6" fill="#ce7555" /><rect x="67" y="66" width="10" height="6" rx="2" fill="#fffaf0" opacity=".7" /></g>;
    case 'scarf': return <g><rect x="33" y="56" width="34" height="7" rx="3.5" fill="#d9a24f" /><rect x="58" y="60" width="7" height="18" rx="3" fill="#d9a24f" /><circle cx="61" cy="70" r="1.6" fill="#fffaf0" /></g>;
    case 'bird': return <image href={BIRD} x="2" y="82" width="30" height="30" preserveAspectRatio="xMidYMid meet" style={{ imageRendering: 'pixelated' }} />;
    case 'cat': return <g fill="#7a7466"><ellipse cx="16" cy="104" rx="11" ry="8" /><path d="M8 94 L11 85 L16 92Z M24 94 L21 85 L16 92Z" /><path d="M26 106 Q34 96 32 90" stroke="#7a7466" strokeWidth="3" fill="none" /></g>;
    case 'dragon': return <g fill="#4f8a72"><ellipse cx="16" cy="104" rx="12" ry="8" /><circle cx="24" cy="94" r="6" /><path d="M10 96 L14 88 L18 96Z" fill="#ce7555" /><path d="M2 104 Q-2 112 8 112" stroke="#4f8a72" strokeWidth="3" fill="none" /></g>;
    default: return <circle cx="82" cy="40" r="7" fill={f} />;
  }
}

export function CharacterAvatar({ items = [], height = 120, src, className = '', testId, ownerLabel = 'شخصيتك' }: { items?: CharacterAppearanceItem[]; height?: number; src?: string; className?: string; testId?: string; ownerLabel?: string }) {
  const sorted = [...items].sort((a, b) => a.id != null && b.id != null ? a.id - b.id : appearanceKey(a).localeCompare(appearanceKey(b)));
  const width = Math.round(height * 0.84);
  const order = ['background', 'outfit', 'hat', 'accessory', 'pet'];
  const layered = [...sorted].sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
  const label = sorted.length ? `تجهيزات ${ownerLabel}: ${sorted.map(i => i.name).join('، ')}` : `لا تجهيزات على ${ownerLabel}`;
  return (
    <div role="group" aria-label={label} data-testid={testId} data-equipped-ids={sorted.flatMap(i => i.id == null ? [] : [i.id]).join(',')}
      className={`relative inline-block shrink-0 overflow-hidden ${className}`} style={{ width, height }}>
      <svg viewBox="0 0 100 120" className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">
        {layered.filter(i => i.slot === 'background').map(i => <Attachment key={appearanceKey(i)} item={i} />)}
      </svg>
      <picture>
        <source media="(prefers-reduced-motion: reduce)" srcSet={CHARACTER_STILL} />
        <img src={src ?? CHARACTER_SPRITE} alt="" draggable={false} className="absolute inset-0 w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />
      </picture>
      <svg viewBox="0 0 100 120" className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">
        {layered.filter(i => i.slot !== 'background').map(i => <Attachment key={appearanceKey(i)} item={i} />)}
      </svg>
      <ul className="sr-only">{sorted.map(i => <li key={appearanceKey(i)}>{slotLabels[i.slot] ?? i.slot}: {i.name}</li>)}</ul>
    </div>
  );
}
