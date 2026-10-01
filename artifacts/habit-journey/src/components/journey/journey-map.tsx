import { useEffect, useMemo, useRef, useState } from 'react';
import type { HabitJourney } from '@workspace/api-client-react';
import { Camera } from 'lucide-react';
import { CharacterAvatar } from '@/components/character/character-avatar';
import { useGlobalCharacter } from '@/hooks/use-character';
import { ISLAND_FILE_TO_ID, SLOT_POS } from '@/lib/decor';
import { ISLANDS, MAP_HEIGHT, MILESTONES, base, calendarDay, classifyDay, nodeLabel, nodePos, propVisible, STATE_SYMBOL, successCount, type NodeState } from '@/lib/journey-map';

const FILL: Record<NodeState, string> = { success: '#2f7a5c', recovered: '#2f7a5c', today: '#ce7555', missed: '#e8d6c0', rest: '#e9eef0', future: '#f3ecdc', pending: '#e8d6c0' };
const INK: Record<NodeState, string> = { success: '#fffaf0', recovered: '#fffaf0', today: '#fffaf0', missed: '#8a5a44', rest: '#5f7c86', future: '#9a9d8d', pending: '#8a5a44' };

function useReducedMotion() {
  const [r, setR] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => { const m = window.matchMedia('(prefers-reduced-motion: reduce)'); const f = () => setR(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return r;
}

export function JourneyMap({ journey, selected, onSelect, placements = [], fullscreen = false, preservePagePosition = false, layoutRevision = 0 }: { journey: HabitJourney; selected: number; onSelect: (day: number) => void; fullscreen?: boolean; preservePagePosition?: boolean; layoutRevision?: number; placements?: { decorationId: number; islandId: string; slot: number; assetFile: string; name: string }[] }) {
  const reduced = useReducedMotion();
  const character = useGlobalCharacter();
  const cur = calendarDay(journey), today = journey.today.slice(0, 10);
  const prev = useRef(cur); const [walk, setWalk] = useState<'north' | 'south' | null>(null);
  useEffect(() => { if (prev.current !== cur) { setWalk(cur > prev.current ? 'north' : 'south'); prev.current = cur; const t = setTimeout(() => setWalk(null), 1600); return () => clearTimeout(t); } return undefined; }, [cur]);
  const succ = successCount(journey, today);
  const days = useMemo(() => journey.days.slice().sort((a, b) => a.dayNumber - b.dayNumber), [journey.days]);
  const path = useMemo(() => { const pts = days.map(d => nodePos(d.dayNumber)); return pts.map((p, i) => { if (!i) return `M${p.x * 3.6} ${p.y}`; const q = pts[i - 1]; const my = (p.y + q.y) / 2; return `C${q.x * 3.6} ${my} ${p.x * 3.6} ${my} ${p.x * 3.6} ${p.y}`; }).join(' '); }, [days]);
  const cp = nodePos(cur);
  const viewport = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    let active = true;
    const controls = el.closest('[data-journey-layout]')?.querySelector<HTMLElement>('[data-journey-controls]');
    const rewardEl = el.closest('[data-journey-layout]')?.querySelector<HTMLElement>('[data-journey-reward]');
    const rewardSpace = () => { const h = rewardEl?.getBoundingClientRect().height ?? 0; return h > 0 ? h + 16 : 0; };
    const center = () => {
      if (!active) return;
      const node = el.querySelector<HTMLButtonElement>(`#jnode-${selectedRef.current}`);
      if (!node) return;
      const nodeBounds = node.getBoundingClientRect(), bounds = el.getBoundingClientRect();
      el.scrollTop += nodeBounds.top + nodeBounds.height / 2 - bounds.top - el.clientHeight / 2;
    };
    const fit = () => {
      if (!active) return;
      // The mobile toolbar follows the map, so reserve its actual wrapped
      // height as well as the fixed navigation and the grid's 24px gap.
      const footerSpace = fullscreen ? 16 : window.innerWidth < 1024 ? 96 + (controls?.getBoundingClientRect().height ?? 0) + rewardSpace() + 24 : 24;
      if (!preservePagePosition && el.getBoundingClientRect().top > window.innerHeight - footerSpace - 220) {
        // Fit measures the final document position, not an inherited smooth
        // scroll still in progress. Fullscreen return is owned by the page.
        el.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
      const available = window.innerHeight - Math.max(0, el.getBoundingClientRect().top) - footerSpace;
      const maxHeight = `${Math.max(220, fullscreen ? available : Math.min(window.innerHeight * .65, available))}px`;
      if (el.style.maxHeight !== maxHeight) el.style.maxHeight = maxHeight;
      center();
    };
    // Reward/status changes resize the sidebar while the map also changes
    // height. Do not write layout during ResizeObserver delivery.
    let fitFrame: number | null = null, centerFrame: number | null = null;
    const scheduleFit = () => {
      if (!active || fitFrame !== null) return;
      fitFrame = requestAnimationFrame(() => { fitFrame = null; fit(); });
    };
    const scheduleCenter = () => {
      if (!active || centerFrame !== null) return;
      centerFrame = requestAnimationFrame(() => { centerFrame = null; center(); });
    };
    const size = new ResizeObserver(scheduleCenter);
    size.observe(el);
    const controlSize = new ResizeObserver(scheduleFit);
    if (controls) controlSize.observe(controls);
    if (rewardEl) controlSize.observe(rewardEl);
    scheduleFit();
    window.addEventListener('resize', scheduleFit);
    document.fonts.ready.then(scheduleFit);
    return () => {
      active = false; size.disconnect(); controlSize.disconnect();
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      if (centerFrame !== null) cancelAnimationFrame(centerFrame);
      window.removeEventListener('resize', scheduleFit);
    };
  }, [journey.habitId, cur, cp.y, fullscreen, preservePagePosition, layoutRevision]);
  const charSrc = reduced ? base('character-idle-still.webp') : walk ? base(`character-walk-${walk}.gif`) : base('character-idle.gif');
  return <div ref={viewport} style={{ overflowAnchor: 'none', scrollBehavior: 'auto' }} className={`mx-auto w-full overflow-y-auto ${fullscreen ? 'max-w-[800px]' : 'max-w-[560px] max-h-[65dvh]'} overflow-x-hidden rounded-[28px]`} role="region" aria-label="خريطة الرحلة، مرّر عموديًا لاستكشاف الأيام" tabIndex={0}>
    <div className="relative w-full overflow-hidden" style={{ height: MAP_HEIGHT, background: 'linear-gradient(#cfe3df,#eef0e0 55%,#f7e9cf)' }} data-testid="journey-map">
    <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 360 ${MAP_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true"><path d={path} className="map-route-enter" pathLength="1" fill="none" stroke="#fffaf0" strokeWidth="14" strokeLinecap="round" opacity=".7" /><path d={path} className="map-path" fill="none" stroke="#b9805f" strokeWidth="3" strokeLinecap="round" /></svg>
    {ISLANDS.map(il => { const p = nodePos(il.day); const x = Math.max(28, Math.min(72, p.x)); return <div key={il.file} className="absolute pointer-events-none" style={{ left: `${x}%`, top: p.y, width: `${il.w * 0.8}%`, transform: 'translate(-50%,-50%)' }}>
      <img src={base(il.file)} alt="" className="w-full block" loading="lazy" />
      {il.props.filter(pr => pr.file.startsWith('station-')).filter(pr => propVisible(succ, pr.at) || (il.day === 22 && journey.status === 'completed')).map(pr => <img key={pr.file} src={base(pr.file)} alt="" className="absolute pop" style={{ left: `${50 + pr.dx}%`, top: `${50 + pr.dy}%`, width: `${pr.w}%`, transform: 'translate(-50%,-30%)' }} />)}
    {placements.filter(d => d.islandId === ISLAND_FILE_TO_ID[il.file] && d.slot >= 0 && d.slot < 6).map(d => { const sp = SLOT_POS[d.slot]; return <img key={d.decorationId} src={base(d.assetFile)} alt={d.name} data-testid={`placed-decor-${d.decorationId}`} className="absolute" style={{ left: `${50 + sp.dx}%`, top: `${50 + sp.dy}%`, width: '15%', maxHeight: '24%', objectFit: 'contain', transform: 'translate(-50%,-80%)' }} />; })}
    </div>; })}
    <div className="absolute top-3 inset-x-0 text-center pointer-events-none" aria-hidden="true"><img src={base('station-ferris-wheel.webp')} alt="" className="mx-auto h-24 opacity-90" /></div>
    {days.map(d => { const s = classifyDay(d, today), p = nodePos(d.dayNumber), ms = (MILESTONES as readonly number[]).includes(d.dayNumber), sel = selected === d.dayNumber;
      return <button type="button" key={d.dayNumber} id={`jnode-${d.dayNumber}`} data-testid={`node-day-${d.dayNumber}`} aria-label={nodeLabel(d, s)} aria-pressed={sel} onClick={() => onSelect(d.dayNumber)}
        className={`absolute flex flex-col items-center justify-center rounded-full font-bold transition-[transform,background-color,box-shadow] active:scale-95 ${s === 'today' ? 'map-node-enter' : ''}`}
        style={{ left: `${p.x}%`, top: p.y, width: ms ? 56 : 48, height: ms ? 56 : 48, transform: 'translate(-50%,-50%)', background: FILL[s], color: INK[s], border: `${ms ? 3 : 2}px ${s === 'rest' ? 'dashed' : 'solid'} ${sel ? '#1c443c' : ms ? '#e8b87c' : '#fffaf0'}`, boxShadow: s === 'today' ? '0 0 0 6px #ce755533' : '0 3px 8px #1c443c26' }}>
        <span className="text-base leading-none">{d.dayNumber}</span><span className="text-[11px] leading-none" aria-hidden="true">{STATE_SYMBOL[s]}</span>
        {d.memoryId && <span data-testid={`badge-map-memory-${d.dayNumber}`} aria-hidden="true" className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-[#fffaf0] border border-[#e8b87c] flex items-center justify-center shadow"><Camera size={13} className="text-[#245448]" /></span>}
      </button>; })}
    <div className="absolute pointer-events-none" aria-label={`الشخصية عند اليوم ${cur}`} style={{ left: `${cp.x}%`, top: cp.y, transform: 'translate(-50%,-100%)', transition: reduced ? 'none' : 'left 1.4s ease, top 1.4s ease', marginTop: -26 }}>
      {character.data ? <CharacterAvatar items={character.data.equippedItems} src={charSrc} height={56} testId="journey-character" /> : character.isError ? <span role="alert" className="text-[10px] whitespace-nowrap">تعذّر تحميل الشخصية</span> : <div className="skeleton h-14 w-12" aria-label="تحميل الشخصية" />}
      {character.levelUp && <span role="status" className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 paper px-2 py-1 rounded-lg text-[10px] whitespace-nowrap pop motion-reduce:animate-none">المستوى {character.levelUp}!</span>}
    </div>
  </div></div>;
}
