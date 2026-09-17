import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { WordStamp } from "../../src/types";
import { overlayPlate, resolveTheme, type VideoTheme } from "../theme";
import { captionGroup } from "../../src/captions";

/** Lower-third karaoke captions: 4-word groups, active word highlighted.
 * offsetSec: absolute time of the parent Sequence start (useCurrentFrame is sequence-relative). */
export const Captions: React.FC<{ words: WordStamp[]; accent: string; offsetSec?: number; theme?: Partial<VideoTheme> | null; variant?: "clean" | "boxed" | "pill" | "glow" }> = ({
  words,
  accent,
  offsetSec = 0,
  theme: themeIn,
  variant = "clean",
}) => {
  const theme = resolveTheme(themeIn);
  const base = overlayPlate(theme);
  // Caption style from Personalize → Video style. Pill inverts (accent plate, ink text); glow keeps the plate and lights the word.
  const plate = variant === "pill" ? { background: accent, ink: theme.mode === "dark" ? "#000000" : "#FFFFFF" }
    : variant === "boxed" ? { background: theme.surface, ink: theme.ink }
    : variant === "glow" ? { background: "#10141DEE", ink: "#FFFFFF" } : base;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps + offsetSec;

  const idx = words.findIndex((w, i) => t >= w.start && (i === words.length - 1 || t < words[i + 1].start));
  if (idx === -1) return null;
  const { start: groupStart, words: group } = captionGroup(words, idx);

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 110 }}>
      <div
        data-caption-plate=""
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "0 18px",
          maxWidth: 920,
          padding: "26px 44px",
          borderRadius: variant === "boxed" ? 6 : variant === "pill" ? 999 : 28,
          border: variant === "boxed" || variant === "glow" ? `5px solid ${accent}` : undefined,
          boxShadow: variant === "glow" ? `0 0 36px ${accent}99, inset 0 0 18px ${accent}66` : undefined,
          background: plate.background,
          fontFamily: theme.bodyFont,
          backdropFilter: variant === "boxed" ? undefined : "blur(8px)",
        }}
      >
        {group.map((w, i) => {
          const active = groupStart + i === idx && t < w.end;
          return (
            <span
              key={i}
              style={{
                fontSize: 58,
                lineHeight: 1.25,
                color: plate.ink,
                fontWeight: variant === "pill" && active ? 900 : 800,
                // Keep text legible on the dark plate; the customer's accent marks the active word.
                textDecoration: active && variant !== "pill" ? "underline" : undefined,
                textDecorationColor: accent,
                textDecorationThickness: "4px",
                textUnderlineOffset: "8px",
                // Scaling a long word consumes the space beside its neighbors.
                transform: "none",
                textShadow: variant === "glow" && active ? `0 0 24px ${accent}, 0 0 48px ${accent}AA` : variant === "pill" || variant === "boxed" ? "none" : "0 2px 12px #000000AA",
                transition: "none",
              }}
            >
              {w.w}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
