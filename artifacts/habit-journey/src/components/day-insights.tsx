import { Link } from 'wouter';
import { Brain, Smartphone, Sprout, CalendarClock, ArrowLeft, Gauge } from 'lucide-react';
import type { TrackedDayAnalysis } from '@workspace/api-client-react';

const icon = (t: string) => t === 'focus' ? Brain : t === 'dominant_activity' ? Smartphone : t === 'consistency' ? Sprout : Gauge;

export function DayInsights({ analysis, trackedMinutes, onRetry, compact = false }: { analysis?: TrackedDayAnalysis | null; trackedMinutes?: number; onRetry?: () => void; compact?: boolean }) {
  const real = analysis ? (analysis.insights ?? []).filter(i => i.type !== 'insufficient') : [];
  const adj = analysis?.habitAdjustment;
  return <section aria-label="ماذا يقول يومك؟" data-testid="section-day-insights" dir="rtl" className="rounded-2xl bg-[#f3ead9] p-4 min-w-0">
    <div className="eyebrow mb-1">قراءة من بياناتك</div>
    <h3 className="text-lg font-black">ماذا يقول يومك؟</h3>
    {!analysis ? <div className="mt-2 text-sm muted leading-7">
      <p>{(trackedMinutes ?? 0) > 0 ? 'لم نقرأ هذا اليوم بعد. افتح وقتي حين تشاء لتظهر قراءته هنا.' : 'نحتاج إلى وقت مسجّل لنقول شيئًا صادقًا عن يومك.'}</p>
      {onRetry && <button type="button" className="underline font-bold" onClick={onRetry}>إعادة المحاولة</button>}
    </div> : real.length === 0 ? <p className="mt-2 text-sm muted leading-7" data-testid="text-insights-missing">{analysis.status === 'ready' ? 'لا تكفي التسجيلات لنمط واضح بعد. سجّل يومًا آخر وسنقرأه معك.' : 'نحتاج إلى مزيد من التسجيلات قبل أن نقول شيئًا عن نمطك. لن نخمّن.'}</p>
    : <ul className={`mt-3 grid gap-2 ${compact ? '' : 'sm:grid-cols-3'}`}>{real.slice(0, 3).map((i, k) => { const I = icon(i.type); return <li key={k} className="panel rounded-xl p-3 min-w-0"><div className="flex items-center gap-1 text-xs font-bold text-[#245448]"><I size={14} aria-hidden="true" />{i.label}</div><b className="block mt-1 break-words">{i.value}</b><small className="muted block mt-1 leading-5">{i.evidence}</small></li>; })}</ul>}
    {analysis?.status === 'ready' && analysis.bestTimeSuggestion && <p className="mt-3 text-sm leading-7 flex gap-2"><CalendarClock size={16} className="shrink-0 mt-1" aria-hidden="true" /><span>وقت قد يناسب عادتك: <b dir="ltr">{analysis.bestTimeSuggestion.start} – {analysis.bestTimeSuggestion.end}</b>. {analysis.bestTimeSuggestion.reason}</span></p>}
    {analysis?.status === 'ready' && analysis.tomorrowSuggestion && <div className="mt-3 border-t border-[#dccfb5] pt-3"><b className="text-sm">اقتراح الغد</b><p className="text-sm leading-7 mt-1" data-testid="text-tomorrow-suggestion">{analysis.tomorrowSuggestion}</p></div>}
    {adj && adj.action !== 'maintain' && <div className="mt-3 rounded-xl bg-[#e6eee2] p-3" data-testid="card-day-adjustment"><p className="text-sm leading-7"><b>{adj.habitTitle}</b>: {(adj.action === 'increase' || adj.action === 'decrease') && <>من {adj.currentTarget} إلى {adj.suggestedTarget}. </>}{adj.reason}</p><Link href={`/habits/${adj.habitId}`} className="inline-flex items-center gap-1 text-sm font-bold mt-1 min-h-11 text-[#23604e]" data-testid="link-review-adjustment">راجع التعديل في صفحة العادة <ArrowLeft size={14} aria-hidden="true" /></Link><p className="text-xs muted">لا يتغير شيء قبل أن تؤكد بنفسك.</p></div>}
  </section>;
}
