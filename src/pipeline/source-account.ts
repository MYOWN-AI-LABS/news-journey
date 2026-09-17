import { createHash } from 'node:crypto';
import type { ScriptSegment, TopicStory } from '../types.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Segment = Pick<ScriptSegment, 'onScreen' | 'motion' | 'sourceAccount'> & Partial<Pick<ScriptSegment, 'voiceover' | 'assetRef' | 'scene'>>;

/** This presentation is permitted only for an unchanged, complete source packet. A model-written
 * marker cannot exempt an ordinary prose script from its existing mechanism or evidence checks. */
export function sourceAccountProblem(segment: Segment, story?: TopicStory): string | null {
  const account = segment.sourceAccount;
  if (!account || account.version !== 1 || !story) return 'source account needs its exact selected story';
  if (segment.motion || segment.scene !== 'news_card') return 'source account requires a text card without an inferred mechanism';
  const claims = story.verifiedClaims;
  if (!Array.isArray(claims) || !claims.length || claims.length > 24 || claims.some(claim => typeof claim !== 'string' || claim !== claim.trim() || claim.length < 12 || claim.length > 1500 || /[<>\x00-\x1f]|https?:\/\/|www\./i.test(claim) || !/[.!?]["'’”)]*$/.test(claim))) return 'source account needs complete, plain pinned claims';
  if (new Set(claims.map(claim => claim.toLowerCase())).size !== claims.length || claims.join(' ').length > 6000) return 'source account packet is repeated or oversized';
  const evidence = story.claimEvidence;
  if (!evidence?.some(row => row.url === story.primaryUrl && row.role === 'primary' && row.status === 200 && /^[a-f0-9]{64}$/.test(row.sha256 ?? '') && Number.isFinite(Date.parse(row.observedAt)))) return 'source account needs a captured primary source identity';
  try { const url = new URL(story.primaryUrl); if (url.protocol !== 'https:' || url.username || url.password) return 'source account needs a public HTTPS source'; } catch { return 'source account needs a valid source URL'; }
  if (account.sourceUrl !== story.primaryUrl || segment.assetRef !== story.assetRef || JSON.stringify(account.claims) !== JSON.stringify(claims) || account.packetHash !== hash(claims) || account.evidenceHash !== hash(evidence)) return 'source account differs from the selected source packet';
  if (segment.voiceover !== claims.join(' ')) return 'source account narration must preserve every complete claim and qualifier';
  const title = segment.onScreen.title;
  const approved = title === story.headline || title === `Story ${story.n}`;
  if (!approved || title.length > 90 || title.trim().split(/\s+/).length > 8 || /[<>\x00-\x1f]/.test(title)) return 'source account title must be the complete short source headline or neutral story number';
  return null;
}
