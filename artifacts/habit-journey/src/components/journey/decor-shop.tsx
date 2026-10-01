import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useListDecorationCatalog, usePurchaseDecorationItem, useGetHabitDecorations, usePlaceHabitDecoration, useRemoveHabitDecoration, useGetWallet, getListDecorationCatalogQueryKey, getGetHabitDecorationsQueryKey, getGetWalletQueryKey, getGetCurrentUserQueryKey, getListWalletTransactionsQueryKey } from '@workspace/api-client-react';
import { toast } from 'sonner';
import { Coins, Check, Lock } from 'lucide-react';
import { Loading, ErrorBlock } from '@/components/journey-ui';
import { base } from '@/lib/journey-map';
import { DECOR_ISLANDS, SLOTS, type DecorIslandId } from '@/lib/decor';

const PAGE = 12;
export function DecorShop({ habitId }: { habitId: number }) {
  const qc = useQueryClient();
  const catalog = useListDecorationCatalog(), wallet = useGetWallet();
  const deco = useGetHabitDecorations(habitId, { query: { enabled: !!habitId, queryKey: getGetHabitDecorationsQueryKey(habitId) } });
  const keys = useRef(new Map<number, string>());
  const [confirm, setConfirm] = useState<number | null>(null), [pending, setPending] = useState<number | null>(null);
  const [item, setItem] = useState<number | null>(null), [island, setIsland] = useState<DecorIslandId>('beginnings');
  const [slot, setSlot] = useState<number | null>(null), [shown, setShown] = useState(PAGE), [conflict, setConflict] = useState(false);
  useEffect(() => { setItem(null); setSlot(null); setConfirm(null); setConflict(false); }, [habitId]);
  const buy = usePurchaseDecorationItem(), place = usePlaceHabitDecoration(), remove = useRemoveHabitDecoration();
  const refreshMoney = () => { qc.invalidateQueries({ queryKey: getListDecorationCatalogQueryKey() }); qc.invalidateQueries({ queryKey: getGetWalletQueryKey() }); qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() }); qc.invalidateQueries({ queryKey: getListWalletTransactionsQueryKey() }); };
  const refreshPlace = () => qc.invalidateQueries({ queryKey: getGetHabitDecorationsQueryKey(habitId) });
  const coins = wallet.data?.coins ?? 0;
  const placements = deco.data?.placements ?? [];
  const taken = new Map(placements.filter(p => p.islandId === island).map(p => [p.slot, p]));
  const doBuy = (id: number) => {
    if (pending !== null) return;
    if (!keys.current.has(id)) keys.current.set(id, crypto.randomUUID());
    setPending(id);
    buy.mutate({ itemId: id, data: { idempotencyKey: keys.current.get(id)! } }, {
      onSuccess: r => { keys.current.delete(id); setConfirm(null); refreshMoney(); toast.success(r.purchased ? 'صار العنصر ملكك' : 'العنصر مملوك لك من قبل'); },
      onError: () => { refreshMoney(); toast.error('تعذّر الشراء. يمكنك المحاولة مجددًا دون خصم مضاعف.'); },
      onSettled: () => setPending(null),
    });
  };
  const doPlace = () => {
    if (item === null || slot === null) return;
    setConflict(false);
    place.mutate({ habitId, itemId: item, data: { islandId: island, slot } }, {
      onSuccess: () => { refreshPlace(); setSlot(null); toast.success('وُضع العنصر على الجزيرة'); },
      onError: (e: unknown) => { if ((e as { status?: number })?.status === 409) { setConflict(true); refreshPlace(); } else toast.error('تعذّر الوضع، حاول مرة أخرى'); },
    });
  };
  const doRemove = (id: number) => remove.mutate({ habitId, itemId: id }, { onSuccess: () => { refreshPlace(); toast.success('أُزيل العنصر وبقي ملكك'); }, onError: () => toast.error('تعذّر الإزالة') });
  const list = catalog.data ?? [];
  const sel = list.find(x => x.id === item);
  const placedOf = (id: number) => placements.find(p => p.decorationId === id);
  return <section className="paper rounded-[22px] p-4 space-y-4" data-testid="decor-shop" aria-label="متجر زينة الجزر">
    <div className="flex justify-between items-center"><h2 className="font-black text-lg">زينة الجزر</h2><span className="badge"><Coins size={14} /> {coins}</span></div>
    <div role="group" aria-label="اختيار الجزيرة" className="flex flex-wrap gap-1.5">{DECOR_ISLANDS.map(i => <button key={i.id} aria-pressed={island === i.id} onClick={() => { setIsland(i.id); setSlot(null); setConflict(false); }} className={`rounded-full px-3 py-1.5 text-sm ${island === i.id ? 'bg-[#245448] text-white' : 'bg-[#e9e4d7]'}`}>{i.name}</button>)}</div>
    <div role="group" aria-label="مواضع الجزيرة" className="grid grid-cols-6 gap-1.5">{SLOTS.map(s => { const t = taken.get(s); return <button key={s} disabled={!!t} aria-pressed={slot === s} aria-label={t ? `الموضع ${s + 1} مشغول بـ ${t.name}` : `الموضع ${s + 1} فارغ`} onClick={() => setSlot(s)} className={`aspect-square rounded-lg border text-xs flex items-center justify-center ${slot === s ? 'border-[#245448] bg-[#dfe9d8]' : 'border-[#ddd6c3] bg-[#f6f1e6]'} ${t ? 'opacity-70' : ''}`}>{t ? <img src={base(t.assetFile)} alt="" className="max-h-full max-w-full p-1" /> : s + 1}</button>; })}</div>
    {conflict && <p role="alert" className="text-sm rounded-lg bg-[#f8e8df] p-2">هذا الموضع صار مشغولًا. حدّثنا المواضع، اختر موضعًا آخر ثم أعد المحاولة.</p>}
    <div className="flex gap-2 flex-wrap">
      <button className="btn" data-testid="button-place-decor" disabled={item === null || slot === null || !sel?.owned || place.isPending || deco.isError || !deco.data || !!taken.get(slot)} onClick={doPlace}>{place.isPending ? 'جارٍ الوضع…' : sel && placedOf(sel.id) ? 'انقل إلى هنا' : 'ضع على الجزيرة'}</button>
      {sel && placedOf(sel.id) && <button className="btn btn-light" disabled={remove.isPending} onClick={() => doRemove(sel.id)}>إزالة من الجزيرة</button>}
    </div>
    <p className="text-xs muted">{item === null ? 'اختر عنصرًا تملكه، ثم جزيرة وموضعًا.' : sel && !sel.owned ? 'اشترِ العنصر أولًا لتضعه.' : 'اختر موضعًا فارغًا ثم اضغط وضع.'}</p>
    {catalog.isLoading || deco.isLoading || wallet.isLoading ? <Loading /> : catalog.isError || deco.isError || wallet.isError ? <ErrorBlock retry={() => { catalog.refetch(); deco.refetch(); wallet.refetch(); }} /> : !list.length ? <p className="muted text-sm">لا عناصر متاحة الآن.</p> : <>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 gap-2">{list.slice(0, shown).map(it => { const can = coins >= it.coinCost, pl = placedOf(it.id); return <div key={it.id} className={`rounded-xl border p-2 flex flex-col gap-1.5 ${item === it.id ? 'border-[#245448] bg-[#eef3e6]' : 'border-[#e8dfcb] bg-[#fffdf7]'}`} data-testid={`decor-item-${it.id}`}>
        <button className="h-16 flex items-center justify-center" aria-label={`اختيار ${it.name}`} onClick={() => setItem(it.id)}><img src={base(it.assetFile)} alt="" className="max-h-16 max-w-full object-contain" loading="lazy" /></button>
        <strong className="text-xs truncate">{it.name}</strong>
        {it.owned ? <span className="text-xs text-[#31765a] flex items-center gap-1"><Check size={13} />{pl ? 'موضوع' : 'مملوك'}</span>
          : confirm === it.id ? <div className="space-y-1"><div className="text-[11px]">شراء بـ {it.coinCost} عملة؟</div><div className="flex gap-1"><button className="btn !px-2 !py-1 text-xs flex-1" disabled={pending !== null} onClick={() => doBuy(it.id)}>{pending === it.id ? '…' : buy.isError && keys.current.has(it.id) ? 'أعد المحاولة' : 'تأكيد'}</button><button className="btn btn-light !px-2 !py-1 text-xs" disabled={pending !== null} onClick={() => setConfirm(null)}>لا</button></div></div>
          : <button className="btn !px-2 !py-1 text-xs" disabled={!can || pending !== null} onClick={() => { setConfirm(it.id); setItem(it.id); }}>{can ? <Coins size={12} /> : <Lock size={12} />}{it.coinCost}{can ? '' : ' · لا تكفي'}</button>}
      </div>; })}</div>
      {shown < list.length && <button className="btn btn-light w-full" onClick={() => setShown(s => s + PAGE)}>عرض المزيد ({list.length - shown})</button>}
    </>}
  </section>;
}
