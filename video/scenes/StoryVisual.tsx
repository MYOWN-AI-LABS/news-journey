import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { RenderProps } from "../../src/types";
import { SCHEMATIC_CSS } from "../../src/pipeline/story-schematic";
import { DIAGRAM_CSS, ROUGH_FILTER_DEFS, withMotionPackets } from "../../src/pipeline/diagram-style";
import { visualBeat } from "../../src/pipeline/visual-timing";
import { StoryVisualArt } from "./StoryVisualArt";
import { resolveTheme, type VideoTheme } from "../theme";

/** A stable portrait stage leaves independent lanes for the headline, art, captions and caveat. */
export const StoryVisual: React.FC<{ seg: RenderProps["segments"][number]; accent: string; index: number; total: number; theme?: Partial<VideoTheme> | null }> = ({seg, accent, index, total, theme: themeIn}) => {
  const theme = resolveTheme(themeIn);
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const plan = seg.diagram?.visual;
  const timing = seg.visualTiming;
  const beat = timing ? visualBeat(frame / fps, timing) : -1;
  const active = !timing || timing.method === "unmatched" ? "hold" : String(beat + 1);
  const rgb = accent.replace("#", "").match(/.{2}/g)?.map(h => parseInt(h, 16)).join(",");
  return <AbsoluteFill style={{background:theme.bg,color:theme.ink,overflow:"hidden",fontFamily:theme.bodyFont}}>
    <div style={{position:"absolute",top:40,left:64,color:accent,fontSize:44}}>{index + 1} / {total}</div>
    <div style={{position:"absolute",top:100,left:64,right:64,fontSize:60,fontWeight:800,lineHeight:1.08,fontFamily:theme.headingFont}}>{seg.onScreen.title}</div>
    <div style={{position:"absolute",top:260,left:133,width:814,height:1050}}>
      {plan && plan.kind !== "diagram"
        ? <StoryVisualArt plan={plan} accent={accent} timing={timing} width={814} height={1050} theme={theme}/>
        : <div className="tm-stage" data-diagram-style={seg.diagramStyle ?? "studio"} data-tm-frozen="" data-tm-active={active}
          style={{["--accent" as string]:accent,["--accentRgb" as string]:rgb,["--tm-clock" as string]:`-${frame / fps}s`,width:"100%",height:"100%",display:"grid",alignItems:"center",boxSizing:"border-box",background:"#151c26",borderRadius:20,padding:20}}>
          <style>{SCHEMATIC_CSS + DIAGRAM_CSS + ".tm-story-svg{width:100%;height:100%;display:block}.tm-stage>div:last-child{height:100%;min-height:0}"}</style>
          <div style={{position:"absolute",width:0,height:0}} dangerouslySetInnerHTML={{__html:ROUGH_FILTER_DEFS}}/>
          <div dangerouslySetInnerHTML={{__html:withMotionPackets(seg.diagram?.svg ?? "")}}/>
        </div>}
    </div>
    <div data-story-status="" style={{position:"absolute",left:64,right:64,top:1335,height:220,fontSize:46,lineHeight:1.12,color:theme.muted}}>{seg.motion?.status}</div>
  </AbsoluteFill>;
};
