// One view of a model as a PNG, for the gallery card `publishShapeScript`
// posts. A host passes this as the tool's `renderThumbnail`; the core entry
// cannot hold it because rasterising needs the headless browser this
// server-only subpath is for.
import { RenderUnavailableError, renderShapeScriptSheet } from "./renderer";

/** The gallery card is 4:3; one three-quarter view at the render tool's default angle. */
const THUMBNAIL_WIDTH = 640;
const THUMBNAIL_HEIGHT = 480;
const THUMBNAIL_AZIMUTH = 30;
const THUMBNAIL_ELEVATION = 25;

/** Render `script` to a PNG, or null where this host has no browser. A script
 *  that will not build throws, as the renderer does — the publish tool has
 *  already built it once by then, so that is a renderer fault, which the tool
 *  reports as a warning and posts without a picture. */
export async function renderShapeThumbnail(script: string, onWarning?: (message: string) => void): Promise<Uint8Array | null> {
  try {
    const base64 = await renderShapeScriptSheet({
      script,
      views: [{ azimuth: THUMBNAIL_AZIMUTH, elevation: THUMBNAIL_ELEVATION, label: "" }],
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
      zoom: 1,
      projection: "perspective",
      ...(onWarning ? { onWarning } : {}),
    });
    return new Uint8Array(Buffer.from(base64, "base64"));
  } catch (error) {
    if (error instanceof RenderUnavailableError) return null;
    throw error;
  }
}
