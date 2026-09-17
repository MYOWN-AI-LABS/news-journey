import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { RenderProps } from "../src/types";
import { Background } from "./components/Background";
import { Captions } from "./components/Captions";
import { TextBoundsGuard } from "./components/TextBoundsGuard";
import { Hook } from "./scenes/Hook";
import { NewsCard } from "./scenes/NewsCard";
import { RepoCard } from "./scenes/RepoCard";
import { StatChart } from "./scenes/StatChart";
import { CTA } from "./scenes/CTA";
import { Presenter } from "./scenes/Presenter";
import { StoryVisual } from "./scenes/StoryVisual";
import { overlayPlate, resolveTheme } from "./theme";

export const Short: React.FC<Record<string, unknown>> = (rawProps) => {
  const textRoot = React.useRef<HTMLDivElement>(null);
  const props = rawProps as unknown as RenderProps;
  const theme = resolveTheme(props.theme);
  const plate = overlayPlate(theme);
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const toFrame = (sec: number) => Math.max(0, Math.round(sec * fps));
  const progress = Math.min(1, (frame + 1) / Math.max(1, durationInFrames));

  const firstBodyStart = props.segments[0]?.startSec ?? props.durationSec * 0.2;
  const lastBodyEnd = props.segments[props.segments.length - 1]?.endSec ?? props.durationSec * 0.85;

  // Avatar mode: HeyGen/Hedra presenter video is present and mode is not "cards".
  const mode = props.avatarMode ?? "cards";
  const presenter = props.presenterVideo && mode !== "cards" ? props.presenterVideo : null;
  const fullAvatar = presenter && mode === "avatar";

  return (
    <AbsoluteFill ref={textRoot} style={{ fontFamily: theme.bodyFont, color: theme.ink }}>
      <TextBoundsGuard root={textRoot} />
      <Background accent={props.accent} theme={theme} variant={props.videoBackground} />

      {/* Full-screen presenter (avatar mode): the avatar IS the visual for the whole clip */}
      {fullAvatar ? <Presenter src={presenter!} mode="avatar" accent={props.accent} /> : null}

      {/* Advance the displayed hook and publication ident with their exact spoken sections. */}
      {props.prelude?.length ? props.prelude.map((part, index) => <Sequence key={`${part.kind}-${index}`} from={toFrame(part.startSec)} durationInFrames={Math.max(1, toFrame(part.endSec) - toFrame(part.startSec))}>
        <Hook text={part.text} accent={props.accent} theme={theme} />
      </Sequence>) : toFrame(firstBodyStart) > 0 ? <Sequence durationInFrames={toFrame(firstBodyStart)}>
        <Hook text={props.hook} accent={props.accent} theme={theme} />
      </Sequence> : null}

      {/* Body card scenes — shown in cards/hybrid; in full-avatar mode the avatar replaces them */}
      {!fullAvatar &&
        props.segments.map((seg, i) => {
          const from = toFrame(seg.startSec);
          const dur = Math.max(toFrame(seg.endSec) - from, fps);
          // A story that carries an authored diagram is DRAWN, not carded: the diagram is the whole
          // point of the segment, and it is the identical artwork the newsletter shows. Segments
          // without one (no motion brief, or authoring produced nothing) keep their card scene, so
          // this can never leave a story with no visual at all.
          const scene = seg.sourceSnapshot ? (
            <NewsCard seg={seg} accent={props.accent} theme={theme} />
          ) : seg.diagram?.svg || seg.diagram?.visual?.kind === "source" || seg.diagram?.visual?.kind === "three" ? (
            <StoryVisual seg={seg} accent={props.accent} index={i} total={props.segments.length} theme={theme}/>
          ) : seg.scene === "repo_card" ? (
            <RepoCard seg={seg} repo={seg.repo ?? props.repo ?? null} accent={props.accent} />
          ) : seg.scene === "stat_chart" ? (
            <StatChart seg={seg} stars={props.stars} accent={props.accent} />
          ) : (
            <NewsCard seg={seg} accent={props.accent} theme={theme} />
          );
          return (
            <Sequence key={i} from={from} durationInFrames={dur}>
              {scene}
            </Sequence>
          );
        })}

      {/* Hybrid mode: generated avatar inset (top-right), lip-synced. If avatarIntroSec is set it
          shows from 0 for that many seconds then DISAPPEARS (short, cheap "opening" avatar);
          otherwise it spans the whole body. */}
      {presenter && mode === "hybrid" ? (
        <Sequence
          from={props.avatarIntroSec ? 0 : toFrame(firstBodyStart)}
          durationInFrames={props.avatarIntroSec ? toFrame(props.avatarIntroSec) : toFrame(lastBodyEnd) - toFrame(firstBodyStart)}
        >
          <Presenter
            src={presenter}
            mode="hybrid"
            scale={props.presenterScale}
            corner={props.presenterCorner}
            accent={props.accent}
            startFrom={props.avatarIntroSec ? 0 : toFrame(firstBodyStart)}
          />
        </Sequence>
      ) : null}

      {/* CTA: from end of last body segment to the end */}
      <Sequence from={toFrame(lastBodyEnd)} durationInFrames={durationInFrames - toFrame(lastBodyEnd)}>
        <CTA text={props.cta} accent={props.accent} newsletterLine={props.newsletterLine} logoFile={props.logoFile} theme={theme} />
      </Sequence>

      {/* Karaoke captions only during body scenes — hook and CTA already show their own text */}
      <Sequence from={toFrame(firstBodyStart)} durationInFrames={toFrame(lastBodyEnd) - toFrame(firstBodyStart)}>
        <Captions words={props.words} accent={props.accent} offsetSec={firstBodyStart} theme={theme} variant={props.captionStyle} />
      </Sequence>

      {/* Presenter formats: the speaking member's name and role, exactly for the span their approved voice rendered */}
      {(props.speakers ?? []).map((s, i) => (
        <Sequence key={`speaker-${i}`} from={toFrame(s.startSec)} durationInFrames={Math.max(1, toFrame(s.endSec) - toFrame(s.startSec))}>
          <div style={{ position: "absolute", left: 48, top: 120, padding: "14px 22px", borderRadius: 999, background: plate.background, border: `2px solid ${props.accent}`, color: plate.ink, fontSize: 30, fontWeight: 700, letterSpacing: "0.02em" }}>
            {s.name} <span style={{ color: "#B8B8C8", fontWeight: 500 }}>· {s.role}</span>
          </div>
        </Sequence>
      ))}

      {props.audioFile ? <Audio src={staticFile(props.audioFile)} /> : null}

      {/* Always-on short-form progress cue, timed from the composition rather than scene/audio guesses. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: 8,
          background: "#FFFFFF22",
          zIndex: 1000,
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            background: props.accent,
            boxShadow: `0 0 18px ${props.accent}`,
            transform: `scaleX(${progress})`,
            transformOrigin: "left center",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
