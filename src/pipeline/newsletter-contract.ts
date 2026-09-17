export const NEWSLETTER_SECTION_HEADINGS = Object.freeze({
  worthYourTime: "Worth your time",
  radar: "Trending, not yet covered",
  otherDesks: "From the other desks",
});

export type NewsletterOutputFormat = "web" | "linkedin" | "markdown";

/** A historical Trending row must say when the immutable source snapshot observed it. */
export function newsletterCaptureLabel(observedAt: string | undefined): string {
  if (!observedAt) return "";
  const captured = new Date(observedAt);
  if (Number.isNaN(captured.getTime())) return "";
  const stamp = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(captured);
  return `GitHub Trending snapshot: ${stamp}`;
}

/**
 * Section names are user-owned editorial language, not model output. Keep this runtime assertion
 * beside the renderers so a renamed, omitted, or reordered heading cannot be written to disk.
 */
export function assertCanonicalNewsletterHeadings(
  output: string,
  format: NewsletterOutputFormat,
  required: { worthYourTime: boolean; radar: boolean; otherDesks: boolean },
): void {
  const markers = format === "web"
    ? {
        worthYourTime: `<h2 class="sec-title">${NEWSLETTER_SECTION_HEADINGS.worthYourTime}</h2>`,
        radar: `<h2 class="sec-title">${NEWSLETTER_SECTION_HEADINGS.radar}</h2>`,
        otherDesks: `<h2 class="sec-title">${NEWSLETTER_SECTION_HEADINGS.otherDesks}</h2>`,
      }
    : format === "linkedin"
      ? {
          worthYourTime: `<h2>${NEWSLETTER_SECTION_HEADINGS.worthYourTime}</h2>`,
          radar: `<h2>${NEWSLETTER_SECTION_HEADINGS.radar}</h2>`,
          otherDesks: `<h2>${NEWSLETTER_SECTION_HEADINGS.otherDesks}</h2>`,
        }
      : {
          worthYourTime: `## ${NEWSLETTER_SECTION_HEADINGS.worthYourTime}`,
          radar: `## ${NEWSLETTER_SECTION_HEADINGS.radar}`,
          otherDesks: `## ${NEWSLETTER_SECTION_HEADINGS.otherDesks}`,
        };

  if (required.worthYourTime && !output.includes(markers.worthYourTime)) {
    throw new Error(`Newsletter contract violation (${format}): missing exact heading "${NEWSLETTER_SECTION_HEADINGS.worthYourTime}".`);
  }
  if (required.radar && !output.includes(markers.radar)) {
    throw new Error(`Newsletter contract violation (${format}): missing exact heading "${NEWSLETTER_SECTION_HEADINGS.radar}".`);
  }
  if (required.otherDesks && !output.includes(markers.otherDesks)) {
    throw new Error(`Newsletter contract violation (${format}): missing exact heading "${NEWSLETTER_SECTION_HEADINGS.otherDesks}".`);
  }
  for (const [section, marker] of Object.entries(markers)) {
    if (!required[section as keyof typeof required] && output.includes(marker)) {
      throw new Error(`Newsletter contract violation (${format}): empty section heading "${marker.replace(/<[^>]+>|^## /g, "")}".`);
    }
  }
  const orderedMarkers = [
    required.worthYourTime ? markers.worthYourTime : null,
    required.radar ? markers.radar : null,
    required.otherDesks ? markers.otherDesks : null,
  ].filter((marker): marker is string => Boolean(marker));
  if (orderedMarkers.some((marker, index) => index > 0 && output.indexOf(orderedMarkers[index - 1]) > output.indexOf(marker))) {
    throw new Error(`Newsletter contract violation (${format}): supporting sections are out of order.`);
  }
}
