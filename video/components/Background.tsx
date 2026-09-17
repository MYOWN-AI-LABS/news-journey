import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { resolveTheme, type VideoTheme } from "../theme";

/** Distinct backgrounds built from the customer's own color and theme. */
export const Background: React.FC<{ accent: string; theme?: Partial<VideoTheme> | null; variant?: "brand" | "studio" | "newsroom" }> = ({ accent, theme: themeIn, variant = "brand" }) => {
  const theme = resolveTheme(themeIn);
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 1800], [0, 120]);
  const alpha = theme.mode === "dark" ? "66" : "4D";
  if (variant === "studio") {
    return <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 20%, ${theme.bg} 0%, ${theme.hair} 100%)` }} />;
  }
  if (variant === "newsroom") {
    return (
      <AbsoluteFill style={{ background: theme.bg }}>
        <div style={{ position: "absolute", inset: 0, background: `linear-gradient(125deg, ${theme.surface} 0% 35%, ${accent}${theme.mode === 'dark' ? '40' : '24'} 35% 68%, ${theme.bg} 68%)` }} />
        <div style={{ position: "absolute", inset: "80px 64px", border: `2px solid ${theme.hair}`, borderLeft: `16px solid ${accent}80`, borderRadius: 12 }} />
        <div style={{ position: "absolute", left: 64, right: 64, top: 180 + drift / 5, height: 6, background: `${accent}80` }} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ background: theme.bg }}>
      <div style={{ position: "absolute", width: 1800, height: 1800, borderRadius: "50%", background: `radial-gradient(circle, ${accent}${alpha} 0%, transparent 70%)`, top: -600 + drift, left: -450, filter: "blur(30px)" }} />
    </AbsoluteFill>
  );
};
