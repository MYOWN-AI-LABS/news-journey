import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { RenderProps } from "../../src/types";
import { resolveTheme, type VideoTheme } from "../theme";

type Seg = RenderProps["segments"][number];

export const NewsCard: React.FC<{ seg: Seg; accent: string; theme?: Partial<VideoTheme> | null }> = ({ seg, accent, theme: themeIn }) => {
  const theme = resolveTheme(themeIn);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 16 } });
  const snapshot = seg.sourceSnapshot;

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 70 }}>
      <div
        style={{
          width: "100%",
          maxWidth: 940,
          borderRadius: 36,
          overflow: "hidden",
          background: theme.surface,
          border: `2px solid ${theme.hair}`,
          boxShadow: theme.mode === "dark" ? "0 30px 80px #00000088" : "0 20px 60px #00000022",
          transform: `translateY(${interpolate(s, [0, 1], [80, 0])}px)`,
          opacity: s,
          marginBottom: 300,
        }}
      >
        {snapshot ? null : seg.assetFile ? (
          <Img
            src={staticFile(seg.assetFile)}
            style={{ width: "100%", height: 480, objectFit: "cover", display: "block" }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: 220,
              background: `linear-gradient(135deg, ${accent}55, ${accent}11)`,
            }}
          />
        )}
        <div style={{ padding: "44px 52px" }}>
          <div style={{ fontSize: 64, fontWeight: 850, color: theme.ink, lineHeight: 1.2, fontFamily: theme.headingFont }}>
            {seg.onScreen.title}
          </div>
          {seg.onScreen.stat ? (
            <div style={{ fontSize: 54, fontWeight: 800, color: accent, marginTop: 18 }}>{seg.onScreen.stat}</div>
          ) : null}
          {seg.onScreen.sub ? (
            <div style={{ fontSize: 36, color: theme.muted, marginTop: 14 }}>{seg.onScreen.sub}</div>
          ) : null}
          {snapshot ? <div style={{ marginTop: 40, paddingTop: 32, borderTop: `2px solid ${theme.hair}` }}>
            <div style={{ fontSize: 54, fontWeight: 750, color: theme.muted, marginBottom: 20 }}>Source headline · {snapshot.publisher}</div>
            <div data-source-snapshot="" style={{ fontSize: 54, color: theme.ink, lineHeight: 1.25 }}>{snapshot.caption}</div>
            {seg.motion?.status ? <div data-story-status="" style={{ fontSize: 54, color: theme.muted, lineHeight: 1.25, marginTop: 36 }}>{seg.motion.status}</div> : null}
          </div> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
