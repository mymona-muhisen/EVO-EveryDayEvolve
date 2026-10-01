import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetDashboardHomeQueryKey } from '@workspace/api-client-react';
import { subscribeDashboardFreshness } from '@/lib/dashboard-freshness';

/**
 * Existing feature writers invalidate their own queries. Mirror those signals
 * into the consolidated home, without changing every individual writer.
 */
export function useDashboardFreshness() {
  const queryClient = useQueryClient();
  useEffect(() => subscribeDashboardFreshness(queryClient, getGetDashboardHomeQueryKey()), [queryClient]);
}