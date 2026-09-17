import React from "react";
import { ThreeCanvas } from "@remotion/three";
import { Img, Video, Freeze, useCurrentFrame, useVideoConfig } from "remotion";
import { TextBoundsGuard } from "../components/TextBoundsGuard";
import type { VisualPlan } from "../../src/pipeline/visual-plan";
import { beatProgress, readingTiming, visualBeat, type VisualTiming } from "../../src/pipeline/visual-timing";
import { resolveTheme, type VideoTheme } from "../theme";

const Block: React.FC<{ position?: [number, number, number]; size: [number, number, number]; color: string }> = ({ position, size, color }) => <mesh position={position}><boxGeometry args={size}/><meshStandardMaterial color={color} roughness={.45} metalness={.25}/></mesh>;

/** Actual geometry; labels remain in the screen plane so camera perspective cannot distort them. */
const Mechanism: React.FC<{ plan: VisualPlan; progress: number; accent: string }> = ({ plan, progress, accent }) => {
  const partColors = ["#50aa9b", "#84b8f0", accent, "#d0dce4"];
  if (plan.mechanism === "assembly") return <group position={[0,-.9,0]}>
    <Block size={[4.4,.18,3]} color={partColors[0]}/>
    <group position={[0,.25+progress*.65,0]}>
      {[-1,1].map(side => <group key={side} position={[side*1.4,0,0]}>
        <Block size={[.48,.12,2.3]} color={partColors[1]}/>
        {[-.7,0,.7].map(z=><Block key={z} position={[0,.12,z]} size={[.35,.13,.4]} color="#273547"/>)}
      </group>)}
    </group>
    <group position={[0,.5+progress*1.25,0]}>
      <Block size={[1.8,.15,1.8]} color="#a9b7c6"/>
      <Block position={[0,.18,0]} size={[1.25,.25,1.25]} color={partColors[2]}/>
    </group>
    <group position={[0,.9+progress*2,0]}>
      <Block size={[2.5,.16,2.2]} color={partColors[3]}/>
      {Array.from({length:8},(_,i)=><Block key={i} position={[(i-3.5)*.29,.3,0]} size={[.09,.55,2.2]} color={partColors[3]}/>)}
    </group>
  </group>;
  if (plan.mechanism === "compression") return <group rotation={[0,-.2,0]}>
    {Array.from({length:4},(_,layer)=><group key={layer} position={[(layer-1.5)*(.8-progress*.23),0,0]}>
      {Array.from({length:9},(_,cell)=><Block key={cell} position={[0,Math.floor(cell/3)*.55-.5,(cell%3)*.55-.5]} size={[.42,.42,.42]} color={layer===3?accent:layer%2?"#779bad":"#d0dce4"}/>)}
    </group>)}
  </group>;
  if (plan.mechanism === "robot-control") return <group position={[0,-1,0]}>
    <Block size={[2.4,.25,2.1]} color="#405368"/>
    <mesh position={[0,.4,0]}><cylinderGeometry args={[.32,.45,.7,24]}/><meshStandardMaterial color={accent}/></mesh>
    <group position={[0,.7,0]} rotation={[0,0,-.45+progress*.75]}>
      <Block position={[0,.8,0]} size={[.36,1.6,.36]} color="#d0dce4"/>
      <mesh position={[0,1.6,0]}><sphereGeometry args={[.26,20,20]}/><meshStandardMaterial color={accent}/></mesh>
      <group position={[0,1.6,0]} rotation={[0,0,-.9+progress*.35]}>
        <Block position={[0,.65,0]} size={[.28,1.3,.28]} color="#91aebf"/>
        <Block position={[0,1.35,0]} size={[.65,.22,.4]} color={accent}/>
      </group>
    </group>
    <Block position={[1.8,.3,-.7]} size={[.6,.6,.6]} color="#b8afdc"/>
  </group>;
  return <group>
    {plan.labels.map((_, i) => <group key={i} position={[(i-(plan.labels.length-1)/2)*1.55, i%2*.55, 0]}>
      <Block size={[1,.9,.85]} color={i===plan.labels.length-1?accent:"#758da4"}/>
      {i<plan.labels.length-1?<Block position={[.78,0,0]} size={[.55,.06,.06]} color="#b8c3d2"/>:null}
    </group>)}
    <mesh position={[(progress-.5)*(plan.labels.length-1)*1.55,.65,0]}><sphereGeometry args={[.16,20,20]}/><meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={.5}/></mesh>
  </group>;
};

export const StoryVisualArt: React.FC<{ plan: VisualPlan; accent: string; timing?: VisualTiming; complete?: boolean; width?: number; height?: number; newsletter?: boolean; theme?: Partial<VideoTheme> | null }> = ({ plan, accent, timing, complete=false, width=720, height=1000, newsletter=false, theme: themeIn }) => {
  const frame=useCurrentFrame(), {fps}=useVideoConfig();
  const theme=resolveTheme(themeIn);
  const labelFont = newsletter ? 32 : 48, headerHeight = newsletter ? 54 : 74, rowHeight = newsletter ? 44 : 62;
  // A photograph needs no numbered label rows: the image, its source and the caption say everything.
  const plainImage=plan.kind==="source" && Boolean(plan.image) && !plan.clip;
  const labels=plainImage?[]:plan.labels;
  const clock=timing ?? plan.timing ?? readingTiming(plan.labels.length);
  const t=frame/fps, active=complete?-1:visualBeat(t,clock), progress=complete?1:beatProgress(t,clock);
  const scale=width/720;
  const reviewedEnd = plan.clip?.frames.at(-1)?.sec ?? plan.clip?.duration ?? 0;
  const clipEnd = plan.clip && reviewedEnd > plan.clip.startSec ? reviewedEnd : plan.clip?.duration ?? 0;
  const holdFrame = Math.max(0, Math.floor((clipEnd - (plan.clip?.startSec ?? 0)) * fps) - 2);
  // Native text measurement reserves actual row/caveat height before placing the 3D canvas.
  const layout=React.useMemo(()=>{
    const ctx=typeof document==='undefined'?null:document.createElement("canvas").getContext("2d");
    const lines=(text:string,max:number,weight:number)=>{
      if(ctx)ctx.font=`${weight} ${labelFont}px ${theme.bodyFont}`;
      const measure=(s:string)=>ctx?ctx.measureText(s).width:s.length*32;
      let count=1,line="";
      for(const word of text.split(/\s+/)){
        if(line && measure(line+" "+word)>max){count++;line="";}
        line+=(line?" ":"")+word;
        if(measure(line)>max){count+=Math.ceil(measure(line)/max)-1;line="";}
      }
      return count;
    };
    const caveat=plan.caveat || (plan.kind==="three"?"Schematic · not to scale":"Source capture · explanatory labels");
    const labelHeight=labels.reduce((sum,label)=>sum+Math.max(rowHeight,lines(label,570,650)*labelFont*1.08+16),0)+10*Math.max(0,labels.length-1);
    const caveatHeight=lines(caveat,664,400)*labelFont*1.12;
    return {artHeight:Math.max(160,(newsletter?height/scale:1000)-headerHeight-labelHeight-caveatHeight-48),labelHeight};
  },[labels,plan.caveat,plan.kind,newsletter,height,scale,labelFont,headerHeight,rowHeight,theme.bodyFont]);
  return <div data-visual-kind={plan.kind} style={{width,height,position:"relative",background:theme.surface,overflow:"hidden",fontFamily:theme.bodyFont,color:theme.ink}}>
    <div style={{position:"absolute",left:28*scale,top:24*scale,right:28*scale,fontSize:(newsletter?20:26)*scale,color:theme.muted,letterSpacing:1}}>{plan.kind==="three"?"3D EXPLANATION · SCHEMATIC":`SOURCE · ${new URL(plan.clip?.pageUrl ?? plan.image?.sourceUrl ?? plan.sourceUrl).hostname.replace(/^www\./,"")}`}</div>
    <div style={{position:"absolute",left:0,top:headerHeight*scale,width,height:layout.artHeight*scale}}>
      {plan.kind==="source" ? (plan.clip?.dataUri ? <Freeze frame={Math.min(frame,holdFrame)}><Video src={plan.clip.dataUri} startFrom={Math.round(plan.clip.startSec*fps)} muted style={{width:"100%",height:"100%",objectFit:"contain",padding:24*scale,boxSizing:"border-box"}}/></Freeze> : plan.image?.dataUri ? <Img src={plan.image.dataUri} style={{width:"100%",height:"100%",objectFit:"contain",padding:24*scale,boxSizing:"border-box",transform:`scale(${1 + progress*.025})`}}/> : <div>Source image unavailable</div>) : <ThreeCanvas width={Math.round(width)} height={Math.round(layout.artHeight*scale)} camera={{position:[5,4,8],fov:38,near:.1,far:60}} gl={{antialias:true,alpha:true}}>
        <ambientLight intensity={1.3}/><directionalLight position={[4,8,5]} intensity={3}/><directionalLight position={[-5,3,-2]} intensity={1.2} color="#bacaf2"/>
        <Mechanism plan={plan} progress={progress} accent={accent}/>
      </ThreeCanvas>}
    </div>
    <div style={{position:"absolute",left:28*scale,right:28*scale,top:(headerHeight+16+layout.artHeight)*scale,display:"grid",gap:10*scale}}>
      {labels.map((label,i)=><div key={i} style={{minHeight:rowHeight*scale,boxSizing:"border-box",display:"flex",alignItems:"center",gap:20*scale,borderLeft:`${4*scale}px solid ${active===i?accent:theme.hair}`,background:active===i?theme.bg:"transparent",padding:`${8*scale}px ${16*scale}px`}}><span style={{fontSize:26*scale,color:active===i?accent:theme.muted}}>{String(i+1).padStart(2,"0")}</span><span style={{fontSize:labelFont*scale,lineHeight:1.08,fontWeight:650,overflowWrap:"normal",wordBreak:"normal",hyphens:"none",minWidth:0}}>{label}</span></div>)}
    </div>
    <div style={{position:"absolute",left:28*scale,right:28*scale,bottom:18*scale,fontSize:(newsletter?32:plainImage?36:48)*scale,lineHeight:1.12,color:theme.muted}}>{plan.caveat || (plan.kind==="three"?"Schematic · not to scale":"Source capture · explanatory labels")}</div>
  </div>;
};

export const StoryVisualPreview: React.FC<{plan:VisualPlan;accent:string;posterFirst?:boolean;theme?:Partial<VideoTheme>|null}> = ({plan,accent,posterFirst=true,theme}) => {
  const frame=useCurrentFrame();
  const {width,height}=useVideoConfig();
  const textRoot=React.useRef<HTMLDivElement>(null);
  return <div ref={textRoot} style={{width,height}}><TextBoundsGuard root={textRoot}/><StoryVisualArt plan={plan} accent={accent} width={width} height={height} complete={posterFirst&&frame===0} theme={theme} newsletter/></div>;
};
