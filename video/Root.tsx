import React from "react";
import { Composition } from "remotion";
import { Short } from "./Short";
import { Captions } from "./components/Captions";
import { StoryDiagram3D } from "./scenes/StoryDiagram3D";
import { StoryVisualPreview } from "./scenes/StoryVisualArt";
import { SAMPLE_DIAGRAM_SVG, SAMPLE_ACCENT } from "./scenes/__diagram-sample";
import type { RenderProps } from "../src/types";

const FPS = 30;
const CaptionStylePreview: React.FC<{ variant: 'clean' | 'boxed' | 'pill' | 'glow'; accent: string }> = ({ variant, accent }) => (
  <div style={{ width: '100%', height: '100%', background: '#E8EDF3' }}>
    <Captions accent={accent} variant={variant} words={['Clear', 'ideas', 'worth', 'sharing'].map((w, i) => ({ w, start: i * .5, end: (i + 1) * .5 }))} />
  </div>
);
const defaultProps: RenderProps = {
  headline: "Example briefing",
  hook: "A sourced update worth understanding",
  cta: "Review the sources before publishing.",
  segments: [{ voiceover: "Example narration for local preview.", scene: "news_card", onScreen: { title: "Example card", sub: "example.com" }, startSec: 0, endSec: 4, assetFile: null }],
  words: [{ w: "Example", start: 0, end: 0.5 }],
  durationSec: 4, audioFile: "", accent: "#008C86", repo: null, presenterVideo: null, avatarMode: "cards"
};

/**
 * Full-frame wrapper so the 3D story diagram can be rendered and inspected on its own.
 *
 * Registering it as its own composition means `npm run studio` can open the diagram scene directly
 * — without producing an edition first — which is how a diagram regression gets caught before it
 * reaches a published issue.
 */
const Diagram3DPreview: React.FC<{ svg: string; accent: string }> = ({ svg, accent }) => (
  <div style={{ width: "100%", height: "100%", background: "#0A0E18" }}>
    <StoryDiagram3D svg={svg} accent={accent} width={1080} height={1920} />
  </div>
);

export const Root: React.FC = () => (
  <>
    <Composition id="CaptionStyle" component={CaptionStylePreview} width={1080} height={400} fps={FPS} durationInFrames={60} defaultProps={{ variant: 'clean', accent: '#1F4E79' }} />
    <Composition id="StoryVisual" component={StoryVisualPreview} width={720} height={560} fps={10} durationInFrames={60}
      defaultProps={{plan:{version:1,kind:"three",mechanism:"assembly",intent:"Illustrative assembly",reason:"Explain component placement",labels:["Board","Memory","Compute","Cooling"],cues:[],caveat:"Schematic · not to scale",sourceUrl:"",decision:"fallback"},accent:SAMPLE_ACCENT}}/>
    <Composition id="Short" component={Short} width={1080} height={1920} fps={FPS} durationInFrames={Math.ceil(5 * FPS)} defaultProps={defaultProps as unknown as Record<string, unknown>} calculateMetadata={({ props }) => { const p = props as unknown as RenderProps; return { durationInFrames: Math.ceil((p.durationSec + 1) * FPS) }; }} />
    <Composition
      id="Diagram3D"
      component={Diagram3DPreview}
      width={1080}
      height={1920}
      fps={FPS}
      durationInFrames={Math.ceil(10 * FPS)}
      defaultProps={{ svg: SAMPLE_DIAGRAM_SVG, accent: SAMPLE_ACCENT }}
    />
  </>
);
