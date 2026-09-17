import type { HarvestItem } from '../types.js';

export const SELECTION_POLICY_ID = 'operator-ranking-v1';
export type RankingMode = 'manual' | 'newest' | 'priorities';
export interface RankingConfig {
  mode?: RankingMode;
  priorities?: { keyword: string; weight: number }[];
  sourceWeights?: Record<string, number>;
}
export function validateRankingConfig(value: unknown): RankingConfig {
  if (value === undefined || value === null) return { mode: 'manual' };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a ranking mode');
  const v = value as RankingConfig;
  const mode = v.mode ?? 'manual';
  if (!['manual', 'newest', 'priorities'].includes(mode)) throw new Error('Ranking must be manual, newest or priorities');
  const priorities = v.priorities ?? [];
  if (!Array.isArray(priorities) || priorities.length > 40 || priorities.some(p => !p || typeof p.keyword !== 'string' || !p.keyword.trim() || p.keyword.length > 200 || !Number.isFinite(p.weight) || p.weight <= 0 || p.weight > 100)) throw new Error('Each priority needs a keyword and a weight from 0 to 100, greater than zero');
  const weights = v.sourceWeights ?? {};
  if (typeof weights !== 'object' || Array.isArray(weights) || Object.keys(weights).length > 40 || Object.entries(weights).some(([k,w]) => !k.trim() || k.length > 200 || !Number.isFinite(w) || w < 0 || w > 100)) throw new Error('Source weights must be numbers from 0 to 100 keyed by source ID');
  if (mode === 'priorities' && !priorities.length && !Object.keys(weights).length) throw new Error('Add your ranking priorities before choosing priority order');
  return { mode, priorities: priorities.map(p => ({keyword:p.keyword.trim(),weight:p.weight})), sourceWeights: {...weights} };
}
export interface RankedCandidate {
  id: string; source: string; title: string; url: string; summary: string; publishedAt?: string | null;
  channel: string; rawScore: number; rawMetric: string; channelScore: number; score: number;
  velocity: null; velocityPlatform: null;
}
export type ScoredCandidate = RankedCandidate & { credibility?: string; outletsCovering?: number | null; heatEvidence?: string[]; scoreBreakdown?: {heat:number;provenance:number;freshness:number;channelRank:number} };
/** No source popularity or inherited preference contributes to this ordering. Ties retain intake order. */
export function rankCandidates(fresh: HarvestItem[], config: RankingConfig = {}, keep = 80): RankedCandidate[] {
  const cfg = validateRankingConfig(config);
  const priority = (it: HarvestItem) => {
    const words = `${it.title} ${it.summary}`.toLocaleLowerCase();
    return (cfg.priorities ?? []).reduce((n,p) => n + (words.includes(p.keyword.toLocaleLowerCase()) ? p.weight : 0), 0) + (Object.hasOwn(cfg.sourceWeights ?? {},it.source) ? cfg.sourceWeights![it.source] : 0);
  };
  return fresh.map((it,index) => {
    const parsed = it.publishedAt ? Date.parse(it.publishedAt) : NaN;
    const score = cfg.mode === 'priorities' ? priority(it) : cfg.mode === 'newest' && Number.isFinite(parsed) ? parsed : 0;
    return {index,value:{id:it.id,source:it.source,title:it.title,url:it.url,summary:it.summary,publishedAt:it.publishedAt,channel:'operator',rawScore:score,rawMetric:cfg.mode!,channelScore:score,score,velocity:null,velocityPlatform:null} satisfies RankedCandidate};
  }).sort((a,b) => cfg.mode === 'manual' ? a.index-b.index : b.value.score-a.value.score || a.index-b.index).slice(0,keep).map(p=>p.value);
}
export function assembleSlate<T extends {primaryUrl:string}>(recommended:T[],alternates:T[],count:number,min:number,max:number):{slate:T[];spare:T[]} {
  const target=Math.min(max,Math.max(min,count)), slate:T[]=[],spare:T[]=[];const seen=new Set<string>();
  for(const s of [...recommended,...alternates]) { if(seen.has(s.primaryUrl))continue; seen.add(s.primaryUrl);(slate.length<target?slate:spare).push(s); }
  if(slate.length<min)throw new Error(`Only ${slate.length} stories have readable sources after back-filling; ${min} required. Add sources or choose another topic.`);
  return {slate,spare};
}
export type PickedCandidate={role:'recommended'|'alternate'|'replacement';order:number;verification:{kept:boolean;reason?:string}|null};
export interface SelectionReportRow {
  candidateOrder:number;candidateId:string;headline:string;primaryUrl:string;source:string;channel:string;rawScore:number;rawMetric:string;channelScore:number;compositeScore:number|null;scoreBreakdown:ScoredCandidate["scoreBreakdown"]|null;outletsCovering:number|null;credibility:string|null;heatEvidence:string[];publishedAt:string|null;role:PickedCandidate['role']|null;selectedOrder:number|null;verification:PickedCandidate['verification'];
}
export function selectionReportRows(candidates:ScoredCandidate[],picked:Map<string,PickedCandidate>):SelectionReportRow[] {
  return candidates.map((c,i)=>({candidateOrder:i+1,candidateId:c.id,headline:c.title,primaryUrl:c.url,source:c.source,channel:c.channel,rawScore:c.rawScore,rawMetric:c.rawMetric,channelScore:c.channelScore,compositeScore:null,scoreBreakdown:null,outletsCovering:null,credibility:null,heatEvidence:[],publishedAt:c.publishedAt??null,role:picked.get(c.id)?.role??null,selectedOrder:picked.get(c.id)?.order??null,verification:picked.get(c.id)?.verification??null}));
}

/** UI input is explicit keyword | weight per line; it never creates implicit preferences. */
export function rankingFromInput(data: Record<string, unknown>, prior?: RankingConfig): RankingConfig {
  if (data.rankingMode === undefined) return validateRankingConfig(prior);
  const text = data.rankingPriorities ?? '';
  if (typeof text !== 'string' || text.length > 10_000) throw new Error('Ranking priorities must be text');
  const priorities = text.split(/\r?\n/).filter(s=>s.trim()).map(line=> {
    const parts=line.split('|');
    if(parts.length!==2)throw new Error('Write each priority as keyword | weight');
    return {keyword:parts[0].trim(),weight:Number(parts[1].trim())};
  });
  return validateRankingConfig({mode:data.rankingMode,priorities,sourceWeights:prior?.sourceWeights});
}
