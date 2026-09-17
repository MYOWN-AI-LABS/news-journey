import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";

type Corner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

export const Presenter: React.FC<{
  src: string; // public-dir-relative, e.g. "<id>/avatar.mp4"
  mode: "avatar" | "hybrid";
  scale?: number; // hybrid inset width as fraction of frame
  corner?: Corner;
  accent: string;
  startFrom?: number; // trim this many composition frames off the avatar start so it stays in sync
  // when shown inside a delayed <Sequence> (the avatar.mp4 is synced to the FULL audio from frame 0)
}> = ({ src, mode, scale = 0.4, corner = "bottom-right", accent, startFrom }) => {
  const video = <OffthreadVideo src={staticFile(src)} startFrom={startFrom} muted style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: mode === "hybrid" ? "center top" : "center" }} />;

  if (mode === "avatar") {
    return <AbsoluteFill>{video}</AbsoluteFill>;
  }

  // hybrid: rounded inset pinned to a corner, leaving room for captions at the bottom
  const margin = 48;
  const vertical = corner.startsWith("top") ? { top: margin } : { bottom: 260 };
  const horizontal = corner.endsWith("right") ? { right: margin } : { left: margin };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          ...vertical,
          ...horizontal,
          width: `${Math.round(scale * 100)}%`,
          aspectRatio: "1 / 1",
          borderRadius: 28,
          overflow: "hidden",
          border: `3px solid ${accent}`,
          boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
        }}
      >
        {video}
      </div>
    </AbsoluteFill>
  );
};
