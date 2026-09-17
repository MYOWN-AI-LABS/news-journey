import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { resolveTheme, type VideoTheme } from "../theme";

const STOP_WORDS = new Set(["a", "an", "and", "are", "for", "how", "in", "is", "of", "on", "the", "this", "to", "with", "you"]);

function highlightIndex(words: string[]): number {
  const numeric = words.findIndex((word) => /\d/.test(word));
  if (numeric !== -1) return numeric;

  let bestIndex = 0;
  let bestScore = -1;
  words.forEach((word, index) => {
    const clean = word.replace(/[^a-zA-Z0-9]/g, "");
    const isSignalWord = !STOP_WORDS.has(clean.toLowerCase());
    const isAcronymOrBrand = /[A-Z].*[A-Z]/.test(clean);
    const score = (isSignalWord ? clean.length : 0) + (isAcronymOrBrand ? 12 : 0);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });
  return bestIndex;
}

export const Hook: React.FC<{ text: string; accent: string; theme?: Partial<VideoTheme> | null }> = ({ text, accent, theme: themeIn }) => {
  const theme = resolveTheme(themeIn);
  const shadow = theme.mode === "dark" ? "0 8px 30px #000000AA" : "none";
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const content = React.useRef<HTMLDivElement>(null);
  const [fit, setFit] = React.useState(1);
  React.useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    // The same scene carries both a short hook and a whole spoken introduction. Fit its actual
    // layout, including long unbroken words, before Remotion captures the frame.
    const measure = () => {
      if (!node.offsetWidth || !node.offsetHeight) return; // Remotion attaches its portal after mount.
      // A centered word can overflow on BOTH sides; scrollWidth sees only the right side.
      // Measure intact words explicitly, including the content's horizontal padding.
      const longestWord = Math.max(0, ...Array.from(node.querySelectorAll<HTMLElement>("[data-display-word]")).map(word => word.offsetWidth + 32));
      setFit(Math.min(1, (width - 128) / Math.max(node.offsetWidth, node.scrollWidth, longestWord),
        (height - 160) / Math.max(node.offsetHeight, node.scrollHeight)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [text, width, height]);
  const words = text.trim().split(/\s+/).filter(Boolean);
  const accentWord = highlightIndex(words);
  const punch = spring({
    frame,
    fps,
    config: { damping: 9, stiffness: 320, mass: 0.5 },
  });
  const scale = interpolate(punch, [0, 1], [0.97, 1]);
  const opacity = interpolate(punch, [0, 1], [0.76, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const shakeStrength = interpolate(frame, [0, 3, 10], [0, 0, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const shakeX = Math.sin((frame + 1) * 2.7) * shakeStrength;
  const shakeY = Math.cos((frame + 1) * 2.1) * shakeStrength * 0.45;
  const flash = interpolate(frame, [0, 2, 7], [0, 0, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fontSize = words.length <= 3 ? 172 : words.length <= 5 ? 148 : words.length <= 7 ? 128 : 112;

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 64, overflow: "hidden", background: theme.bg, fontFamily: theme.headingFont }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at center, ${accent} 0%, transparent 68%)`,
          opacity: flash,
        }}
      />
      <div
        ref={content}
        style={{
          width: "100%",
          flexShrink: 0,
          boxSizing: "border-box",
          padding: "48px 16px",
          maxWidth: 960,
          textAlign: "center",
          opacity,
          transform: `translate(${shakeX}px, ${shakeY}px) scale(${scale * fit})`,
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            columnGap: 24,
            fontSize,
            fontWeight: 950,
            lineHeight: 0.98,
            letterSpacing: "-0.055em",
            textTransform: "uppercase",
            textWrap: "balance",
          }}
        >
          {words.map((word, index) => (
            <span
              key={`${word}-${index}`}
              data-display-word
              style={{
                display: "inline-block",
                flexShrink: 0,
                whiteSpace: "nowrap",
                color: index === accentWord ? accent : theme.ink,
                textShadow: shadow,
              }}
            >
              {word}
            </span>
          ))}
        </div>
        <div
          style={{
            width: 150,
            height: 8,
            margin: "54px auto 0",
            borderRadius: 999,
            background: accent,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
