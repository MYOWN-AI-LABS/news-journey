import type { VideoMeta } from "../types.js";

export function hasReviewHold(meta: Pick<VideoMeta, "reviewHold">): boolean {
  return Boolean(meta.reviewHold?.requestedAt);
}

export function assertReviewReleased(
  meta: Pick<VideoMeta, "id" | "reviewHold">,
  action: string,
): void {
  if (!hasReviewHold(meta)) return;
  throw new Error(
    `${meta.id}: explicit review hold blocks ${action}; run the explicit approve command first`,
  );
}

/** This helper is intentionally called only by the explicit review approval command. */
export function clearReviewHold(meta: VideoMeta): void {
  delete meta.reviewHold;
}
