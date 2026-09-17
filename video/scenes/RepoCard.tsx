import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { RenderProps, RepoInfo } from "../../src/types";

type Seg = RenderProps["segments"][number];

export const RepoCard: React.FC<{ seg: Seg; repo: RepoInfo | null; accent: string }> = ({ seg, repo, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 16 } });

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 70 }}>
      <div
        style={{
          width: "100%",
          maxWidth: 940,
          borderRadius: 36,
          overflow: "hidden",
          background: "#0D1117EE",
          border: "2px solid #30363D",
          boxShadow: "0 30px 80px #00000088",
          transform: `scale(${interpolate(s, [0, 1], [0.9, 1])})`,
          opacity: s,
          marginBottom: 300,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "36px 48px 0" }}>
          {/* GitHub mark */}
          <svg height="56" viewBox="0 0 16 16" width="56" fill="#FFFFFF">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
          </svg>
          <div style={{ fontSize: 46, fontWeight: 700, color: "#58A6FF", fontFamily: "Menlo, monospace" }}>
            {repo?.fullName ?? seg.onScreen.title}
          </div>
        </div>
        {seg.assetFile ? (
          <Img
            src={staticFile(seg.assetFile)}
            style={{ width: "92%", margin: "32px auto 0", borderRadius: 20, display: "block", border: "1px solid #30363D" }}
          />
        ) : null}
        <div style={{ padding: "36px 48px 44px" }}>
          <div style={{ fontSize: 42, color: "#C9D1D9", lineHeight: 1.35 }}>
            {repo?.description ?? seg.onScreen.sub ?? ""}
          </div>
          <div style={{ display: "flex", gap: 40, marginTop: 28, alignItems: "center" }}>
            {repo ? (
              <div style={{ fontSize: 44, fontWeight: 800, color: "#F0C649" }}>
                ★ {repo.stars.toLocaleString()}
              </div>
            ) : null}
            {seg.onScreen.stat ? (
              <div style={{ fontSize: 44, fontWeight: 800, color: accent }}>{seg.onScreen.stat}</div>
            ) : null}
            {repo?.language ? (
              <div style={{ fontSize: 36, color: "#8B949E" }}>{repo.language}</div>
            ) : null}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
