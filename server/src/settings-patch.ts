// Partial settings updates: zod fills in defaults even for fields a `.partial()` schema leaves
// out, which would reset every setting the request didn't mention. Keep only what was sent.

export function sentOnly<T extends Record<string, unknown>>(parsed: T, raw: unknown): Partial<T> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => k in (raw as object))) as Partial<T>;
}
