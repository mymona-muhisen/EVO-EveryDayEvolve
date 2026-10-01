/** Keep successful uploads for short-lived form retries, never across identities.
 * Abandoned/replaced files are reclaimed by server-side grace-period cleanup,
 * not by an unreliable browser unload request or an immediate delete.
 */
export function createRetryablePhotoUpload(
  upload: (file: File) => Promise<string>,
  now = Date.now,
) {
  const cache = new WeakMap<File, { path?: string; completedAt?: number; pending?: Promise<string> }>();
  const retryWindow = 24 * 60 * 60 * 1000; // Shorter than the server's seven-day grace.
  return async (file: File): Promise<string> => {
    const existing = cache.get(file);
    if (existing?.pending) return existing.pending;
    if (existing?.path && now() - existing.completedAt! < retryWindow) return existing.path;

    const entry: { path?: string; completedAt?: number; pending?: Promise<string> } = {};
    cache.set(file, entry);
    entry.pending = upload(file);
    try {
      entry.path = await entry.pending;
      entry.completedAt = now();
      return entry.path;
    } catch (error) {
      cache.delete(file); // A failed PUT must be uploaded again.
      throw error;
    } finally {
      entry.pending = undefined;
    }
  };
}