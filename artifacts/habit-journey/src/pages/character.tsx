import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as api from '@workspace/api-client-react';
import { Link } from 'wouter';
import { useGlobalCharacter } from '@/hooks/use-character';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Coins, Check, Lock, Sparkles, Star } from 'lucide-react';
import { ConsistencyOverview } from '@/components/daily/consistency-overview';
import { CharacterAvatar, slotLabels } from '@/components/character/character-avatar';
import { PageHead, SectionTitle, Empty, Loading, ErrorBlock, arDate } from '@/components/journey-ui';

const owned = (i: api.CharacterItem) => i.owned;
const equipped = (i: api.CharacterItem) => i.equipped;
type Item = api.CharacterItem;
const filters = ['all', 'outfit', 'hat', 'accessory', 'pet', 'background'];

export function CharacterPage() {
  const qc = useQueryClient();
  const charQ = useGlobalCharacter();
  const catalogQ = api.useListCharacterCatalog();
    const journey = api.useGetJourneyProgress();
  const purchase = api.usePurchaseCharacterItem();
  const equip = api.useEquipCharacterItem();
  const unequip = api.useUnequipCharacterItem();
  const [filter, setFilter] = useState('all');
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<Item | null>(null);

  const char = charQ.data;
  const known = !!char;
  const items = catalogQ.data ?? [];
  const level = char?.level ?? 1;
  const balance = char?.walletCoins ?? 0;
  const busy = purchase.isPending || equip.isPending || unequip.isPending;
  const pct = char?.progressPercent ?? 0;
  const shown = useMemo(() => items.filter(i => filter === 'all' || i.slot === filter), [items, filter]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: api.getGetMyCharacterQueryKey() });
    qc.invalidateQueries({ queryKey: api.getListCharacterCatalogQueryKey() });
    qc.invalidateQueries({ queryKey: api.getGetCurrentUserQueryKey() });
    qc.invalidateQueries({ queryKey: api.getGetWalletQueryKey() });
    qc.invalidateQueries({ queryKey: api.getGetDashboardTodayQueryKey() });
    qc.invalidateQueries({ queryKey: api.getListWalletTransactionsQueryKey() });
  };
  const patch = (server: Item, mode: 'equip' | 'unequip') => {
    qc.setQueryData<api.MyCharacter>(api.getGetMyCharacterQueryKey(), old => old && ({ ...old, equippedItems: mode === 'equip'
      ? [...old.equippedItems.filter(x => x.slot !== server.slot && x.id !== server.id), server]
      : old.equippedItems.filter(x => x.id !== server.id) }));
    qc.setQueryData<Item[]>(api.getListCharacterCatalogQueryKey(), old => old?.map(x => x.id === server.id
      ? server : mode === 'equip' && x.slot === server.slot ? { ...x, equipped: false } : x));
    refresh();
  };
  const doEquip = (i: Item) => equip.mutate({ itemId: i.id }, { onSuccess: s => { patch(s, 'equip'); setOffer(null); toast.success('جُهّز العنصر'); }, onError: () => toast.error('تعذّر تجهيز العنصر') });
  const doUnequip = (i: Item) => unequip.mutate({ itemId: i.id }, { onSuccess: s => { patch(s, 'unequip'); toast.success('أُزيل العنصر'); }, onError: () => toast.error('تعذّر إزالة العنصر') });
  const doBuy = () => {
    if (!confirm) return;
    const item = confirm; setError(null);
    purchase.mutate({ itemId: item.id }, {
      onSuccess: () => { refresh(); setConfirm(null); setOffer(item); toast.success('أصبح العنصر في خزانتك'); },
      onError: (e) => {
        const status = (e as { status?: number }).status;
        refresh();
        if (status === 409) { setConfirm(null); toast.info('هذا العنصر في خزانتك بالفعل'); }
        else if (status === 400 || status === 402) setError('رفض الخادم الشراء: رصيدك أو مستواك لا يسمح به الآن.');
        else setError('تعذّر تأكيد نتيجة الشراء؛ حدّث رصيدك وخزانتك قبل إعادة المحاولة.');
      },
    });
  };
  const confirm = items.find(i => i.id === confirmId) ?? null;
  const setConfirm = (i: Item | null) => setConfirmId(i ? i.id : null);
  useEffect(() => {
    if (confirm?.owned) { setConfirmId(null); setError(null); if (!confirm.equipped) setOffer(confirm); }
  }, [confirm]);
  const levelLocked = (i: Item) => i.levelRequired != null && i.levelRequired > level && !owned(i);

  return <>
    <PageHead overline="كل خطوة ترسم طريقًا" title="الشخصية" desc="رفيقك نفسه في كل رحلة. يكبر مستواه مع كل يوم تلتزم فيه." action={<Link href="/journey" className="btn">افتح خريطة رحلتي</Link>} />
    {charQ.isLoading ? <Loading /> : charQ.isError ? <ErrorBlock retry={() => charQ.refetch()} /> : <div className="grid lg:grid-cols-[.8fr_1.2fr] gap-6 mb-12">
      <div className="rounded-[28px] bg-[#214e43] text-[#fff9e8] p-8 flex flex-col items-center text-center">
        <span className="text-[#edbd83] text-sm font-bold">رفيق رحلتك</span>
        <div className="my-5 rounded-full bg-[#3c725e] p-4"><CharacterAvatar items={char?.equippedItems ?? []} height={210} testId="character-preview" /></div>
        <div className="flex flex-wrap justify-center gap-2 min-h-8">
          {char?.equippedItems.length ? char.equippedItems.map(i => <span key={i.id} className="badge" aria-label={`${slotLabels[i.slot]}: ${i.name}`}><Check size={12} />{i.name}</span>) : <span className="text-sm text-[#c4d8c8]">لا عناصر مجهّزة بعد</span>}
        </div>
      </div>
      <div className="paper rounded-[28px] p-7 flex flex-col">
        <span className="eyebrow">مستواك الآن</span>
        <h2 className="text-4xl font-black mt-1" data-testid="text-level">المستوى {level}</h2>
        {charQ.levelUp && <p role="status" className="badge mt-2 w-fit pop"><Sparkles size={13} />ارتقيت إلى المستوى {charQ.levelUp}</p>}
        <div className="mt-5"><div className="flex justify-between text-sm font-bold"><span>نحو المستوى التالي</span><span dir="ltr">{char?.xp ?? 0} / {char?.xpToNextLevel ?? 0} XP</span></div>
          <div className="h-2.5 bg-[#e3e0cc] rounded-full mt-2 overflow-hidden"><div className="h-full bg-[#245448] rounded-full" style={{ width: `${pct}%` }} /></div></div>
        <div className="grid grid-cols-2 gap-3 mt-5">
          <div className="panel rounded-2xl p-4"><div className="text-xs muted flex gap-1 items-center"><Coins size={13} />رصيدك</div><b className="text-2xl" data-testid="text-balance">{balance}</b></div>
          <div className="panel rounded-2xl p-4"><div className="text-xs muted flex gap-1 items-center"><Star size={13} />إجمالي الخبرة</div><b className="text-2xl">{char?.totalXp ?? char?.xp ?? 0}</b></div>
        </div>
        <div className="mt-5"><div className="text-sm font-bold mb-2">آخر تقدّم</div>
          {char?.recentProgress?.length ? <div className="space-y-1">{char.recentProgress.slice(0, 5).map((p, idx) => <div key={`${p.date}-${idx}`} className="flex justify-between text-sm border-b border-[#e8dfcb] py-1.5"><span className="muted">{arDate(p.date)}</span><span dir="ltr">{p.xpEarned === null ? '— XP' : `+${p.xpEarned} XP`} · {p.coinsEarned === null ? '—' : `+${p.coinsEarned}`}</span></div>)}</div> : <p className="text-sm muted">سيظهر تقدّمك الحقيقي هنا بعد أول تسجيل.</p>}
        </div>
      </div>
    </div>}

    {offer && <div className="paper rounded-2xl p-4 mb-6 flex flex-wrap items-center gap-3 pop"><Sparkles size={18} /><span className="flex-1">اشتريت «{offer.name}». هل تجهّزه الآن؟</span><button className="btn" disabled={busy} onClick={() => doEquip(offer)}>تجهيز الآن</button><button className="btn btn-light" onClick={() => setOffer(null)}>لاحقًا</button></div>}

    <SectionTitle label="كل ما يرافقك" title="خزانة الشخصية" />
    <div className="flex flex-wrap gap-2 mb-5">{filters.map(s => <button key={s} className={`rounded-full px-4 py-2 text-sm ${filter === s ? 'bg-[#245448] text-white' : 'bg-[#e9e4d7]'}`} onClick={() => setFilter(s)}>{s === 'all' ? 'الكل' : slotLabels[s]}</button>)}</div>
    {charQ.isLoading || catalogQ.isLoading ? <Loading /> : charQ.isError || !known ? <ErrorBlock retry={() => charQ.refetch()} /> : catalogQ.isError ? <ErrorBlock retry={() => catalogQ.refetch()} /> : !shown.length ? <Empty title="لا عناصر هنا بعد" desc="ستظهر هنا العناصر التي ترافق شخصيتك." /> :
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 mb-14">{shown.map(item => {
        const locked = levelLocked(item), short = item.coinCost - balance;
        return <div key={item.id} data-testid={`card-item-${item.id}`} className="paper rounded-2xl p-4 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="w-16 shrink-0 rounded-xl bg-[#e9eadb] flex items-center justify-center"><CharacterAvatar items={[item]} height={64} /></div>
            <div className="flex-1 min-w-0"><strong className="block truncate">{item.name}</strong><span className="text-xs muted">{slotLabels[item.slot]}</span></div>
            {!owned(item) && <span className="badge"><Coins size={12} />{item.coinCost}</span>}
          </div>
          {equipped(item) ? <div className="flex gap-2"><span className="badge flex-1 justify-center"><Check size={13} />مجهّز</span><button className="btn btn-light !py-2 text-sm" disabled={busy} onClick={() => doUnequip(item)}>إزالة</button></div>
            : owned(item) ? <div className="flex gap-2"><span className="badge flex-1 justify-center">مملوك</span><button className="btn !py-2 text-sm" disabled={busy} onClick={() => doEquip(item)}>تجهيز</button></div>
            : locked ? <div className="text-sm muted flex items-center gap-2"><Lock size={14} />يُفتح عند المستوى {item.levelRequired}</div>
            : short > 0 ? <div className="flex items-center justify-between gap-2 text-sm"><span className="muted">ينقصك {short} عملة</span><Link href="/journey" className="font-bold text-[#245448] underline">اكسبها من رحلتك</Link></div>
            : <button className="btn !py-2 text-sm" disabled={busy} onClick={() => { setError(null); setConfirm(item); }}>شراء</button>}
        </div>;
      })}</div>}

    <div className="grid lg:grid-cols-[.9fr_1.1fr] gap-9">
      <div><ConsistencyOverview /></div>
      <div><SectionTitle label="الطريق أمامك" title="محطات الرحلة" />
        {journey.isLoading ? <Loading /> : journey.isError ? <ErrorBlock retry={() => journey.refetch()} /> : !journey.data?.milestones.length ? <Empty title="لا محطات بعد" desc="ستظهر محطاتك هنا." /> :
          <div className="space-y-3">{journey.data.milestones.map(m => <div key={m.id} className={`paper rounded-2xl p-4 flex items-center gap-3 ${m.reached ? '' : 'opacity-70'}`}>
            <span className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${m.reached ? 'bg-[#32765a] text-white' : 'bg-[#dedfd2]'}`}>{m.reached ? <Check size={15} /> : <Lock size={13} />}</span>
            <div className="flex-1"><div className="eyebrow">المستوى {m.levelRequired}</div><h3 className="font-bold">{m.title}</h3><p className="muted text-sm">{m.description}</p></div>
            <span className="badge">+{m.rewardCoins} عملة</span></div>)}</div>}
      </div>
    </div>

    <Dialog open={!!confirm} onOpenChange={o => { if (!o && !purchase.isPending) { setConfirmId(null); setError(null); } }}>
      {confirm && <DialogContent className="bg-[#fffaf0] border-[#e8dfcb]" onEscapeKeyDown={e => purchase.isPending && e.preventDefault()} onInteractOutside={e => purchase.isPending && e.preventDefault()} dir="rtl">
        <DialogHeader className="text-right"><DialogTitle>تأكيد الشراء</DialogTitle><DialogDescription>السعر والرصيد من آخر بيانات محمّلة؛ الخادم يتحقق منهما عند الشراء.</DialogDescription></DialogHeader>
      <div className="flex items-center gap-4 mb-4"><CharacterAvatar items={[...(char?.equippedItems ?? []).filter(i => i.slot !== confirm.slot), confirm]} height={110} /><div><b className="text-lg">{confirm.name}</b><div className="muted text-sm">{slotLabels[confirm.slot]}</div></div></div>
      <div className="panel rounded-xl p-4 space-y-1 text-sm mb-4"><div className="flex justify-between"><span>السعر</span><b>{confirm.coinCost}</b></div><div className="flex justify-between"><span>رصيدك الآن</span><b>{balance}</b></div><div className="flex justify-between"><span>الرصيد بعد الشراء</span><b data-testid="text-balance-after">{balance - confirm.coinCost}</b></div></div>
      {balance < confirm.coinCost && <p role="alert" className="text-sm text-[#bc4a3a] mb-3">رصيدك لم يعد كافيًا لهذا العنصر.</p>}
            {error && <p role="alert" className="text-sm text-[#bc4a3a] mb-3">{error}</p>}
      <div className="flex gap-2"><button className="btn flex-1" disabled={purchase.isPending || balance < confirm.coinCost} onClick={doBuy}>{purchase.isPending ? 'جارٍ الشراء...' : error ? 'إعادة المحاولة' : 'تأكيد الشراء'}</button><button className="btn btn-light" disabled={purchase.isPending} onClick={() => setConfirm(null)}>إلغاء</button></div>
          </DialogContent>}
    </Dialog>
  </>;
}
export default CharacterPage;
