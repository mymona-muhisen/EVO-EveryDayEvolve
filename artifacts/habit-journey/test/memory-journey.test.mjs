import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Real-component React SSR with pre-seeded query caches; no API, browser, or mutation execution.
const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.resolve(here, '..');
const api = path.resolve(ui, '../api-server');
const apiRequire = createRequire(path.join(api, 'package.json'));
const esbuild = apiRequire('esbuild');
const work = await mkdtemp(path.join(tmpdir(), 'habit-memory-ssr-'));
await symlink(path.join(ui, 'node_modules'), path.join(work, 'node_modules'), 'dir');

const entry = `
  import React from 'react';
  import { renderToPipeableStream } from 'react-dom/server';
  import { Writable } from 'node:stream';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { Router } from 'wouter';
  import { getGetMemoryQueryKey, getListMemoriesQueryKey } from '@workspace/api-client-react';
  import { DayMemory, JourneyMemories, canCaptureDay } from '@/components/memory/memory';
  import { MemoriesPage } from '@/pages/life';
  import { journeyDayFromSearch, memoryDayHref } from '@/lib/memory-navigation';
  import { classifyDay, nodeLabel } from '@/lib/journey-map';
  export { journeyDayFromSearch, memoryDayHref, canCaptureDay, classifyDay, nodeLabel };
  async function render(element, seed, ssrPath = '/') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    seed(client);
    const app = React.createElement(QueryClientProvider, { client },
      React.createElement(Router, { ssrPath }, element));
    return new Promise((resolve, reject) => {
      let html = '';
      const sink = new Writable({ write(chunk, _encoding, done) { html += chunk; done(); } });
      sink.on('finish', () => { client.clear(); resolve(html); });
      const stream = renderToPipeableStream(app, {
        onAllReady() { stream.pipe(sink); },
        onShellError: reject,
        onError: reject,
      });
    });
  }
  export function renderGallery(memories) {
    return render(React.createElement(MemoriesPage), client => {
      client.setQueryData(getListMemoriesQueryKey({}), memories);
    }, '/memories');
  }
  export function renderDayMemory(memory) {
    return render(React.createElement(DayMemory, {
      habitId: memory.habitId, date: memory.date, dayNumber: memory.dayNumber,
      memoryId: memory.id, canCreate: false,
    }), client => client.setQueryData(getGetMemoryQueryKey(memory.id), memory));
  }
  export function renderRecap(habitId, memories) {
    return render(React.createElement(JourneyMemories, { habitId }), client => {
      client.setQueryData(getListMemoriesQueryKey({ habitId }), memories);
    });
  }
`;

await esbuild.build({
  stdin: { contents: entry, resolveDir: ui, sourcefile: 'memory-journey-entry.tsx', loader: 'tsx' },
  outfile: path.join(work, 'render.mjs'),
  absWorkingDir: ui,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/server', '@tanstack/react-query', 'wouter', 'lucide-react', 'sonner', '@radix-ui/react-dialog'],
  alias: { '@': path.join(ui, 'src') },
  define: { 'import.meta.env.BASE_URL': '"/"' },
  plugins: [{
    name: 'ssr-memory-image-shell',
    setup(build) {
      // Keep the real MemoryImage/DayMemory components, but render the authenticated image hook's loading state in SSR.
      build.onResolve({ filter: /components\/reward\/real-reward$/ }, () => ({ path: path.join(ui, 'src/components/reward/real-reward.tsx'), namespace: 'memory-test' }));
      build.onLoad({ filter: /real-reward\.tsx$/, namespace: 'memory-test' }, async args => ({
        contents: (await readFile(args.path, 'utf8')).replace('const { session, user } = useClerk();', 'const session = null, user = null;'),
        resolveDir: path.dirname(args.path),
        loader: 'tsx',
      }));
    },
  }],
  logLevel: 'silent',
});
const { journeyDayFromSearch, memoryDayHref, canCaptureDay, classifyDay, nodeLabel, renderGallery, renderDayMemory, renderRecap } =
  await import(pathToFileURL(path.join(work, 'render.mjs')).href);

const memory = (overrides = {}) => ({
  id: 12, habitId: 4, habitDayId: 504, dayNumber: 4, journeyId: 44, journeyLength: 22,
  habitTitle: 'قراءة', date: '2025-02-04', note: null, caption: 'نافذة مشمسة',
  photoUrl: null, visibility: 'private', createdAt: '2025-02-04T12:00:00Z',
  updatedAt: '2025-02-04T12:00:00Z', ...overrides,
});
const readSource = rel => readFile(path.join(ui, rel), 'utf8');
const cleanup = () => rm(work, { recursive: true, force: true });
test.after(cleanup);

test('day queries accept only valid 1–22 dates, including a directly opened deep link', () => {
  assert.equal(journeyDayFromSearch('?day=1'), 1);
  assert.equal(journeyDayFromSearch('?day=14'), 14);
  assert.equal(journeyDayFromSearch('?day=22'), 22);
  for (const search of ['', '?other=4', '?day=', '?day=0', '?day=23', '?day=-1', '?day=2.5', '?day=1e1', '?day=abc']) {
    assert.equal(journeyDayFromSearch(search), null, search || 'missing day');
  }
});

test('memory destinations require all persisted journey-day identifiers; legacy habit/date data is not guessed', () => {
  assert.equal(memoryDayHref(memory()), '/habits/44/journey?day=4');
  for (const old of [
    { habitId: 4, date: '2025-02-04', journeyId: null, habitDayId: null, dayNumber: null },
    { ...memory(), journeyId: null },
    { ...memory(), habitDayId: null },
    { ...memory(), dayNumber: null },
    { ...memory(), dayNumber: 23 },
  ]) assert.equal(memoryDayHref(old), null);
});

test('saved gallery links directly to verified days while legacy text remains readable without a guessed link', async () => {
  const old = memory({ id: 13, habitDayId: null, journeyId: null, dayNumber: null, caption: 'ذكرى قديمة محفوظة' });
  const html = await renderGallery([memory(), old]);
  assert.match(html, /href="\/habits\/44\/journey\?day=4"/);
  assert.match(html, /نافذة مشمسة/);
  assert.match(html, /ذكرى قديمة محفوظة/);
  assert.match(html, /ذكرى قديمة غير مرتبطة بيوم محدد/);
  assert.doesNotMatch(html, /href="\/habits\/4\/journey|href="\/habits\/44\/journey\?day=null/);
  assert.doesNotMatch(html, /memory-chooser|button-memory-add|إضافة ذكرى/);
});

test('seeded getMemory cache renders inline DayMemory caption and photo-accessible shell', async () => {
  const html = await renderDayMemory(memory({ photoUrl: '/objects/private-memory-photo' }));
  assert.match(html, /data-testid="day-memory"/);
  assert.match(html, /data-testid="text-day-memory-caption">نافذة مشمسة/);
  assert.match(html, /ذكرى هذا اليوم/);
  assert.match(html, /data-testid="button-day-memory-view"/);
  // SSR verifies the real component's photo placeholder/alt shell; authenticated image fetching is not executed here.
  assert.match(html, /aria-label="تحميل الصورة"/);
  const memorySource = await readSource('src/components/memory/memory.tsx');
  assert.match(memorySource, /alt=\{`ذكرى اليوم \$\{dayNumber\}`\}/);
});

test('recap SSR includes only verified saved memories and links each tile to its own journey day', async () => {
  const unrelated = memory({ id: 13, habitDayId: null, journeyId: null, dayNumber: null, caption: 'غير مرتبطة' });
  const firstPhoto = memory({ photoUrl: '/objects/day-four-photo' });
  const anotherDay = memory({ id: 14, habitDayId: 514, dayNumber: 14, date: '2025-02-14', caption: 'ذكرى اليوم الرابع عشر', photoUrl: '/objects/day-fourteen-photo' });
  const html = await renderRecap(4, [firstPhoto, unrelated, anotherDay]);
  assert.match(html, /data-testid="recap-memories"/);
  assert.match(html, /aria-label="افتح ذكرى اليوم 4 في الرحلة" href="\/habits\/44\/journey\?day=4"/);
  assert.match(html, /aria-label="افتح ذكرى اليوم 14 في الرحلة" href="\/habits\/44\/journey\?day=14"/);
  assert.equal([...html.matchAll(/aria-label="تحميل الصورة"/g)].length, 2);
  assert.doesNotMatch(html, /غير مرتبطة/);
});

test('capture remains optional and eligibility excludes unsaved, unscheduled, future, incomplete, and duplicate days', async () => {
  const day = (overrides = {}) => ({
    habitDayId: 504, scheduled: true, date: '2025-02-04', dayNumber: 4,
    checkin: { completed: true }, memoryId: null, ...overrides,
  });
  assert.equal(canCaptureDay(day(), '2025-02-04'), true);
  assert.equal(canCaptureDay(day({ habitDayId: null }), '2025-02-04'), false);
  assert.equal(canCaptureDay(day({ scheduled: false }), '2025-02-04'), false);
  assert.equal(canCaptureDay(day({ date: '2025-02-05' }), '2025-02-04'), false);
  assert.equal(canCaptureDay(day({ checkin: { completed: false } }), '2025-02-04'), false);
  assert.equal(canCaptureDay(day({ checkin: null }), '2025-02-04'), false);
  assert.equal(canCaptureDay(day({ memoryId: 12 }), '2025-02-04'), false);

  const source = await readSource('src/components/memory/memory.tsx');
  assert.match(source, /صورة خاصة بك وحدك، اختيارية تمامًا ولا تؤثر على نجاح يومك/);
  assert.match(source, /if \(!memoryId && \(!canCreate \|\| later\)\) return null/);
});

test('map memory status is exposed in its state label and its camera badge nests within the day node', async () => {
  const d = { dayNumber: 5, date: '2025-02-05', scheduled: true, status: 'completed', checkin: { completed: true }, memoryId: 12 };
  const state = classifyDay(d, '2025-02-05');
  assert.equal(nodeLabel(d, state), 'اليوم 5: يوم ناجح، محطة، له ذكرى');

  // Static JSX assertion: map centering/scroll effects are browser-only and are not exercised by this SSR suite.
  const source = await readSource('src/components/journey/journey-map.tsx');
  assert.match(source, /data-testid=\{`node-day-\$\{d\.dayNumber\}`\} aria-label=\{nodeLabel\(d, s\)\}/);
  assert.match(source, /<button[^]*?data-testid=\{`node-day-\$\{d\.dayNumber\}`\}[^]*?<span data-testid=\{`badge-map-memory-\$\{d\.dayNumber\}`\} aria-hidden="true"[^]*?<Camera size=\{13\}[^]*?<\/span>[^]*?<\/button>/);
});

test('oversized legacy captions remain fully visible in the existing memory detail source', async () => {
  const source = await readSource('src/components/memory/memory.tsx');
  assert.match(source, /const orig = memoryText\(memory\), long = orig\.length > 300/);
  assert.match(source, /data-testid="text-memory-legacy-full"><p className="whitespace-pre-wrap break-words">\{orig\}<\/p>/);
  assert.match(source, /يبقى كما هو إلى أن تستبدله بنص أقصر أو تمسحه/);
});

test('journey route initializes and follows selection from the validated query day', async () => {
  const source = await readSource('src/pages/habit-journey.tsx');
  assert.match(source, /const requestedDay = journeyDayFromSearch\(useSearch\(\)\)/);
  assert.match(source, /const \[sel, setSel\] = useState<number \| null>\(requestedDay\)/);
  assert.match(source, /const cur = sel \?\? calendarDay\(d\)/);
  assert.match(source, /nav\(`\/habits\/\$\{id\}\/journey\?day=\$\{n\}`,\s*\{ replace: true \}\)/);
});