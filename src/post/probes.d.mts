export interface ProbeResult { state: "live" | "dead" | "unverifiable"; detail: string; permalink?: string }
export interface Receipt { id: string; url: string }
export function createProbes(root: string, options?: { get?: (url: string) => Promise<{ status: number; body: string; error?: string }>; curlGet?: (url: string, ua?: string) => string }): Record<string, (post: Receipt) => Promise<ProbeResult>>;
export function get(url: string, options?: unknown): Promise<{ status: number; body: string; error?: string }>;
export function curlGet(url: string, ua?: string, timeout?: number): string;
export const UA: string, IG_EMBED_UA: string, CHROME_UA: string;
