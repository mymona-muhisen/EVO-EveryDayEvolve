import { useState } from 'react';
import type { DailyHabitState } from '@workspace/api-client-react';
import { difficultyLabels } from '@/lib/daily';
import { useDailyReflection } from '@/hooks/use-daily';

/** Optional reflection for any claimed success. Only touched fields are sent; saved values are never wiped. */
export function ReflectionBlock({ state }: { state: DailyHabitState }) {
  const [note, setNote] = useState(state.note ?? '');
  const { save, pending } = useDailyReflection(state.habitId);
  const noteDirty = note.trim() !== (state.note ?? '').trim();
  return <div className="rounded-2xl bg-[#f3ead9] p-4 mt-4 min-w-0" data-testid="block-reflection">
    <h3 className="font-bold">كيف كانت هذه الخطوة؟</h3>
    <p className="muted text-sm mt-1">اختياري، ولا يؤثر على نجاح يومك.</p>
    <div className="grid grid-cols-2 gap-2 my-3">{difficultyLabels.map(([v, t]) => <button key={v} type="button" disabled={pending} data-testid={`button-difficulty-${v}`} aria-pressed={state.difficulty === v} className={`rounded-xl border min-h-12 px-3 text-sm font-semibold ${state.difficulty === v ? 'bg-[#245448] text-white border-[#245448]' : 'border-[#d7cbb8] bg-[#fff9ed]'}`} onClick={() => save(state.date, { difficulty: v })}>{t}</button>)}</div>
    <textarea className="field" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="ما الذي جعلها أسهل أو أصعب؟ (اختياري)" />
    {noteDirty && <button type="button" disabled={pending} data-testid="button-save-note" className="btn btn-light min-h-11 mt-2" onClick={() => save(state.date, { note: note.trim() || null })}>حفظ الملاحظة</button>}
  </div>;
}
