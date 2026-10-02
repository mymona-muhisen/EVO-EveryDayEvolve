import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useClaimJourneyReward, getGetHabitJourneyQueryKey, type HabitJourney } from '@workspace/api-client-react';
import { Gift } from 'lucide-react';
import { AddRewardPanel, RewardEditDialog, refreshRewards, useRewardImage } from '@/components/reward/real-reward';
import { calendarDay } from '@/lib/journey-map';

export type Landmark = { state: 'none' | 'locked' | 'progress' | 'unlocked' | 'claimed'; sub: string };
export function landmarkInfo(j: HabitJourney): Landmark | null {
  const r = j.realReward;
  if (!r) return j.status === 'active' ? { state: 'none', sub: 'أضف ما تعمل من أجله' } : null;
  if (r.status === 'claimed') return { state: 'claimed', sub: 'استلمتها' };
  if (r.status === 'unlocked') return { state: 'unlocked', sub: 'مكافأتك جاهزة!' };
  const day = r.currentDay ?? calendarDay(j), left = r.daysRemaining ?? Math.max(0, 22 - day);
  if (day <= 1 && left >= 21) return { state: 'locked', sub: 'تنتظرك عند نهاية الرحلة' };
  return { state: 'progress', sub: left === 0 ? 'اليوم الأخير' : `بقي ${left} يوم` };
}
const statusAr = { pending: 'في الطريق', unlocked: 'مفتوحة', claimed: 'استلمتها' } as const;

export function RewardPanel({ journey, habitId }: { journey: HabitJourney; habitId: number }) {
  const r = journey.realReward, qc = useQueryClient(), claim = useClaimJourneyReward(), [edit, setEdit] = useState(false);
  const img = useRewardImage(r?.imageUrl);
  if (!r) return <div className="space-y-3 p-2" data-testid="reward-panel-empty"><h2 className="font-black text-lg">وجهتك عند نهاية الرحلة</h2><p className="text-sm muted">لا مكافأة مرتبطة بهذه الرحلة بعد.</p>{journey.status === 'active' && <AddRewardPanel habitId={habitId} />}</div>;
  const day = r.currentDay ?? calendarDay(journey), left = r.daysRemaining ?? Math.max(0, 22 - day);
  const doClaim = () => claim.mutate({ journeyRewardId: r.id }, { onSuccess: claimed => { qc.setQueryData(getGetHabitJourneyQueryKey(habitId), (old: HabitJourney | undefined) => old ? { ...old, realReward: claimed } : old); refreshRewards(qc, habitId, r.id); } });
  return <div className="space-y-3 p-2" data-testid="reward-panel-content">
    <div className="flex gap-3 items-center">
      {img.status === 'ok' && img.url ? <img src={img.url} alt={r.title} className="w-24 h-24 rounded-2xl object-cover bg-[#eae4d5]" data-testid="img-reward-photo" /> : img.hasPath && img.status === 'error' ? <button type="button" onClick={img.retry} className="w-24 h-24 rounded-2xl bg-[#f6e0d8] text-xs p-2">تعذّرت الصورة، أعد المحاولة</button> : img.hasPath ? <div className="skeleton w-24 h-24 rounded-2xl" /> : <img src={`${import.meta.env.BASE_URL}assets/journey-gift.png`} alt="" className="w-24 h-24 object-contain" />}
      <div className="min-w-0 flex-1"><div className="text-xs muted">{r.type === 'physical' ? 'شيء أملكه' : 'تجربة أعيشها'}</div><h2 className="font-black text-lg break-words" data-testid="text-reward-title">{r.title}</h2><span className="badge mt-1" data-testid="text-reward-status">{statusAr[r.status]}</span></div>
    </div>
    {r.description && <p className="text-sm whitespace-pre-wrap break-words">{r.description}</p>}
    <div><div className="flex justify-between text-sm"><b>اليوم {day} من 22</b><span className="muted">{r.status === 'pending' ? (left === 0 ? 'اليوم الأخير' : `بقي ${left} يوم`) : r.status === 'unlocked' ? 'مكافأتك جاهزة!' : 'وصلت'}</span></div>
      <div className="h-2 rounded-full bg-[#e3d9c9] overflow-hidden mt-1.5"><div className="h-full bg-[#245448]" style={{ width: `${Math.min(100, day / 22 * 100)}%` }} /></div></div>
    {r.status === 'pending' && <p className="text-sm panel rounded-xl p-3" data-testid="text-reward-locked">مغلقة حتى يُكمل الخادم رحلتك. تنتظرك عند نهاية الرحلة.</p>}
    {r.status === 'unlocked' && <div className="space-y-2"><button type="button" data-testid="button-claim-reward" className="btn btn-coral w-full" disabled={claim.isPending} onClick={doClaim}>{claim.isPending ? 'نسجّل…' : claim.isError ? 'أعد المحاولة' : 'استلم المكافأة'}</button>{claim.isError && <p role="alert" data-testid="text-claim-error" className="text-sm text-[#b96355]">تعذّر تسجيل الاستلام. مكافأتك ما زالت مفتوحة؛ حاول مرة أخرى.</p>}</div>}
    {r.status === 'claimed' && <p role="status" data-testid="text-reward-claimed" className="font-bold flex gap-2 items-center"><Gift size={16} />تم استلام المكافأة.</p>}
    {r.status === 'pending' && <button type="button" data-testid="button-edit-reward" className="btn btn-light w-full" onClick={() => setEdit(true)}>تعديل المكافأة</button>}
    {edit && <RewardEditDialog reward={r} onClose={() => setEdit(false)} />}
  </div>;
}
