/**
 * The story diagram, rendered as REAL 3D through WebGL.
 *
 * WHY WEBGL AND NOT CSS 3D:
 * A CSS-transformed plate is still one flat surface. Tilting it and putting a shadow under it does
 * not create depth between the NODES, so the camera move reads as a skew rather than a space, and
 * the first attempt was rejected in review for exactly that: it did not read as an immersive view.
 * Real depth needs the drawing distributed across planes and a real perspective camera, which is
 * what this is.
 *
 * WHY THREE AND NOT BLENDER:
 * Remotion already renders in headless Chrome, so @remotion/three puts genuine WebGL inside the
 * EXISTING pipeline — same React tree, same frame clock, same deterministic hash. Blender would be
 * a second offline renderer producing a second artifact chain, and it can never run live in the web
 * issue. One scene definition feeding video + web + GIF is the project's "same picture in both
 * media by construction" rule; Blender can only ever feed the video.
 *
 * WHY THE PLATE STAYS FLAT AND FACING CAMERA:
 * Extruding or tilting the labels is exactly what destroys legibility, and this session exists
 * because 49 labels shipped unreadable. Depth comes from the SPACE — plane separation, fog, camera
 * travel — never from deforming the text.
 *
 * ANIMATION IS FRAME-DRIVEN, NOT CSS:
 * Remotion seeks frame by frame; a CSS keyframe animation sits frozen in the output. Every value
 * here is a pure function of useCurrentFrame(), which is also what makes narration sync free — the
 * frame clock IS the audio clock.
 */
import React, { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { ThreeCanvas } from "@remotion/three";
import { continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import {
  DEPTH_PLANES,
  splitDiagramPlanes,
  standaloneDiagramDataUri,
  type DepthPlane,
} from "../../src/pipeline/diagram-standalone";

/** Diagram viewBox is 720x340. Plate width in world units; height follows the aspect exactly. */
const PLATE_W = 6.4;
const PLATE_H = (PLATE_W * 340) / 720;

/**
 * Camera distance is DERIVED, not guessed.
 *
 * The frame is 1080x1920 — portrait — so the horizontal field of view is far narrower than the
 * vertical one, and `fov` in three.js is the VERTICAL angle. Visible width at distance d is
 * 2*d*tan(fov/2) * (width/height). At the first-guess d=5.6 that is only ~2.3 units, so a 6.4-unit
 * plate sat almost entirely outside the frustum and the render came back as floor and motes with no
 * diagram at all. Solving for the distance that frames the plate with a margin avoids repeating it
 * if the plate size or the frame aspect ever changes.
 */
const CAMERA_FOV = 42;
const FRAME_ASPECT = 1080 / 1920;
// Include the world's sideways travel and approach, so labels stay inside the moving view.
const PLATE_MARGIN = 1.35;
const CAMERA_Z =
  (PLATE_W * PLATE_MARGIN) / (2 * Math.tan((CAMERA_FOV * Math.PI) / 360) * FRAME_ASPECT);

/**
 * Depth spread, deliberately SMALL.
 *
 * Parallax separates whatever sits on different planes — which is the point for a landscape, and a
 * problem for a diagram, because a label and the box it belongs to must stay registered. At a wide
 * spread (far -3.4) the first render put "COPY" on top of "ISOLATED SUBAGENT VMS" and slid "WAKE"
 * off its connector: the drawing came apart.
 *
 * So the diagram gets just enough separation to read as dimensional, and the IMMERSION comes from
 * the environment around it — floor, fog, motes, camera travel. Depth must never cost legibility.
 */
const PLANE_Z: Record<DepthPlane, number> = { far: -0.95, mid: -0.36, near: 0.16 };

/**
 * Counter-scale, DERIVED not guessed. Apparent size goes as 1/distance, so a plane at z keeps the
 * z=0 plane's apparent size at scale (CAMERA_Z - z)/CAMERA_Z. Hand-picked values (1.62 for far,
 * where the correct figure is 1.205) are exactly why the planes fell out of register.
 */
const planeScale = (z: number): number => (CAMERA_Z - z) / CAMERA_Z;
const PLANE_SCALE: Record<DepthPlane, number> = {
  far: planeScale(PLANE_Z.far),
  mid: planeScale(PLANE_Z.mid),
  near: planeScale(PLANE_Z.near),
};
const PLANE_OPACITY: Record<DepthPlane, number> = { far: 0.62, mid: 0.92, near: 1 };

/** Decode one data-URI SVG into a texture. Rejection is never fatal — a bad plane must not hang. */
function loadTexture(dataUri: string): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      resolve(tex);
    };
    img.onerror = () => {
      // eslint-disable-next-line no-console
      console.error(`StoryDiagram3D: plane texture failed to decode (${dataUri.slice(0, 96)}…)`);
      resolve(null);
    };
    img.src = dataUri;
  });
}

const DiagramPlane: React.FC<{ texture: THREE.Texture | null; plane: DepthPlane }> = ({ texture, plane }) => {
  if (!texture) return null;
  const s = PLANE_SCALE[plane];
  return (
    <mesh position={[0, 0, PLANE_Z[plane]]} scale={[s, s, 1]}>
      <planeGeometry args={[PLATE_W, PLATE_H]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={PLANE_OPACITY[plane]}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
};

/** Receding floor. The single strongest cue that the plate is standing in a space. */
const Floor: React.FC<{ accent: string }> = ({ accent }) => (
  <gridHelper
    args={[CAMERA_Z * 6, 48, new THREE.Color(accent), new THREE.Color(accent)]}
    position={[0, -PLATE_H * 1.5, -CAMERA_Z * 0.3]}
  />
);

/** Accent motes at varying depth. Deterministic positions — a render must reproduce exactly. */
const Motes: React.FC<{ accent: string; count?: number }> = ({ accent, count = 90 }) => {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // hashed, not random: Math.random() would give a different scene on every re-render
      const h = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
      pos[i * 3] = (h(1) - 0.5) * PLATE_W * 2.4;
      pos[i * 3 + 1] = (h(2) - 0.5) * PLATE_H * 5;
      pos[i * 3 + 2] = -CAMERA_Z * 0.45 + h(3) * CAMERA_Z * 0.7;
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, [count]);

  return (
    <points geometry={geometry}>
      <pointsMaterial
        color={new THREE.Color(accent)}
        size={0.045}
        transparent
        opacity={0.75}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
};

/**
 * The moving world. The CAMERA stays put and the world moves, which produces identical parallax and
 * avoids fighting @remotion/three over camera ownership.
 */
const World: React.FC<{
  textures: Record<DepthPlane, THREE.Texture | null> | null;
  accent: string;
}> = ({ textures, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  // Slow, continuous, and large enough that the plane separation is visible. Small moves are what
  // made the CSS attempt read as a flat card with a skew on it.
  const yaw = Math.sin(t * 0.21) * 0.20;
  const pitch = Math.cos(t * 0.17) * 0.075;
  const x = Math.sin(t * 0.13) * 0.55;
  const y = Math.cos(t * 0.11) * 0.22;
  const z = Math.sin(t * 0.09) * 0.7;

  return (
    <group rotation={[pitch, yaw, 0]} position={[x, y, z]}>
      {textures && DEPTH_PLANES.map((p) => <DiagramPlane key={p} texture={textures[p]} plane={p} />)}
      <Floor accent={accent} />
      <Motes accent={accent} />
    </group>
  );
};

export const StoryDiagram3D: React.FC<{
  svg: string;
  accent: string;
  width: number;
  height: number;
}> = ({ svg, accent, width, height }) => {
  const [textures, setTextures] = useState<Record<DepthPlane, THREE.Texture | null> | null>(null);

  /**
   * ONE delayRender handle, held from mount until every texture has decoded.
   *
   * The obvious structure — parent splits and continues its handle, children then load their own
   * textures behind their own handles — has a fatal gap: between the parent's continueRender and
   * the children mounting there are ZERO pending handles, so Remotion considers the frame ready and
   * screenshots it. That produced a scene with floor and motes and no diagram, with nothing in any
   * log to say why. Never release the handle until the thing it is waiting for actually exists.
   *
   * Splitting also needs a live DOM for getBBox, which is why this is an effect and not module scope.
   */
  useEffect(() => {
    const handle = delayRender("building diagram depth planes");
    let cancelled = false;
    (async () => {
      try {
        const planes = splitDiagramPlanes(svg);
        const loaded = await Promise.all(
          // no background: the planes stack in a 3D scene and must composite over it
          DEPTH_PLANES.map((p) => loadTexture(standaloneDiagramDataUri(planes[p], { accent, width: 2048 }))),
        );
        if (!cancelled) {
          const next = {} as Record<DepthPlane, THREE.Texture | null>;
          DEPTH_PLANES.forEach((p, i) => { next[p] = loaded[i] ?? null; });
          setTextures(next);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("StoryDiagram3D: plane split failed", err);
      } finally {
        continueRender(handle);
      }
    })();
    return () => { cancelled = true; };
  }, [svg, accent]);

  return (
    <ThreeCanvas
      width={width}
      height={height}
      camera={{ fov: CAMERA_FOV, position: [0, 0, CAMERA_Z], near: 0.1, far: 90 }}
      gl={{ antialias: true }}
      style={{ background: "transparent" }}
    >
      {/* Fog turns distance into atmosphere, so the far plane reads as FAR rather than merely
          smaller. Ranged off the derived camera distance so it keeps working if the plate resizes.
          No lights: every material here is unlit on purpose — lighting the planes would tint the
          diagram's colours and put the contrast gate's measurements out of step with the render. */}
      <fog attach="fog" args={["#0A0E18", CAMERA_Z * 0.7, CAMERA_Z * 1.9]} />
      <World textures={textures} accent={accent} />
    </ThreeCanvas>
  );
};
