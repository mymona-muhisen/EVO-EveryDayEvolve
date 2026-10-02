import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HabitJourney } from '@workspace/api-client-react';
import { Camera, Minus, Plus, Scan } from 'lucide-react';
import { CharacterAvatar } from '@/components/character/character-avatar';
import { useGlobalCharacter } from '@/hooks/use-character';
import { ISLAND_FILE_TO_ID, SLOT_POS } from '@/lib/decor';
import { ISLANDS, MAP_HEIGHT, MILESTONES, base, calendarDay, classifyDay, nodeLabel, nodePos, propVisible, STATE_SYMBOL, successCount, type NodeState } from '@/lib/journey-map';
import type { Landmark } from './reward-landmark';

const FILL: Record<NodeState, string> = { success: '#2f7a5c', recovered: '#2f7a5c', today: '#ce7555', missed: '#e8d6c0', rest: '#e9eef0', future: '#f3ecdc', pending: '#e8d6c0' };
const INK: Record<NodeState, string> = { success: '#fffaf0', recovered: '#fffaf0', today: '#fffaf0', missed: '#8a5a44', rest: '#5f7c86', future: '#9a9d8d', pending: '#8a5a44' };
const WORLD_W = 560, MAXS = 1.8, MARGIN = 60;
const GIFT = { x: 462, y: 335 }, MARGIN_X = 100;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
type View = { x: number; y: number; s: number };
export type FocusRequest = { kind: 'day' | 'reward'; day?: number; tick: number };

function useReducedMotion() {
  const [r, setR] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => { const m = window.matchMedia('(prefers-reduced-motion: reduce)'); const f = () => setR(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return r;
}

export function JourneyMap({ journey, selected, onSelect, placements = [], focusRequest, obstruct = null, landmark, onOpenReward }: {
  journey: HabitJourney; selected: number | null; onSelect: (day: number) => void; focusRequest?: FocusRequest; obstruct?: 'bottom' | 'side' | null;
  landmark?: Landmark | null; onOpenReward?: () => void;
  placements?: { decorationId: number; islandId: string; slot: number; assetFile: string; name: string }[];
}) {
  const reduced = useReducedMotion();
  const character = useGlobalCharacter();
  const cur = calendarDay(journey), today = journey.today.slice(0, 10);
  const prev = useRef(cur); const [walk, setWalk] = useState<'north' | 'south' | null>(null);
  useEffect(() => { if (prev.current !== cur) { setWalk(cur > prev.current ? 'north' : 'south'); prev.current = cur; const t = setTimeout(() => setWalk(null), 1600); return () => clearTimeout(t); } return undefined; }, [cur]);
  const succ = successCount(journey, today);
  const days = useMemo(() => journey.days.slice().sort((a, b) => a.dayNumber - b.dayNumber), [journey.days]);
  const path = useMemo(() => { const pts = days.map(d => nodePos(d.dayNumber)); return pts.map((p, i) => { if (!i) return `M${p.x * 3.6} ${p.y}`; const q = pts[i - 1]; const my = (p.y + q.y) / 2; return `C${q.x * 3.6} ${my} ${p.x * 3.6} ${my} ${p.x * 3.6} ${p.y}`; }).join(' '); }, [days]);
  const cp = nodePos(cur);

  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, s: 1 });
  const [animate, setAnimate] = useState(false);
  const viewRef = useRef(view); viewRef.current = view;
  const sizeRef = useRef(size); sizeRef.current = size;
  const obstructRef = useRef(obstruct); obstructRef.current = obstruct;
  const minS = (sz = sizeRef.current) => Math.max(0.1, Math.min((sz.w - 80) / WORLD_W, (sz.h - 96) / MAP_HEIGHT));
  const startS = (sz = sizeRef.current) => clamp(Math.min(sz.w / 600, sz.h / 620, 1.3), minS(sz), MAXS);
  const fix = useCallback((v: View, sz = sizeRef.current): View => {
    const s = clamp(v.s, minS(sz), MAXS), sw = WORLD_W * s, sh = MAP_HEIGHT * s;
    return { s, x: sw + 2 * MARGIN_X <= sz.w ? (sz.w - sw) / 2 : clamp(v.x, sz.w - sw - MARGIN_X, MARGIN_X), y: sh + 2 * MARGIN <= sz.h ? (sz.h - sh) / 2 : clamp(v.y, sz.h - sh - MARGIN, MARGIN) };
  }, []);
  const apply = useCallback((v: View, anim = false) => { setAnimate(anim && !reduced); setView(fix(v)); }, [fix, reduced]);
  const focusPoint = useCallback((px: number, py: number, minScale?: number) => {
    const sz = sizeRef.current, s = Math.max(viewRef.current.s, minScale ?? startS());
    const ob = obstructRef.current, cx = (sz.w - (ob === 'side' ? 420 : 0)) / 2, cy = (sz.h - (ob === 'bottom' ? Math.min(sz.h * .6, 440) : 0)) / 2;
    apply({ s, x: cx - px * s, y: cy - py * s }, true);
  }, [apply]);
  const focusDay = useCallback((n: number) => { const p = nodePos(n); focusPoint(p.x / 100 * WORLD_W, p.y - (n === cur ? 30 : 0)); }, [focusPoint, cur]);

  const inited = useRef<number | null>(null);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => {
      const sz = { w: el.clientWidth, h: el.clientHeight };
      if (!sz.w || !sz.h) return;
      const previousSize = sizeRef.current;
      sizeRef.current = sz; setSize(sz);
      if (inited.current !== journey.habitId) {
        inited.current = journey.habitId;
        const s = startS(sz), p = nodePos(cur);
        setAnimate(false); setView(fix({ s, x: sz.w / 2 - p.x / 100 * WORLD_W * s, y: sz.h / 2 - (p.y - 30) * s }, sz));
      } else setView(v => fix({
        ...v,
        x: previousSize.w ? v.x + (sz.w - previousSize.w) / 2 : v.x,
        y: previousSize.h ? v.y + (sz.h - previousSize.h) / 2 : v.y,
      }, sz));
    };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [journey.habitId]);
  useEffect(() => {
    if (!focusRequest || !focusRequest.tick) return;
    if (focusRequest.kind === 'reward') focusPoint(GIFT.x, GIFT.y - 40);
    else if (focusRequest.day) focusDay(focusRequest.day);
  }, [focusRequest?.tick]);

  // pointer pan / pinch
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; v: View; sx: number; sy: number; dist: number; mid: { x: number; y: number } } | null>(null);
  const ref0 = () => { const pts = [...ptrs.current.values()]; const a = pts[0], b = pts[1]; return { mid: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a, dist: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 }; };
  const down = (e: React.PointerEvent) => {
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = ref0(); gesture.current = { moved: gesture.current?.moved && ptrs.current.size > 1 ? true : false, v: viewRef.current, sx: r.mid.x, sy: r.mid.y, dist: r.dist, mid: r.mid };
  };
  const move = (e: React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId) || !gesture.current) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current, r = ref0();
    if (!g.moved && Math.hypot(r.mid.x - g.sx, r.mid.y - g.sy) < 6 && Math.abs(r.dist - g.dist) < 6) return;
    if (!g.moved) { g.moved = true; try { box.current?.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    const rect = box.current!.getBoundingClientRect();
    const s = g.dist && r.dist ? g.v.s * r.dist / g.dist : g.v.s;
    const ox = g.sx - rect.left, oy = g.sy - rect.top, wx = (ox - g.v.x) / g.v.s, wy = (oy - g.v.y) / g.v.s;
    apply({ s, x: r.mid.x - rect.left - wx * s, y: r.mid.y - rect.top - wy * s });
  };
  const up = (e: React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size) { const r = ref0(); gesture.current = { moved: true, v: viewRef.current, sx: r.mid.x, sy: r.mid.y, dist: r.dist, mid: r.mid }; }
    else setTimeout(() => { gesture.current = null; }, 0);
  };
  const zoomAt = useCallback((factor: number, ox?: number, oy?: number, anim = false) => {
    const sz = sizeRef.current, v = viewRef.current, px = ox ?? sz.w / 2, py = oy ?? sz.h / 2, s = clamp(v.s * factor, minS(), MAXS);
    apply({ s, x: px - (px - v.x) / v.s * s, y: py - (py - v.y) / v.s * s }, anim);
  }, [apply]);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
      else { const v = viewRef.current; apply({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }); }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoomAt, apply]);
  const fitAll = () => apply({ s: minS(), x: 0, y: 0 }, true);
  const key = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const v = viewRef.current, d = 80;
    const m: Record<string, () => void> = { ArrowUp: () => apply({ ...v, y: v.y + d }), ArrowDown: () => apply({ ...v, y: v.y - d }), ArrowLeft: () => apply({ ...v, x: v.x + d }), ArrowRight: () => apply({ ...v, x: v.x - d }), '+': () => zoomAt(1.25, undefined, undefined, true), '=': () => zoomAt(1.25, undefined, undefined, true), '-': () => zoomAt(0.8, undefined, undefined, true), '0': fitAll };
    if (m[e.key]) { e.preventDefault(); m[e.key](); }
  };
  const ensureVisible = (px: number, py: number) => {
    const sz = sizeRef.current, v = viewRef.current, sx = v.x + px * v.s, sy = v.y + py * v.s;
    if (sx < 40 || sy < 40 || sx > sz.w - 40 || sy > sz.h - 40) { const s = Math.max(v.s, startS()); apply({ s, x: sz.w / 2 - px * s, y: sz.h / 2 - py * s }); }
  };
  const inv = Math.min(1.8, Math.max(1, 1 / view.s));
  const charSrc = reduced ? base('character-idle-still.webp') : walk ? base(`character-walk-${walk}.gif`) : base('character-idle.gif');
  const gem = landmark ? { none: 'أضف مكافأة', locked: 'المكافأة', progress: 'المكافأة', unlocked: 'المكافأة', claimed: 'المكافأة' }[landmark.state] : '';
  return <div ref={box} role="application" aria-label="خريطة الرحلة. اسحب للتحريك، واستخدم أزرار التكبير أو الأسهم و+ و-" tabIndex={0} data-testid="journey-map-viewport"
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}
    onScroll={e => { e.currentTarget.scrollTop = 0; e.currentTarget.scrollLeft = 0; }}
    onClickCapture={e => { if (gesture.current?.moved) { e.stopPropagation(); e.preventDefault(); } }}
    className="absolute inset-0 select-none cursor-grab active:cursor-grabbing focus-visible:outline-2 outline-offset-[-3px]" dir="ltr"
    style={{ overflow: 'clip', touchAction: 'none', background: 'linear-gradient(#cfe3df,#eef0e0 55%,#f7e9cf)' }}>
    <div className="absolute left-0 top-0" data-testid="journey-map" style={{ width: WORLD_W, height: MAP_HEIGHT, transformOrigin: '0 0', transform: `translate(${view.x}px,${view.y}px) scale(${view.s})`, transition: animate ? 'transform .6s cubic-bezier(.3,.7,.2,1)' : 'none', ['--inv' as string]: inv, willChange: 'transform' }}>
      <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 360 ${MAP_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true"><path d={path} className="map-route-enter" pathLength="1" fill="none" stroke="#fffaf0" strokeWidth="14" strokeLinecap="round" opacity=".7" /><path d={path} className="map-path" fill="none" stroke="#b9805f" strokeWidth="3" strokeLinecap="round" /></svg>
      {ISLANDS.map(il => { const p = nodePos(il.day); const x = Math.max(28, Math.min(72, p.x)); return <div key={il.file} className="absolute pointer-events-none" style={{ left: `${x}%`, top: p.y, width: `${il.w * 0.8}%`, transform: 'translate(-50%,-50%)' }}>
        <img src={base(il.file)} alt="" className="w-full block" draggable={false} />
        {il.props.filter(pr => pr.file.startsWith('station-')).filter(pr => propVisible(succ, pr.at) || (il.day === 22 && journey.status === 'completed')).map(pr => <img key={pr.file} src={base(pr.file)} alt="" draggable={false} className="absolute pop" style={{ left: `${50 + pr.dx}%`, top: `${50 + pr.dy}%`, width: `${pr.w}%`, transform: 'translate(-50%,-30%)' }} />)}
        {placements.filter(d => d.islandId === ISLAND_FILE_TO_ID[il.file] && d.slot >= 0 && d.slot < 6).map(d => { const sp = SLOT_POS[d.slot]; return <img key={d.decorationId} src={base(d.assetFile)} alt={d.name} draggable={false} data-testid={`placed-decor-${d.decorationId}`} className="absolute" style={{ left: `${50 + sp.dx}%`, top: `${50 + sp.dy}%`, width: '15%', maxHeight: '24%', objectFit: 'contain', transform: 'translate(-50%,-80%)' }} />; })}
      </div>; })}
      <div className="absolute top-3 inset-x-0 text-center pointer-events-none" aria-hidden="true"><img src={base('station-ferris-wheel.webp')} alt="" className="mx-auto h-24 opacity-90" draggable={false} /></div>
      {days.map(d => { const s = classifyDay(d, today), p = nodePos(d.dayNumber), ms = (MILESTONES as readonly number[]).includes(d.dayNumber), sel = selected === d.dayNumber;
        return <button type="button" key={d.dayNumber} id={`jnode-${d.dayNumber}`} data-testid={`node-day-${d.dayNumber}`} aria-label={nodeLabel(d, s)} aria-pressed={sel} onClick={() => onSelect(d.dayNumber)} onFocus={() => ensureVisible(p.x / 100 * WORLD_W, p.y)}
          className={`absolute flex flex-col items-center justify-center rounded-full font-bold ${s === 'today' ? 'map-node-enter' : ''}`}
          style={{ left: `${p.x}%`, top: p.y, width: ms ? 56 : 48, height: ms ? 56 : 48, transform: 'translate(-50%,-50%) scale(var(--inv))', background: FILL[s], color: INK[s], border: `${ms ? 3 : 2}px ${s === 'rest' ? 'dashed' : 'solid'} ${sel ? '#1c443c' : ms ? '#e8b87c' : '#fffaf0'}`, boxShadow: sel ? '0 0 0 5px #fffaf0, 0 0 0 8px #1c443c' : s === 'today' ? '0 0 0 6px #ce755533' : '0 3px 8px #1c443c26' }}>
          <span className="text-base leading-none">{d.dayNumber}</span><span className="text-[11px] leading-none" aria-hidden="true">{STATE_SYMBOL[s]}</span>
          {d.memoryId && <span data-testid={`badge-map-memory-${d.dayNumber}`} aria-hidden="true" className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-[#fffaf0] border border-[#e8b87c] flex items-center justify-center shadow"><Camera size={13} className="text-[#245448]" /></span>}
        </button>; })}
      {landmark && <button type="button" data-testid="landmark-reward" data-state={landmark.state} onClick={onOpenReward} aria-label={`${gem}: ${landmark.sub}`} onFocus={() => ensureVisible(GIFT.x, GIFT.y)}
        className="absolute flex flex-col items-center gap-1" style={{ left: GIFT.x, top: GIFT.y, transform: 'translate(-50%,-50%) scale(var(--inv))' }}>
        <img src={`${import.meta.env.BASE_URL}assets/journey-gift.png`} alt="" draggable={false} className={`w-20 h-20 object-contain drop-shadow-lg ${landmark.state === 'unlocked' ? 'pop' : ''} ${landmark.state === 'locked' || landmark.state === 'none' ? 'opacity-80' : ''}`} />
        <span dir="rtl" className={`rounded-full px-2.5 py-1 text-[11px] font-bold whitespace-nowrap border ${landmark.state === 'unlocked' ? 'bg-[#e2ad73] border-[#b8793e] text-[#1d463b]' : 'bg-[#fffaf0] border-[#e8b87c] text-[#245448]'}`}>{landmark.sub}</span>
      </button>}
      <div className="absolute pointer-events-none" aria-label={`الشخصية عند اليوم ${cur}`} style={{ left: `${cp.x}%`, top: cp.y, transform: 'translate(-50%,-100%) scale(var(--inv))', transformOrigin: '50% 100%', transition: reduced ? 'none' : 'left 1.4s ease, top 1.4s ease', marginTop: -26 }}>
        {character.data ? <CharacterAvatar items={character.data.equippedItems} src={charSrc} height={56} testId="journey-character" /> : character.isError ? <span role="alert" className="text-[10px] whitespace-nowrap">تعذّر تحميل الشخصية</span> : <div className="skeleton h-14 w-12" aria-label="تحميل الشخصية" />}
        {character.levelUp && <span role="status" className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 paper px-2 py-1 rounded-lg text-[10px] whitespace-nowrap pop motion-reduce:animate-none">المستوى {character.levelUp}!</span>}
      </div>
    </div>
    <div className="absolute left-3 bottom-3 z-10 flex flex-col gap-1.5" onPointerDown={e => e.stopPropagation()}>
      <button type="button" data-testid="button-zoom-in" aria-label="تكبير" className="btn btn-light !p-0 w-11 h-11" onClick={() => zoomAt(1.3, undefined, undefined, true)}><Plus size={18} /></button>
      <button type="button" data-testid="button-zoom-out" aria-label="تصغير" className="btn btn-light !p-0 w-11 h-11" onClick={() => zoomAt(0.77, undefined, undefined, true)}><Minus size={18} /></button>
      <button type="button" data-testid="button-fit-map" aria-label="اعرض الرحلة كاملة" className="btn btn-light !p-0 w-11 h-11" onClick={fitAll}><Scan size={18} /></button>
    </div>
  </div>;
}
