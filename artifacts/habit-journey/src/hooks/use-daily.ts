import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { dayKey } from '@/lib/daily';
import {
  useGetDailyHabitDay, useGetDailyOverview, useChangeDailyHabitExecution, useSaveDailyHabitReflection, useRecordDailyAdaptationDecision,
  getGetDailyHabitDayQueryKey, getGetDailyOverviewQueryKey, getGetDashboardTodayQueryKey, getListHabitsQueryKey, getGetHabitJourneyQueryKey, getGetHabitQueryKey, getGetDashboardCalendarQueryKey,
   getListHabitCheckinsQueryKey, getGetWalletQueryKey, getGetJourneyProgressQueryKey, getGetHabitAdaptationQueryKey, getListRewardsQueryKey, getGetCurrentUserQueryKey, getGetMyCharacterQueryKey, getListWalletTransactionsQueryKey,
  type DailyHabitState, type DailyHabitReflectionInput,
} from '@workspace/api-client-react';

export function useDailyState(habitId: number, rawDate: string) {
  const date = dayKey(rawDate);
  return useGetDailyHabitDay(habitId, date, { query: { enabled: !!habitId && !!date, queryKey: getGetDailyHabitDayQueryKey(habitId, date), refetchOnWindowFocus: true } });
}
export const useDailyOverview = (date?: string) => {
  const params = date ? { date } : undefined;
  return useGetDailyOverview(params, { query: { queryKey: getGetDailyOverviewQueryKey(params) } });
};

/** Invalidate every cache a plan/daily change can affect. habitId optional (create). */
export function invalidateDailyAll(qc: ReturnType<typeof useQueryClient>, habitId?: number) {
  qc.invalidateQueries({ queryKey: getGetDailyOverviewQueryKey() });
  qc.invalidateQueries({ queryKey: [getGetDashboardCalendarQueryKey()[0]] });
  qc.invalidateQueries({ queryKey: getGetDashboardTodayQueryKey() });
  qc.invalidateQueries({ queryKey: getListHabitsQueryKey() });
  if (habitId) {
    qc.invalidateQueries({ queryKey: getGetHabitQueryKey(habitId) });
    qc.invalidateQueries({ queryKey: getGetHabitJourneyQueryKey(habitId) });
    qc.invalidateQueries({ predicate: q => typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith(`/api/habits/${habitId}/daily/`) });
  }
}

export function useRefreshAfterDaily(habitId: number) {
  const qc = useQueryClient();
  return () => {
    invalidateDailyAll(qc, habitId);
    [getGetDailyOverviewQueryKey(), getGetDashboardTodayQueryKey(), getListHabitsQueryKey(), getGetHabitJourneyQueryKey(habitId), getListHabitCheckinsQueryKey({ habitId }), getGetWalletQueryKey(), getGetJourneyProgressQueryKey(), getGetHabitAdaptationQueryKey(habitId), getListRewardsQueryKey(), getGetCurrentUserQueryKey(), getGetMyCharacterQueryKey(), getListWalletTransactionsQueryKey()]
      .forEach(k => qc.invalidateQueries({ queryKey: k }));
    qc.invalidateQueries({ queryKey: getGetHabitQueryKey(habitId) });
    qc.invalidateQueries({ predicate: q => typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith(`/api/habits/${habitId}/daily/`) });
  };
}

/** Display-only ticking: server elapsedSeconds + local delta since that payload arrived. */
export function useLiveElapsed(state: DailyHabitState | undefined, stamp: number) {
  const [, tick] = useState(0);
  const running = !!state && state.status !== 'paused' && !!state.startedAt && !state.finishedAt && !state.pausedAt && state.executionType === 'duration';
  useEffect(() => { if (!running) return; const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, [running]);
  if (!state) return 0;
  return state.elapsedSeconds + (running ? Math.max(0, (Date.now() - stamp) / 1000) : 0);
}

export function useDailyActions(habitId: number, state: DailyHabitState | undefined) {
  const qc = useQueryClient();
  const refresh = useRefreshAfterDaily(habitId);
  const change = useChangeDailyHabitExecution();
  const stateRef = useRef(state); stateRef.current = state;
  const [celebrate, setCelebrate] = useState<{ xp: number; coins: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (action: 'start' | 'pause' | 'resume' | 'finish' | 'update_progress' | 'done', value?: number) => {
    const s = stateRef.current; if (!s) return;
    setError(null);
    change.mutate({ habitId, data: { date: dayKey(s.date), action, expectedRevision: s.revision, ...(value !== undefined ? { value } : {}), idempotencyKey: `${habitId}-${s.date}-${action}-${s.revision}-${value ?? ''}` } }, {
      onSuccess: r => {
        qc.setQueryData(getGetDailyHabitDayQueryKey(habitId, dayKey(s.date)), r.execution);
        refresh();
        if (r.rewardDelta && (r.rewardDelta.xp > 0 || r.rewardDelta.coins > 0)) { setCelebrate({ xp: r.rewardDelta.xp, coins: r.rewardDelta.coins }); setTimeout(() => setCelebrate(null), 4200); }
      },
      onError: (e: unknown) => {
        const st = e && typeof e === 'object' && 'status' in e ? (e as { status: number }).status : 0;
        refresh();
        setError(st === 409 ? 'تغيّر يومك من مكان آخر؛ حدّثنا الحالة، وحاول مرة أخرى.' : st === 0 || st >= 500 ? 'تعذّر الاتصال. لم نفقد شيئًا، حاول مجددًا.' : 'تعذّر حفظ هذه الخطوة.');
        toast.error('لم نتمكن من حفظ الخطوة');
      },
    });
  };
  return { run, pending: change.isPending, celebrate, error, clearError: () => setError(null) };
}

export function useDailyReflection(habitId: number) {
  const qc = useQueryClient(); const refresh = useRefreshAfterDaily(habitId);
  const m = useSaveDailyHabitReflection();
  const save = (rawDate: string, data: { difficulty?: string | null; note?: string | null; missedReason?: string | null }, onDone?: () => void) => {
    const date = dayKey(rawDate);
    m.mutate({ habitId, date, data: data as DailyHabitReflectionInput }, {
      onSuccess: r => { qc.setQueryData(getGetDailyHabitDayQueryKey(habitId, date), r.execution); refresh(); onDone?.(); toast.success(data.missedReason ? 'شكرًا لملاحظتك. لا حكم على ما فات.' : 'حفظنا شعورك بهذه الخطوة'); },
      onError: () => toast.error('تعذّر الحفظ؛ ما كتبته ما زال هنا، حاول مجددًا'),
    });
  };
  return { save, pending: m.isPending };
}

export function useAdaptationDecision(habitId: number) {
  const refresh = useRefreshAfterDaily(habitId); const qc = useQueryClient();
  const m = useRecordDailyAdaptationDecision();
  const decide = (rawDate: string, decision: 'accepted' | 'rejected', onDone?: () => void) =>
    { const date = dayKey(rawDate); m.mutate({ habitId, date, data: { decision } }, { onSuccess: r => { qc.setQueryData(getGetDailyHabitDayQueryKey(habitId, date), r); refresh(); onDone?.(); }, onError: () => toast.error('تعذّر حفظ قرارك؛ حاول مجددًا') }); }
  return { decide, pending: m.isPending };
}
