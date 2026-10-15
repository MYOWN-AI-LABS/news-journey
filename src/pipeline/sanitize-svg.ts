import DOMPurify from "dompurify";

/**
 * Sanitize diagram SVG markup before it is injected with dangerouslySetInnerHTML (N12).
 * Diagram SVG can originate from a model, so scripts, event handlers, foreignObject,
 * external references and javascript: URLs are removed. Presentation markup used by the
 * diagram styles (class, style, d, transforms, filters, markers) is kept.
 *
 * In a browser (Remotion's renderer, Studio) DOMPurify does the work. Where no DOM exists
 * (Node unit tests, SSR) a conservative string fallback strips the same dangerous constructs.
 */
const FORBID_TAGS = ["script", "foreignObject", "iframe", "embed", "object", "image", "use", "animate", "set", "animateMotion", "animateTransform"];

export function sanitizeSvg(svg: string): string {
  const input = String(svg ?? "");
  if (!input) return "";
  if (typeof window !== "undefined" && (DOMPurify as { isSupported?: boolean }).isSupported) {
    return DOMPurify.sanitize(input, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS,
      FORBID_ATTR: ["href", "xlink:href"],
      ALLOW_DATA_ATTR: true,
    });
  }
  return fallbackSanitize(input);
}

export function fallbackSanitize(svg: string): string {
  let out = svg;
  for (const tag of FORBID_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
  }
  out = out.replace(/\s(?:on[a-z]+|href|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/javascript\s*:/gi, "");
  out = out.replace(/url\(\s*['"]?\s*(?!#)[^)]*\)/gi, "none"); // only local url(#id) refs survive
  return out;
}
