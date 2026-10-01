import { Gift } from 'lucide-react';
import type { Reward } from '@workspace/api-client-react';
import { MILESTONE_DAYS } from '@/lib/daily';

export function ConsistencyLine({ successful, eligible, compact }: { successful: number; eligible: number; compact?: boolean }) {
  const pct = eligible ? Math.min(100, (successful / eligible) * 100) : 0;
  return <div data-testid="text-consistency">
    <div className="flex justify-between text-sm"><span className="muted">{compact ? 'الاتساق' : 'اتساقك حتى اليوم'}</span><b>{successful} من {eligible}</b></div>
    <div className="h-1.5 rounded-full bg-[#e3d9c9] mt-1.5 overflow-hidden"><div className="h-full bg-[#2d745b] rounded-full transition-all duration-700" style={{ width: `${pct}%` }} /></div>
    {!compact && <p className="text-xs muted mt-1.5">يُحسب من الأيام المجدولة التي مضت فقط، وليس من كل أيام الرحلة.</p>}
  </div>;
}

export function MilestoneRow({ milestones, reward }: { milestones: { days: number; reached: boolean }[]; reward?: Reward | null }) {
  const byDay = (d: number) => milestones.find(m => m.days === d);
  const next = MILESTONE_DAYS.find(d => !byDay(d)?.reached);
  return <div>
    <div className="flex items-center justify-between gap-1" dir="rtl">{MILESTONE_DAYS.map(d => { const on = !!byDay(d)?.reached; return <div key={d} className="flex flex-col items-center gap-1 flex-1"><span className={`w-8 h-8 rounded-full text-xs font-bold flex items-center justify-center ${on ? 'bg-[#2d745b] text-white' : 'bg-[#eee9dc] text-[#6a7a70]'}`}>{d}</span><span className="text-[10px] muted">{on ? 'تمّت' : 'قادمة'}</span></div>; })}</div>
    {reward && <p className="text-sm mt-3 flex items-center gap-2"><Gift size={15} className="text-[#b87755] shrink-0" /><span>مكافأتك: {reward.title} · {reward.isRedeemed ? 'حصلت عليها' : `${reward.coinCost} عملة`}{next ? ` · المحطة التالية: يوم ${next}` : ''}</span></p>}
  </div>;
}
