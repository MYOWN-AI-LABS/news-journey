import { chromium } from "playwright";

export interface FittedImage { bytes: Buffer; width: number; height: number; kind: "png" | "jpeg"; resized: boolean }

/** The video frame is 1080×1920; the newsletter column is 680 px wide. One copy that fits the frame serves both. */
export const IMAGE_FIT = { maxWidth: 1080, maxHeight: 1920, minWidth: 480, jpegQuality: 0.86 } as const;

/**
 * Fit an owner-supplied PNG or JPEG to the sizes the harness renders: never upscaled, downscaled to fit 1080×1920,
 * EXIF orientation applied (a phone photo arrives sideways otherwise), re-encoded in its own format. Rendering in the
 * bundled Chromium keeps this dependency-free; a decode failure names itself.
 */
export async function fitImage(bytes: Buffer, kind: "png" | "jpeg", fit = IMAGE_FIT): Promise<FittedImage> {
  const browser = await chromium.launch();
  const deadline = setTimeout(() => { void browser.close(); }, 30_000);
  try {
    const page = await browser.newPage({ viewport: { width: 200, height: 200 }, deviceScaleFactor: 1 });
    const result = await page.evaluate(async ({ dataUri, maxWidth, maxHeight, mime, quality }) => {
      const image = new Image();
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("decode failed")); image.src = dataUri; });
      const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
      const width = Math.max(1, Math.round(image.naturalWidth * scale)), height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0, width, height);
      return { data: canvas.toDataURL(mime, quality).split(",")[1], width, height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
    }, { dataUri: `data:image/${kind};base64,${bytes.toString("base64")}`, maxWidth: fit.maxWidth, maxHeight: fit.maxHeight, mime: kind === "png" ? "image/png" : "image/jpeg", quality: fit.jpegQuality });
    if (result.naturalWidth < fit.minWidth) throw new Error(`Use an image at least ${fit.minWidth} px wide; this one is ${result.naturalWidth} px.`);
    const resized = result.width !== result.naturalWidth || result.height !== result.naturalHeight;
    return { bytes: Buffer.from(result.data, "base64"), width: result.width, height: result.height, kind, resized };
  } catch (error) {
    throw new Error(`This image could not be read as a ${kind.toUpperCase()}: ${(error as Error).message}`);
  } finally { clearTimeout(deadline); await browser.close().catch(() => {}); }
}
