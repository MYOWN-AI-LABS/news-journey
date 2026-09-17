// Read-only adapter informed by Sergey Bulaev's MIT linkedin-skills (ed05c4f).
// No provider selection from environment, no publication, and no paid-call retries.
export type LinkedInPostKind = 'activity' | 'share' | 'ugcPost';
export interface LinkedInReference {
  url: string; urn: string; kind: LinkedInPostKind; id: string; commentUrn?: string;
}
const POST_URN = /^urn:li:(activity|share|ugcPost):(\d{1,30})$/;
const COMMENT_URN = /^urn:li:comment:\((?:urn:li:)?(activity|share|ugcPost):(\d{1,30}),(\d{1,30})\)$/;
const MAX_BYTES = 512 * 1024;
const POST_ACTOR = 'apimaestro~linkedin-post-detail';
const COMMENTS_ACTOR = 'apimaestro~linkedin-post-comments-replies-engagements-scraper-no-cookies';

export function parseLinkedInReference(input: string): LinkedInReference {
  if (typeof input !== 'string' || input.length > 4000) throw new Error('Enter one LinkedIn post URL or post URN');
  const value = input.trim();
  const direct = POST_URN.exec(value);
  if (direct) return { url: `https://www.linkedin.com/feed/update/${value}/`, urn: value, kind: direct[1] as LinkedInPostKind, id: direct[2] };
  if (!value || /[\s\\]/.test(value)) throw new Error('Enter a valid LinkedIn HTTPS post URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a valid LinkedIn HTTPS post URL'); }
  if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error('Use an HTTPS post URL on linkedin.com or www.linkedin.com, without credentials or a custom port');
  }
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new Error('Invalid LinkedIn URL encoding'); }
  const feed = /^\/feed\/update\/(urn:li:(?:activity|share|ugcPost):\d{1,30})\/?$/.exec(path);
  const slug = /^\/posts\/[A-Za-z0-9_-]+[-_](activity|share|ugcPost)-(\d{1,30})(?:-[A-Za-z0-9_-]+)?\/?$/.exec(path);
  const urn = feed?.[1] ?? (slug ? `urn:li:${slug[1]}:${slug[2]}` : '');
  const parsed = POST_URN.exec(urn);
  if (!parsed) throw new Error('Use a LinkedIn post permalink, not a profile, redirect or search URL');
  const comments = url.searchParams.getAll('commentUrn');
  if (comments.length > 1) throw new Error('The LinkedIn URL has conflicting comment identifiers');
  if (comments.length) {
    const comment = COMMENT_URN.exec(comments[0]);
    if (!comment || comment[1] !== parsed[1] || comment[2] !== parsed[2]) throw new Error('The comment identifier does not match this post');
  }
  // Drop tracking parameters and fragments; keep the exact supplied post kind and comment identifier.
  url.search = ''; url.hash = '';
  if (comments.length) url.searchParams.set('commentUrn', comments[0]);
  return { url: url.href, urn, kind: parsed[1] as LinkedInPostKind, id: parsed[2], ...(comments.length ? { commentUrn: comments[0] } : {}) };
}

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown, limit: number): string => typeof value === 'string' ? value.slice(0, limit) : '';
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function identifier(value: unknown): string | null {
  if (typeof value === 'number') return count(value) === null ? null : String(value);
  return typeof value === 'string' && (/^\d{1,30}$/.test(value) || COMMENT_URN.test(value)) ? value : null;
}
function kindUrn(kind: LinkedInPostKind, value: unknown): string | null {
  const digits = identifier(value);
  if (digits && /^\d+$/.test(digits)) return `urn:li:${kind}:${digits}`;
  return typeof value === 'string' && POST_URN.test(value) && value.startsWith(`urn:li:${kind}:`) ? value : null;
}
function postUrn(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { return parseLinkedInReference(value).urn; } catch { return null; }
}
function profileUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000 || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.username || url.password || url.port || !/^\/(in|company)\/[A-Za-z0-9_%.-]+\/?$/.test(url.pathname)) return null;
    url.search = ''; url.hash = ''; return url.href;
  } catch { return null; }
}
function commentLimit(value: unknown): number {
  if (value === undefined) return 20;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 20) throw new Error('Choose between 1 and 20 comments');
  return value;
}
export interface LinkedInCommentContext {
  id: string | null; parentId: string | null; postUrn: string | null;
  text: string; author: string; url: string | null; truncated: boolean;
}
export interface LinkedInContext {
  untrusted: true; provider: 'apify'; fetchedAt: string; requestedUrl: string; actualUrl: string | null;
  post: {
    text: string; author: { name: string; headline: string; url: string | null };
    identifiers: Record<LinkedInPostKind, string | null>;
    publishedAt: string | null; metrics: { reactions: number | null; comments: number | null; shares: number | null }; truncated: boolean;
  };
  comments: LinkedInCommentContext[];
  coverage: { requested: boolean; returned: number; limit: number; complete: false; reason: string };
  warnings: string[];
}
export interface NormalizeLinkedInOptions {
  requestedUrl: string; fetchedAt: string; provider: 'apify'; comments?: unknown;
  includeComments?: boolean; maxComments?: number;
}
/** Source material is data, never instructions or approval. No raw provider payload is retained. */
export function normalizeLinkedInContext(raw: unknown, options: NormalizeLinkedInOptions): LinkedInContext {
  const requested = parseLinkedInReference(options.requestedUrl);
  if (options.provider !== 'apify' || !Number.isFinite(Date.parse(options.fetchedAt))) throw new Error('Valid provider provenance and fetchedAt are required');
  const limit = commentLimit(options.maxComments), source = object(raw);
  const post = Object.keys(object(source.post)).length ? object(source.post) : source;
  const author = object(source.author), stats = object(source.stats), urns = object(post.urn);
  const identifiers: LinkedInContext['post']['identifiers'] = {
    activity: kindUrn('activity', urns.activity_urn), share: kindUrn('share', urns.share_urn), ugcPost: kindUrn('ugcPost', urns.ugcPost_urn),
  };
  for (const value of [post.urn, source.urn, source.shareUrn]) {
    const parsed = typeof value === 'string' ? POST_URN.exec(value) : null;
    if (parsed) identifiers[parsed[1] as LinkedInPostKind] = value as string;
  }
  const warnings: string[] = [];
  let actual: LinkedInReference | null = null;
  const returnedUrl = post.url ?? source.url;
  if (returnedUrl !== undefined && returnedUrl !== null && returnedUrl !== '') {
    if (typeof returnedUrl !== 'string') throw new Error('Provider returned an invalid LinkedIn post URL');
    actual = parseLinkedInReference(returnedUrl);
    const recorded = identifiers[actual.kind];
    if (recorded && recorded !== actual.urn) throw new Error('Provider post URL conflicts with its identifiers');
    identifiers[actual.kind] = actual.urn;
  } else warnings.push('Provider returned no post URL; the actual URL is unverified.');
  const known = Object.values(identifiers).filter((value): value is string => value !== null);
  if (known.length && !known.includes(requested.urn)) throw new Error('Provider returned a different post; its relationship to the requested post is unverified');
  if (!known.length) warnings.push('Provider returned no usable post identifier; its relationship to the requested post is unverified.');
  const body = text(post.text ?? source.text, 20000);
  if (!body.trim()) throw new Error('LinkedIn post text is unavailable (private, removed, login-walled or unsupported response); paste the source text instead');
  const comments: LinkedInCommentContext[] = [];
  let skipped = 0;
  const visit = (items: unknown[], parent: string | null = null, depth = 0) => {
    for (const value of items.slice(0, 100)) {
      if (comments.length >= limit) break;
      const row = object(value);
      if ('summary' in row) continue;
      const content = text(row.text ?? row.commentText ?? row.comment_text ?? row.comment, 2000);
      if (!content.trim()) { skipped++; continue; }
      const id = identifier(row.commentUrn ?? row.comment_urn ?? row.commentId ?? row.comment_id ?? row.id);
      const explicitPost = postUrn(row.postUrn ?? row.post_urn ?? row.post_input);
      const embedded = id ? COMMENT_URN.exec(id) : null;
      const embeddedPost = embedded ? `urn:li:${embedded[1]}:${embedded[2]}` : null;
      if (explicitPost && embeddedPost && explicitPost !== embeddedPost) { skipped++; continue; }
      const target = explicitPost ?? embeddedPost;
      if (target && ![requested.urn, ...known].includes(target)) { skipped++; continue; }
      const parentId = identifier(row.parentComment ?? row.parentCommentUrn ?? row.parent_comment_urn ?? row.parentCommentId ?? row.parent_comment_id ?? row.parentId ?? row.parent_id) ?? parent;
      const parentUrn = parentId ? COMMENT_URN.exec(parentId) : null;
      if (parentUrn && ![requested.urn, ...known].includes(`urn:li:${parentUrn[1]}:${parentUrn[2]}`)) { skipped++; continue; }
      let url: string | null = null;
      if (typeof (row.url ?? row.commentUrl) === 'string') {
        try {
          const ref = parseLinkedInReference(String(row.url ?? row.commentUrl));
          const linkedComment = ref.commentUrn ? COMMENT_URN.exec(ref.commentUrn) : null;
          const commentId = embedded?.[3] ?? id;
          if (linkedComment && commentId && linkedComment[3] !== commentId) {
            warnings.push('A comment URL was omitted because it identified a different comment.');
          } else if ([requested.urn, ...known].includes(ref.urn)) url = ref.url;
        } catch { /* Unverified URLs are omitted from quoted context. */ }
      }
      comments.push({ id, parentId, postUrn: target,
        text: content, author: text(object(row.author).name ?? row.authorName ?? row.author_name, 200), url,
        truncated: typeof (row.text ?? row.commentText ?? row.comment_text ?? row.comment) === 'string' && String(row.text ?? row.commentText ?? row.comment_text ?? row.comment).length > 2000 });
      if (Array.isArray(row.replies) && depth < 2) visit(row.replies, id, depth + 1);
    }
  };
  if (options.includeComments && Array.isArray(options.comments)) visit(options.comments);
  if (skipped) warnings.push(`${skipped} comment records were omitted because their text or post relationship was unavailable.`);
  if (comments.some(c => !c.id)) warnings.push('Some comments have no verified identifier; do not use them as reply targets.');
  const published = post.created_at ?? source.postedAtISO;
  return { untrusted: true, provider: 'apify', fetchedAt: options.fetchedAt, requestedUrl: requested.url, actualUrl: actual?.url ?? null,
    post: { text: body, author: { name: text(author.name ?? source.authorName, 200), headline: text(author.headline ?? source.authorHeadline, 500), url: profileUrl(author.profile_url ?? source.authorProfileUrl) }, identifiers,
      publishedAt: typeof published === 'string' && Number.isFinite(Date.parse(published)) ? new Date(published).toISOString() : null,
      metrics: { reactions: count(stats.total_reactions ?? source.numLikes), comments: count(stats.comments ?? source.numComments), shares: count(stats.shares ?? source.numShares) }, truncated: String(post.text ?? source.text).length > 20000 },
    comments, coverage: { requested: options.includeComments === true, returned: comments.length, limit, complete: false,
      reason: options.includeComments ? 'Bounded provider sample only; missing comments, replies and later pages are unknown.' : 'Comments were not requested.' }, warnings };
}

export interface ReadLinkedInOptions {
  url: string; provider: 'apify'; apiKey: string; includeComments?: boolean; maxComments?: number; timeoutMs?: number;
}
export interface LinkedInReaderDependencies { fetch?: typeof fetch; now?: () => Date }
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const size = Number(response.headers.get('content-length'));
  if (size > MAX_BYTES) { await response.body?.cancel(); throw new Error('Apify response exceeds the 512 KiB limit'); }
  if (!response.body) throw new Error('Apify returned an empty response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('Apify response reading was cancelled; no automatic retry was made.');
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch { throw new Error('Apify response body read failed; no automatic retry was made.'); }
      const { done, value } = chunk;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Apify response exceeds the 512 KiB limit');
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); } catch { throw new Error('Apify returned invalid JSON'); }
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Explicit own-key read. Actor POSTs can incur charges, including on timeout; never retry automatically. */
export async function readLinkedInContext(options: ReadLinkedInOptions, dependencies: LinkedInReaderDependencies = {}): Promise<LinkedInContext> {
  if (options.provider !== 'apify') throw new Error('Explicitly select Apify to read a LinkedIn URL, or paste its text');
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim() || options.apiKey.length > 1000 || /[\s\x00-\x1f\x7f]/.test(options.apiKey)) throw new Error('Provide your own Apify API key');
  if (options.includeComments !== undefined && typeof options.includeComments !== 'boolean') throw new Error('Choose explicitly whether to read comments');
  const requested = parseLinkedInReference(options.url), limit = commentLimit(options.maxComments);
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Reader timeout must be between 1 and 60,000 milliseconds');
  const fetcher = dependencies.fetch ?? globalThis.fetch, controller = new AbortController();
  const fetchedAt = () => (dependencies.now?.() ?? new Date()).toISOString();
  const timeoutMessage = 'Apify read timed out. The actor may have run and incurred a charge; no automatic retry was made.';
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(timeoutMessage)); }, timeoutMs); });
  const actor = async (id: string, payload: object): Promise<unknown[]> => {
    if (controller.signal.aborted) throw new Error(timeoutMessage);
    let response: Response;
    try {
      response = await fetcher(`https://api.apify.com/v2/acts/${id}/run-sync-get-dataset-items`, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    } catch { throw new Error(controller.signal.aborted ? timeoutMessage : 'Apify request failed. The actor may have run and incurred a charge; no automatic retry was made.'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Apify HTTP ${response.status}; no automatic retry was made. Check provider usage before retrying.`); }
    const data = await boundedJson(response, controller.signal);
    if (!Array.isArray(data)) throw new Error('Apify returned an unsupported dataset response');
    return data;
  };
  const run = async () => {
    const posts = await actor(POST_ACTOR, { post_urls: [requested.url] });
    if (posts.length !== 1) throw new Error('Apify did not return exactly one post; paste the source text instead');
    const base = { requestedUrl: requested.url, fetchedAt: fetchedAt(), provider: 'apify' as const, includeComments: options.includeComments, maxComments: limit };
    const context = normalizeLinkedInContext(posts[0], base);
    if (!options.includeComments) return context;
    try {
      // Do not expand every reply beneath the sample: that can exceed the requested paid read bound.
      const comments = await actor(COMMENTS_ACTOR, { postIds: [requested.urn], maxItems: limit, scrapeReplies: false });
      return normalizeLinkedInContext(posts[0], { ...base, fetchedAt: fetchedAt(), comments });
    } catch (error) {
      context.coverage.reason = 'Comment read failed; no comment coverage is available.';
      context.warnings.push(error instanceof Error ? error.message : 'Comment read failed; no automatic retry was made.');
      return context;
    }
  };
  try { return await Promise.race([run(), deadline]); }
  finally { clearTimeout(timer!); controller.abort(); }
}
