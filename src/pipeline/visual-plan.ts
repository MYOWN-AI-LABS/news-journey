import type { VisualTiming } from "./visual-timing.js";
import type { FieldReview } from './field-support.js';

export const VISUAL_PLAN_VERSION = 1;
export type Mechanism3D = "assembly" | "data-flow" | "compression" | "robot-control";
export interface SelectedVisualImage { index: number; candidateId: 'image' | 'own-image'; file: string; sha256: string; sourceUrl: string }
/** The selected capture failed before or during its source/pixel review. */
export class SelectedVisualImageReviewError extends Error {
  constructor(public readonly index: number, reason: string) {
    super(reason); this.name = 'SelectedVisualImageReviewError';
  }
}
export interface VisualPlan {
  version: 1;
  kind: "diagram" | "source" | "three";
  intent: string;
  reason: string;
  /** 3D is a labeled schematic, never an invented photograph of a branded device. */
  mechanism?: Mechanism3D;
  labels: string[];
  cues: string[];
  caveat: string;
  sourceUrl: string;
  /** Exact independently reviewed concept consumed before final narration/cue review. */
  sourceConceptHash?: string;
  /** The concept's narrative was retained while actual captured media changed representation.
   * The image/clip relevance receipt separately records the actual capture inspection. */
  conceptAdaptation?: { version: 1; kind: 'source-capture'; sourceConceptHash: string };
  /** Source-account narration keeps the complete concept as reviewed context. Its diagram/3D
   * artwork is unused; this receipt neither records rendering nor grants a pixel-review pass. */
  sourceAccountAdaptation?: { version: 1; kind: 'attributed-text-card'; sourceConceptHash: string;
    sourcePacketHash: string; sourceEvidenceHash: string; narrationHash: string; scriptHash: string;
    review: FieldReview; conceptArtworkRendered: false; pixelReview: 'not-performed' };
  /** Authoritative input to the independent frame reviewer, copied from the pinned story. */
  evidence?: { narration: string; mechanism: string; claims: unknown[] };
  image?: { file: string; sha256: string; sourceUrl: string; kind: "repo-screenshot" | "source-image"; relevance?: {sha256:string;reason:string;verifiedAt:string}; dataUri?: string };
  clip?: {file:string;sha256:string;sourceUrl:string;pageUrl:string;originalSha256:string;duration:number;startSec:number;frames:{file:string;sec:number;sha256:string}[];relevance?:{sha256:string;reason:string;verifiedAt:string};dataUri?:string};
  timing?: VisualTiming;
  narration?: {startSec:number; timing:VisualTiming};
  decision: "model" | "fallback";
  warning?: string;
  /** Self-contained derivatives; checksums bind the published bytes to this decision. */
  /** `review.unreviewed` marks a plain source photo attached by a text-only writer: no phone critic ran, `passed` is false, and
   * the reason says so; the rights gate still stops publishing. Never a review pass. */
  media?: { mp4: string; gif: string; poster: string; hash: string; sha256: Record<"mp4" | "gif" | "poster", string>; review: {passed:boolean;hash:string;reason:string;at:string;unreviewed?:true} };
}
