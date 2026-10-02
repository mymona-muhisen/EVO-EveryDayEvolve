/** Closes the topmost open layer (details sheet, reward panel, any modal). Returns true if one was found. */
export function closeTopLayer(exclude?: Element | null): boolean {
  const all = Array.from(document.querySelectorAll<HTMLElement>('[data-esc-layer],[role="dialog"][aria-modal="true"]')).filter(e => e !== exclude && !e.closest('[inert]'));
  const top = all[all.length - 1];
  if (!top) return false;
  top.querySelector<HTMLElement>('[data-layer-close],[aria-label="إغلاق"]')?.click();
  return true;
}
