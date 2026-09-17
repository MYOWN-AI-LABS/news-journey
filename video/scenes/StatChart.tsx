import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { RenderProps } from "../../src/types";

type Seg = RenderProps["segments"][number];
type StarPoint = { date: string; count: number };

export const StatChart: React.FC<{ seg: Seg; stars?: StarPoint[]; accent: string }> = ({ seg, stars, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 16 } });
  const draw = interpolate(frame, [5, 50], [0, 1], { extrapolateLeft:"clamp", extrapolateRight: "clamp" });

  const W = 800;
  const H = 360;
  let path = "";
  if (stars && stars.length > 1) {
    const max = Math.max(...stars.map((p) => p.count)) || 1;
    const pts = stars.map((p, i) => {
      const x = (i / (stars.length - 1)) * W;
      const y = H - (p.count / max) * (H - 30);
      return `${x},${y}`;
    });
    const visible = Math.max(2, Math.ceil(pts.length * draw));
    path = `M ${pts.slice(0, visible).join(" L ")}`;
  }

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 70 }}>
      <div
        style={{
          width: "100%",
          maxWidth: 940,
          borderRadius: 36,
          background: "#15151FEE",
          border: `2px solid ${accent}55`,
          boxShadow: "0 30px 80px #00000088",
          padding: "48px 52px",
          opacity: s,
          transform: `translateY(${interpolate(s, [0, 1], [60, 0])}px)`,
          marginBottom: 300,
        }}
      >
        <div style={{ fontSize: 58, fontWeight: 850, color: "#FFFFFF", lineHeight: 1.2 }}>{seg.onScreen.title}</div>
        <div style={{ fontSize: 110, fontWeight: 900, color: accent, margin: "20px 0" }}>
          {stars?.length === 1 ? `${stars[0].count.toLocaleString("en-US")} stars` : seg.onScreen.stat ?? ""}
        </div>
        {path ? (
          <svg width={W} height={H} style={{ marginTop: 10 }}>
            <path d={path} fill="none" stroke={accent} strokeWidth={10} strokeLinecap="round" />
            <path d={`${path} L ${W * draw},${H} L 0,${H} Z`} fill={`${accent}22`} />
          </svg>
        ) : stars?.length === 1 || seg.onScreen.sub ? (
          <div style={{ fontSize: 56, color: "#CBD5E1" }}>{stars?.length === 1 ? `GitHub observation · ${stars[0].date}` : seg.onScreen.sub}</div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
