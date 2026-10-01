import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { subscribeDashboardFreshness } from '../src/lib/dashboard-freshness.ts';

const dashboardKey = ['/api/dashboard'];
function setup() {
  const client = new QueryClient();
  client.setQueryData(dashboardKey, { coins: 10 });
  let count = 0;
  const watch = client.getQueryCache().subscribe(event => {
    if (event.type === 'updated' && event.action.type === 'invalidate' && event.query.queryKey[0] === dashboardKey[0]) count++;
  });
  const stop = subscribeDashboardFreshness(client, dashboardKey);
  return { client, stop, count: () => count, cleanup: () => { stop(); watch(); client.clear(); } };
}

test('existing daily/wallet invalidations refresh the consolidated dashboard once', async () => {
  const s = setup();
  try {
    s.client.setQueryData(['/api/dashboard/today'], {});
    s.client.setQueryData(['/api/users/me'], {});
    void s.client.invalidateQueries({ queryKey: ['/api/dashboard/today'] });
    void s.client.invalidateQueries({ queryKey: ['/api/users/me'] });
    await Promise.resolve();
    assert.equal(s.count(), 1);
    assert.equal(s.client.getQueryState(dashboardKey).isInvalidated, true);
  } finally { s.cleanup(); }
});

test('a successful mutation without legacy invalidations also refreshes home', async () => {
  const s = setup();
  try {
    await s.client.getMutationCache().build(s.client, { mutationFn: async () => ({ saved: true }) }).execute(undefined);
    await Promise.resolve();
    assert.equal(s.count(), 1);
  } finally { s.cleanup(); }
});

test('manual social cache invalidation refreshes home', async () => {
  const s = setup();
  try {
    s.client.setQueryData(['social', 'friends'], []);
    void s.client.invalidateQueries({ queryKey: ['social'] });
    await Promise.resolve();
    assert.equal(s.count(), 1);
  } finally { s.cleanup(); }
});

test('dashboard invalidation and successful query reads cannot cause a refresh loop', async () => {
  const s = setup();
  try {
    s.client.setQueryData(['/api/character/me'], { walletCoins: 11 });
    s.client.setQueryData(dashboardKey, { coins: 11 });
    await Promise.resolve();
    assert.equal(s.count(), 0);
    void s.client.invalidateQueries({ queryKey: dashboardKey });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(s.count(), 1);
  } finally { s.cleanup(); }
});

test('unmount cancels queued refresh and detaches subscribers', async () => {
  const s = setup();
  try {
    s.client.setQueryData(['/api/users/me'], {});
    void s.client.invalidateQueries({ queryKey: ['/api/users/me'] });
    s.stop();
    await Promise.resolve();
    assert.equal(s.count(), 0);
    await s.client.getMutationCache().build(s.client, { mutationFn: async () => ({}) }).execute(undefined);
    await Promise.resolve();
    assert.equal(s.count(), 0);
  } finally { s.cleanup(); }
});

test('unrelated local UI invalidations are ignored', async () => {
  const s = setup();
  try {
    s.client.setQueryData(['local-preferences'], {});
    void s.client.invalidateQueries({ queryKey: ['local-preferences'] });
    await Promise.resolve();
    assert.equal(s.count(), 0);
  } finally { s.cleanup(); }
});