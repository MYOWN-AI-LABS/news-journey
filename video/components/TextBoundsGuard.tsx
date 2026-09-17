import React from "react";
import { cancelRender, continueRender, delayRender, getRemotionEnvironment, useCurrentFrame } from "remotion";

/** Measure painted text, including SVG labels and text clipped by an ancestor. */
export function textOverflow(root: HTMLElement): string[] {
  const problems: string[] = [];
  const caption = root.querySelector('[data-caption-plate]')?.getBoundingClientRect();
  const status = root.querySelector('[data-story-status]');
  if (caption && status?.textContent?.trim()) {
    const range = document.createRange(); range.selectNodeContents(status);
    if (Array.from(range.getClientRects()).some(box => box.width && box.height && box.bottom > caption.top && box.top < caption.bottom && box.right > caption.left && box.left < caption.right)) problems.push('captions overlap the story qualification');
  }
  const viewport = root.getBoundingClientRect();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const label = node.textContent?.trim();
    const parent = node.parentElement;
    if (!label || !parent || parent.closest("style,script,title,desc,defs")) continue;
    let visible = true;
    const clips = [{ box: viewport, x: true, y: true }];
    for (let el: Element | null = parent; el; el = el.parentElement) {
      const css = getComputedStyle(el);
      if (css.display === "none" || css.visibility === "hidden" || Number(css.opacity) === 0) visible = false;
      const x = /hidden|clip|scroll|auto/.test(css.overflowX);
      const y = /hidden|clip|scroll|auto/.test(css.overflowY);
      if (x || y) clips.push({ box: el.getBoundingClientRect(), x, y });
      if (el === root) break;
    }
    if (!visible) continue;
    const range = document.createRange();
    // A word can fit within the viewport yet still be broken into character fragments.
    // Check each letter/number run, allowing normal breaks at spaces and hyphens.
    for (const word of (node.textContent ?? "").matchAll(/[\p{L}\p{N}]+/gu)) {
      range.setStart(node, word.index!);
      range.setEnd(node, word.index! + word[0].length);
      const fragments = Array.from(range.getClientRects()).filter(box => box.width && box.height);
      if (fragments.some(box => Math.abs(box.top - fragments[0].top) > 1)) {
        problems.push(`word "${word[0]}" is split across lines`);
      }
    }
    range.selectNodeContents(node);
    for (const box of Array.from(range.getClientRects())) {
      if (!box.width || !box.height) continue;
      if (clips.some(({ box: clip, x, y }) =>
        (x && (box.left < clip.left - 1 || box.right > clip.right + 1)) ||
        (y && (box.top < clip.top - 1 || box.bottom > clip.bottom + 1)))) {
        problems.push(`"${label.slice(0, 100)}" at (${Math.round(box.left - viewport.left)}, ${Math.round(box.top - viewport.top)}) extends beyond its visible frame`);
        break;
      }
    }
  }
  return problems;
}

/** Runs inside every rendered Short frame, including CLI and unattended renders. */
export const TextBoundsGuard: React.FC<{ root: React.RefObject<HTMLDivElement | null> }> = ({ root }) => {
  const frame = useCurrentFrame();
  React.useLayoutEffect(() => {
    if (!getRemotionEnvironment().isRendering) return;
    const handle = delayRender(`Text bounds at frame ${frame}`);
    let cancelled = false;
    void document.fonts.ready.then(() => {
      const check = () => {
        if (cancelled) return;
        try {
          if (!root.current) throw new Error("Video text root is missing");
          // Remotion mounts into a detached portal first. Keep the capture held until it is laid
          // out; a never-attached frame times out instead of receiving an unchecked PASS.
          const viewport = root.current.getBoundingClientRect();
          if (!root.current.isConnected || !viewport.width || !viewport.height) {
            requestAnimationFrame(check);
            return;
          }
          const problems = textOverflow(root.current);
          if (problems.length) {
            const box = root.current.getBoundingClientRect();
            throw new Error(`TEXT OVERFLOW at frame ${frame} (${box.width}x${box.height} viewport): ${problems.join("; ")}`);
          }
          continueRender(handle);
        } catch (error) { cancelRender(error as Error); }
      };
      // Let ResizeObserver-driven text fitting commit after the portal obtains its dimensions.
      requestAnimationFrame(() => requestAnimationFrame(check));
    }).catch((error) => { if (!cancelled) cancelRender(error); });
    return () => { cancelled = true; continueRender(handle); };
  }, [frame, root]);
  return null;
};
