/**
 * Video theme tokens. The harness ships no house look: the default is a neutral light theme with system
 * fonts, and the customer's Personalize choices (light/dark, accent, font pairing) or the workspace file
 * `branding/video-theme.json` replace any token. Every scene reads these instead of hard-coded colours.
 */
export interface VideoTheme {
  mode: "light" | "dark";
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  hair: string;
  accent: string;
  headingFont: string;
  bodyFont: string;
}

export const DEFAULT_VIDEO_THEME: VideoTheme = {
  mode: "light",
  bg: "#FFFFFF",
  surface: "#F4F5F7",
  ink: "#1A1D21",
  muted: "#5B6470",
  hair: "#E1E4E8",
  accent: "#2F6F8F",
  headingFont: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  bodyFont: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};

/** A caption pill and other overlays need a contrasting plate: dark on light themes, light on dark ones. */
export function overlayPlate(theme: VideoTheme): { background: string; ink: string } {
  return theme.mode === "dark" ? { background: "#000000B8", ink: "#FFFFFF" } : { background: "#1A1D21E6", ink: "#FFFFFF" };
}

export function resolveTheme(theme?: Partial<VideoTheme> | null): VideoTheme {
  return { ...DEFAULT_VIDEO_THEME, ...(theme ?? {}) };
}
