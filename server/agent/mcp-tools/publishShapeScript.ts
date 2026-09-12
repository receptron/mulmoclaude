// `publishShapeScript` — post a ShapeScript model to the public gallery on
// mulmoserver (server.mulmocast.com/shapes) under the user's own account.
//
// A pure MCP tool like `exportShapeScriptUsdz`: no View, the answer is the
// model's URL. Everything a model sees — schema, description, the document a
// post is, the keyword rules — lives in `@mulmoclaude/shapescript-plugin`, and
// that entry is Firebase-free on purpose. What this host contributes is the
// signed-in session: the remote-host runner signs into mulmoserver's Firebase
// AS THE USER (docs/remote-host.md, "Option B"), so a post is a plain
// Firestore write on `shapes/{id}` that the gallery's rules accept because
// `uid == request.auth.uid`. No session → the tool says how to connect one.
//
// The thumbnail comes from the same renderer `renderShapeScript` uses; a host
// without Chromium posts without a picture rather than failing.
import {
  executePublishShapeScript,
  PUBLISH_DESCRIPTION,
  PUBLISH_PROMPT,
  PUBLISH_SCHEMA,
  PUBLISH_TOOL_NAME,
  type ShapeGalleryWriter,
  type ShapePostDoc,
} from "@mulmoclaude/shapescript-plugin";
import { renderShapeThumbnail, RENDER_TOOL_TIMEOUT_MS } from "@mulmoclaude/shapescript-plugin/render";
import { doc, serverTimestamp, setDoc, type Firestore } from "firebase/firestore";
import { deleteObject, ref as storageRef, uploadBytes, type FirebaseStorage } from "firebase/storage";
import { currentDisplayName, currentFirestoreSession, currentStorage } from "../../remoteHost/session.js";
import { log } from "../../system/logger/index.js";
import { shapeFiles } from "./exportShapeScriptUsdz.js";
import type { McpTool } from "./index.js";

const SHAPES = "shapes";
const THUMBNAIL_TYPE = "image/png";

/** The document as written: the post plus the two stamps the rules demand be
 *  the server's. Exported for the test that pins it. */
export function postDocumentOf(post: ShapePostDoc): Record<string, unknown> {
  return { ...post, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
}

/** Where a post's picture lives in Storage — `shapes/{uid}/{shapeId}/{objectId}`,
 *  under the owner so the Storage rule scopes writes without a Firestore read. */
export function shapeObjectPath(uid: string, shapeId: string, objectId: string): string {
  return `${SHAPES}/${uid}/${shapeId}/${objectId}`;
}

/** The writer over one signed-in session: the Firestore document, and the
 *  Storage object the card shows — under `shapes/{uid}/{id}/…`, the path the
 *  Storage rule lets the owner write. */
export function galleryWriterFrom(session: { firestore: Firestore; storage: FirebaseStorage; uid: string; authorName: string }): ShapeGalleryWriter {
  const objectRef = (shapeId: string, objectId: string) => storageRef(session.storage, shapeObjectPath(session.uid, shapeId, objectId));
  return {
    uid: session.uid,
    authorName: session.authorName,
    createPost: (shapeId, post) => setDoc(doc(session.firestore, SHAPES, shapeId), postDocumentOf(post)),
    uploadThumbnail: async (shapeId, png) => {
      const objectId = crypto.randomUUID();
      await uploadBytes(objectRef(shapeId, objectId), png, { contentType: THUMBNAIL_TYPE });
      return objectId;
    },
    deleteObject: (shapeId, objectId) => deleteObject(objectRef(shapeId, objectId)),
  };
}

/** The live session as a writer, or null when Remote Host is not connected. */
function currentGallery(): ShapeGalleryWriter | null {
  const session = currentFirestoreSession();
  if (!session) return null;
  return galleryWriterFrom({ firestore: session.firestore, storage: currentStorage(), uid: session.uid, authorName: currentDisplayName() ?? "" });
}

export const publishShapeScript: McpTool = {
  definition: {
    name: PUBLISH_TOOL_NAME,
    description: PUBLISH_DESCRIPTION,
    inputSchema: PUBLISH_SCHEMA,
  },
  // The thumbnail is a render, so the transport must outlast one.
  bridgeTimeoutMs: RENDER_TOOL_TIMEOUT_MS,
  prompt: PUBLISH_PROMPT,
  handler: async (args: Record<string, unknown>): Promise<string> => {
    log.info("render", "publishShapeScript: start", { args: Object.keys(args).join(",") });
    const result = await executePublishShapeScript(
      {
        files: shapeFiles,
        gallery: currentGallery(),
        renderThumbnail: (script) => renderShapeThumbnail(script, (message) => log.warn("render", "publishShapeScript: renderer", { message })),
        onWarning: (message) => log.warn("render", "publishShapeScript", { message }),
      },
      args,
    );
    log.info("render", "publishShapeScript: ok", { id: result.id, thumbnail: result.thumbnail });
    return result.message;
  },
};
