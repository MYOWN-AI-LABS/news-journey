import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { resolveTheme, type VideoTheme } from "../theme";

export const CTA: React.FC<{ text: string; accent: string; newsletterLine?: string; logoFile?: string | null; theme?: Partial<VideoTheme> | null }> = ({ text, accent, newsletterLine, logoFile, theme: themeIn }) => {
  const theme = resolveTheme(themeIn);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const promiseIn = spring({ frame, fps, config: { damping: 14, stiffness: 180, mass: 0.7 } });
  const pillIn = spring({ frame: frame - 4, fps, config: { damping: 9, stiffness: 240, mass: 0.55 } });
  const arrowIn = spring({ frame: frame - 9, fps, config: { damping: 12, stiffness: 210, mass: 0.5 } });
  const detailIn = spring({ frame: frame - 12, fps, config: { damping: 15 } });
  const promise = text.trim() || "Your sourced briefing";
  const promiseFontSize = Math.max(30, Math.min(62, 1650 / promise.length));

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 80 }}>
      <div
        style={{
          textAlign: "center",
          width: "100%",
          maxWidth: 920,
          transform: "translateY(-130px)",
        }}
      >
        {logoFile ? (
          // The customer's own logo, copied into this package's directory — never another workspace's file.
          <Img src={staticFile(logoFile)} style={{ display: "block", maxHeight: 120, maxWidth: 420, margin: "0 auto 28px", opacity: detailIn }} />
        ) : null}
        <div
          style={{
            marginBottom: 34,
            color: theme.muted,
            fontFamily: theme.bodyFont,
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            opacity: detailIn,
          }}
        >
          {newsletterLine || "Your sourced briefing"}
        </div>
        <div
          style={{
            color: theme.ink,
            fontFamily: theme.headingFont,
            fontSize: promiseFontSize,
            fontWeight: 900,
            lineHeight: 1.08,
            letterSpacing: "-0.035em",
            opacity: interpolate(promiseIn, [0, 1], [0.72, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            transform: `translateY(${interpolate(promiseIn, [0, 1], [24, 0])}px)`,
            textShadow: theme.mode === "dark" ? "0 8px 30px #00000099" : "none",
            whiteSpace: "nowrap",
          }}
        >
          {promise}
        </div>
        <div
          style={{
            marginTop: 48,
            display: "inline-flex",
            alignItems: "center",
            gap: 22,
            padding: "26px 54px 26px 62px",
            borderRadius: 60,
            background: accent,
            fontSize: 48,
            fontWeight: 900,
            letterSpacing: "0.025em",
            color: "#FFFFFF",
            boxShadow: `0 12px 48px ${accent}88`,
            opacity: interpolate(pillIn, [0, 1], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            transform: `scale(${interpolate(pillIn, [0, 1], [0.55, 1])})`,
          }}
        >
          <span>SUBSCRIBE</span>
          <span
            style={{
              display: "inline-block",
              fontSize: 58,
              lineHeight: 0.8,
              transform: `translateX(${interpolate(arrowIn, [0, 1], [-18, 0])}px)`,
            }}
          >
            →
          </span>
        </div>
        {newsletterLine ? (
          <div
            style={{
              marginTop: 34,
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: "0.14em",
              color: theme.muted,
              fontFamily: theme.bodyFont,
              opacity: detailIn,
            }}
          >
            📰 {newsletterLine}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
