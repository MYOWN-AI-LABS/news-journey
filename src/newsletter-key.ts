import { safeId, validDay } from './workspaces.js';
import type { VideoMeta } from './types.js';

/** Pure identity helper; importing it must not load workspace environment or global pipeline paths. */
export function newsletterKeyFor(meta: Pick<VideoMeta, 'id' | 'edition'>): string {
  if (!/^\d{8}/.test(meta.id)) return `video-only-${safeId(meta.id)}`;
  safeId(meta.id); if (meta.edition) safeId(meta.edition);
  const day = `${meta.id.slice(0, 4)}-${meta.id.slice(4, 6)}-${meta.id.slice(6, 8)}`;
  validDay(day);
  return meta.edition && meta.edition !== 'daily-roundup' ? `${day}-${meta.edition}` : day;
}
