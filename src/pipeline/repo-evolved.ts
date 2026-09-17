/** Parse a GitHub repository name for display. Repository activity is not story identity. */
export function repoFullNameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    // skip non-repo paths (orgs, marketplace, topics, sponsors, etc.)
    if (["orgs", "marketplace", "topics", "sponsors", "settings", "features", "about"].includes(owner.toLowerCase())) return null;
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}
