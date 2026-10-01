import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetryablePhotoUpload } from '../src/lib/retryable-photo-upload.ts';

const file = () => new File(['photo'], 'photo.png', { type: 'image/png' });

test('a failed reward save can retry using the same successful upload', async () => {
  let uploads = 0;
  const upload = createRetryablePhotoUpload(async () => `/objects/uploads/${++uploads}`);
  const selected = file();
  const first = await upload(selected);
  // Simulate a resource POST failing after the PUT completed.
  await assert.rejects(async () => { throw new Error('save failed'); });
  assert.equal(await upload(selected), first);
  assert.equal(uploads, 1);
});

test('concurrent calls upload a selected file only once', async () => {
  let uploads = 0;
  const upload = createRetryablePhotoUpload(async () => { uploads++; return '/objects/uploads/one'; });
  const selected = file();
  assert.deepEqual(await Promise.all([upload(selected), upload(selected)]), ['/objects/uploads/one', '/objects/uploads/one']);
  assert.equal(uploads, 1);
});

test('failed PUT is not cached and retry performs a fresh upload', async () => {
  let uploads = 0;
  const upload = createRetryablePhotoUpload(async () => {
    if (++uploads === 1) throw new Error('PUT failed');
    return '/objects/uploads/retry';
  });
  const selected = file();
  await assert.rejects(upload(selected), /PUT failed/);
  assert.equal(await upload(selected), '/objects/uploads/retry');
  assert.equal(uploads, 2);
});

test('switching or removing the image never deletes files used by a saved resource', async () => {
  let uploads = 0;
  const upload = createRetryablePhotoUpload(async () => `/objects/uploads/${++uploads}`);
  const original = file(), replacement = file();
  assert.equal(await upload(original), '/objects/uploads/1');
  assert.equal(await upload(replacement), '/objects/uploads/2');
  assert.equal(await upload(original), '/objects/uploads/1');
});

test('an expired local draft reuploads instead of retrying a potentially collected path', async () => {
  let time = 0, uploads = 0;
  const upload = createRetryablePhotoUpload(async () => `/objects/uploads/${++uploads}`, () => time);
  const selected = file();
  await upload(selected);
  time = 24 * 60 * 60 * 1000;
  assert.equal(await upload(selected), '/objects/uploads/2');
});

test('new form or identity has an independent upload cache', async () => {
  let uploads = 0;
  const put = async () => `/objects/uploads/${++uploads}`;
  const selected = file();
  assert.equal(await createRetryablePhotoUpload(put)(selected), '/objects/uploads/1');
  assert.equal(await createRetryablePhotoUpload(put)(selected), '/objects/uploads/2');
});