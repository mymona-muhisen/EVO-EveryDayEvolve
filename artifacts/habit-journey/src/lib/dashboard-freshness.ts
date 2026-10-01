import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Coalesce existing feature invalidations and successful writes into one
 * dashboard refresh. Cache reads and the dashboard's own invalidation are
 * deliberately ignored so this cannot form a refetch loop.
 */
export function subscribeDashboardFreshness(queryClient: QueryClient, dashboardKey: QueryKey) {
  let active = true;
  let queued = false;
  const queueRefresh = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (active) void queryClient.invalidateQueries({ queryKey: dashboardKey });
    });
  };
  const stopQueries = queryClient.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'invalidate') return;
    const key = event.query.queryKey[0];
    if (key === dashboardKey[0]) return;
    if (typeof key === 'string' && (key.startsWith('/api/') || key === 'social')) queueRefresh();
  });
  const stopMutations = queryClient.getMutationCache().subscribe(event => {
    if (event.type === 'updated' && event.action.type === 'success') queueRefresh();
  });
  return () => {
    active = false;
    stopQueries();
    stopMutations();
  };
}