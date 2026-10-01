import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { getGetCurrentUserQueryKey, getGetMyCharacterQueryKey, useGetMyCharacter, type User } from '@workspace/api-client-react';

/** All surfaces share the authenticated user's server-owned appearance. */
export function useGlobalCharacter() {
  const qc = useQueryClient();
  const userId = qc.getQueryData<User>(getGetCurrentUserQueryKey())?.id;
  const query = useGetMyCharacter({ query: {
    queryKey: getGetMyCharacterQueryKey(),
    staleTime: 15_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  } });
  const [levelUp, setLevelUp] = useState<number | null>(null);
  const level = query.data?.level;
  useEffect(() => {
    if (level === undefined || !userId) return;
    // UI-only state survives route/remount changes but is cleared with the
    // authenticated query cache. Never use it to calculate or grant rewards.
    const key = ['character-level-feedback', userId];
    qc.setQueryDefaults(['character-level-feedback'], { gcTime: Infinity });
    const previousLevel = qc.getQueryData<number>(key);
    const gained = previousLevel !== undefined && level > previousLevel;
    qc.setQueryData(key, level);
    if (!gained) return;
    setLevelUp(level);
    toast.success(`ارتقيت إلى المستوى ${level}`, {
      id: `character-level-${userId}-${level}`,
      description: 'خبرتك السابقة محفوظة. كل خطوة تُضاف إلى تقدّمك.',
      duration: 4500,
    });
    const timer = setTimeout(() => setLevelUp(null), 4500);
    return () => clearTimeout(timer);
  }, [level, userId, qc]);
  return { ...query, levelUp };
}