// The `publishShapeScript` TOOL: post a model to the public gallery on
// mulmoserver (https://server.mulmocast.com/shapes).
//
// What a MODEL sees — name, description, schema, the document a post is —
// lives here so the two hosts cannot drift, exactly as `exportShapeScriptUsdz`
// does. What is deliberately NOT here is Firebase: the gallery is written
// through a small `ShapeGalleryWriter` the host builds over its own remote-host
// session (the server signs into mulmoserver's Firebase AS THE USER — see
// docs/remote-host.md in MulmoClaude), so this entry stays browser-safe and
// the plugin declares no firebase dependency.
//
// The document mirrors mulmoserver's `shapes/{id}` exactly (its
// `src/firestore/shapeShape.ts`): the security rules there pin the key set
// with `hasOnly`, so a key added or dropped on one side is a refused write on
// the other. `SHAPE_POST_KEYS` is the pinned list; a test holds it to the
// rules' order.
import { disposeObject3D } from "../shapescript/dispose";
import { parseShapeScript } from "../shapescript/parser";
import { astToThreeJS } from "../shapescript/toThreeJS";
import { resolveShapeSource } from "../export/tool";
import type { ShapeScriptDispatchContext } from "./dispatch";

export const PUBLISH_TOOL_NAME = "publishShapeScript";

/** Where the gallery lives. A host may override it (a staging deploy). */
export const SHAPE_GALLERY_URL = "https://server.mulmocast.com";

/** The caps mulmoserver's rules enforce, mirrored so a post is refused here
 *  with a reason rather than there as a bare permission error. */
export const SHAPE_POST_LIMITS = {
  titleMax: 120,
  descriptionMax: 2000,
  scriptMax: 100_000,
  promptMax: 4000,
  authorNameMax: 80,
  keywordsMax: 10,
  keywordMax: 30,
} as const;

export const PUBLISH_DESCRIPTION =
  "Publish a ShapeScript model to the public gallery at server.mulmocast.com/shapes, where anyone can view it in 3D, read the source, download the USDZ and fork it. Takes the same source as presentShapeScript: inline `script`, or `path` to a saved .shape file. Posts under the user's own Google account — the app must be connected to Remote Host (signed in) first — and returns the model's URL. A thumbnail is rendered and attached when the host can rasterise; the post still lands without one.";

export const PUBLISH_PROMPT =
  "Use publishShapeScript ONLY when the user asks to publish, post or share a model to the gallery — never on your own initiative, since it makes the model public under their name. Before calling it, make sure the model previews correctly (presentShapeScript / renderShapeScript) and give it a short title, a sentence of description and a few lowercase keywords someone would search for. Pass the user's original request as `prompt` so the post records how the model was made. If the tool answers that Remote Host is not connected, tell the user to connect it (the Remote Host control in the app, Google sign-in) and offer to try again.";

/** The tool's JSON schema, in the shape both a gui-chat-protocol
 *  `ToolDefinition` (`parameters`) and an MCP tool (`inputSchema`) take. */
export const PUBLISH_SCHEMA = {
  type: "object" as const,
  properties: {
    title: {
      type: "string",
      description: `The model's title (1–${SHAPE_POST_LIMITS.titleMax} characters).`,
    },
    script: {
      type: "string",
      description: "ShapeScript source to publish. Provide either this or `path`, not both.",
    },
    path: {
      type: "string",
      description:
        "Path to an existing .shape file — an `artifacts/shapes/...` path presentShapeScript saved, or any .shape the host can read. Provide either this or `script`, not both.",
    },
    description: {
      type: "string",
      description: `What the model is, for the gallery page (up to ${SHAPE_POST_LIMITS.descriptionMax} characters). Optional.`,
    },
    keywords: {
      type: "array",
      items: { type: "string" },
      description: `Up to ${SHAPE_POST_LIMITS.keywordsMax} short lowercase tags someone would search for. Optional.`,
    },
    prompt: {
      type: "string",
      description: `The request the model was made from, recorded as its provenance (up to ${SHAPE_POST_LIMITS.promptMax} characters). Optional.`,
    },
    published: {
      type: "boolean",
      description: "false saves a draft only the user can see in the gallery's My models. Default true.",
    },
  },
  required: ["title"],
};

/** The document a post is, minus the two server-stamped times the host adds
 *  (`createdAt` / `updatedAt` must be `serverTimestamp()` — the rules refuse
 *  anything else). Every key present with a value: the rules pin the set and
 *  Firestore rejects `undefined`. */
export interface ShapePostDoc {
  uid: string;
  authorName: string;
  title: string;
  description: string;
  script: string;
  source: "prompt";
  prompt: string;
  photoIds: string[];
  thumbnailId: string;
  forkedFrom: null;
  keywords: string[];
  published: boolean;
}

/** The key set mulmoserver's rules accept, in the rules' own order. */
export const SHAPE_POST_KEYS = [
  "uid",
  "authorName",
  "title",
  "description",
  "script",
  "source",
  "prompt",
  "photoIds",
  "thumbnailId",
  "forkedFrom",
  "keywords",
  "published",
] as const;

/** What a host supplies: who is posting, and the two writes, over its own
 *  signed-in session. `uploadThumbnail` is optional — a host without Storage
 *  access posts without a picture. */
export interface ShapeGalleryWriter {
  /** The signed-in user's Firebase uid — the post's owner. */
  uid: string;
  /** The Google display name, as the gallery shows it. Empty is allowed. */
  authorName: string;
  /** Overrides `SHAPE_GALLERY_URL` for the returned link. */
  siteUrl?: string;
  /** Create `shapes/{id}` from `doc` plus the server timestamps. */
  createPost: (id: string, doc: ShapePostDoc) => Promise<void>;
  /** Store a PNG under the post and return the object id the document carries. */
  uploadThumbnail?: (id: string, png: Uint8Array) => Promise<string>;
}

export interface PublishShapeScriptContext extends ShapeScriptDispatchContext {
  /** null when the host has no signed-in session — the tool then says how to get one. */
  gallery: ShapeGalleryWriter | null;
  /** Rasterise one view of `script` to a PNG, or null when this host cannot
   *  (no browser). Supplied from `@mulmoclaude/shapescript-plugin/render`. */
  renderThumbnail?: (script: string) => Promise<Uint8Array | null>;
  /** A fault that did not stop the post — a thumbnail that could not be made. */
  onWarning?: (message: string) => void;
}

export interface PublishShapeResult {
  message: string;
  /** The post's id under `shapes/`. */
  id: string;
  /** The model's page. */
  url: string;
  /** Whether a thumbnail was attached. */
  thumbnail: boolean;
}

export const NOT_CONNECTED_MESSAGE =
  "Not connected to the gallery: publishing posts under the user's Google account, which needs the app's Remote Host connected (sign in with Google in the Remote Host control), then try again.";

const optionalString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

const keywordOf = (entry: unknown): string => (typeof entry === "string" ? entry.trim().toLowerCase().slice(0, SHAPE_POST_LIMITS.keywordMax) : "");

/** Keywords as the gallery stores them: trimmed, lowercased, deduplicated,
 *  each cut to `keywordMax`, at most `keywordsMax`. The same rule as
 *  mulmoserver's `normalizeKeywords`, so a tag typed there and one sent from
 *  here can never be two spellings of one word. A comma-separated string is
 *  accepted too, since a model sometimes sends one. */
export function normalizeKeywords(raw: unknown): string[] {
  const entries = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const keywords = entries.map(keywordOf).filter((keyword) => keyword !== "");
  return [...new Set(keywords)].slice(0, SHAPE_POST_LIMITS.keywordsMax);
}

function requireLength(name: string, value: string, max: number, min = 0): string {
  if (value.length < min) throw new Error(`\`${name}\` is required`);
  if (value.length > max) throw new Error(`\`${name}\` is too long (${value.length} characters; the gallery allows ${max})`);
  return value;
}

/** The document for one post, built field by field so nothing the caller
 *  passed can reach Firestore uninvited. Throws on a limit the rules would
 *  refuse, naming the field. */
export function shapePostFrom(
  writer: Pick<ShapeGalleryWriter, "uid" | "authorName">,
  fields: {
    title: string;
    script: string;
    description?: string | undefined;
    prompt?: string | undefined;
    keywords?: unknown;
    published?: boolean | undefined;
    thumbnailId?: string | undefined;
  },
): ShapePostDoc {
  return {
    uid: writer.uid,
    authorName: writer.authorName.slice(0, SHAPE_POST_LIMITS.authorNameMax),
    title: requireLength("title", fields.title.trim(), SHAPE_POST_LIMITS.titleMax, 1),
    description: requireLength("description", fields.description ?? "", SHAPE_POST_LIMITS.descriptionMax),
    script: requireLength("script", fields.script, SHAPE_POST_LIMITS.scriptMax, 1),
    source: "prompt",
    prompt: requireLength("prompt", fields.prompt ?? "", SHAPE_POST_LIMITS.promptMax),
    photoIds: [],
    thumbnailId: fields.thumbnailId ?? "",
    forkedFrom: null,
    keywords: normalizeKeywords(fields.keywords),
    published: fields.published !== false,
  };
}

/** The gallery's address for one post. */
export function shapePostUrl(id: string, siteUrl = SHAPE_GALLERY_URL): string {
  return `${siteUrl.replace(/\/+$/, "")}/shapes/${id}`;
}

/** Build and drop the model, so a script the viewer cannot show is refused
 *  here with its diagnostic rather than published broken. */
function requireBuildable(script: string): void {
  disposeObject3D(astToThreeJS(parseShapeScript(script)));
}

async function thumbnailFor(context: PublishShapeScriptContext, gallery: ShapeGalleryWriter, id: string, script: string): Promise<string> {
  if (!context.renderThumbnail || !gallery.uploadThumbnail) return "";
  try {
    const png = await context.renderThumbnail(script);
    return png ? await gallery.uploadThumbnail(id, png) : "";
  } catch (error) {
    context.onWarning?.(`thumbnail skipped: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

const newPostId = (): string => globalThis.crypto.randomUUID();

/**
 * Run one `publishShapeScript` call. Throws on a missing session, a missing or
 * invalid source, a limit the gallery would refuse, and on ShapeScript errors
 * — the host's error path reports those to the model as it does for
 * `renderShapeScript`.
 */
export async function executePublishShapeScript(context: PublishShapeScriptContext, args: Record<string, unknown>): Promise<PublishShapeResult> {
  const gallery = context.gallery;
  if (!gallery) throw new Error(NOT_CONNECTED_MESSAGE);
  const title = optionalString(args.title);
  if (!title) throw new Error("`title` is required");
  const { script } = await resolveShapeSource(context, args);
  requireBuildable(script);
  const id = newPostId();
  const thumbnailId = await thumbnailFor(context, gallery, id, script);
  const doc = shapePostFrom(gallery, {
    title,
    script,
    description: optionalString(args.description),
    prompt: optionalString(args.prompt),
    keywords: args.keywords,
    published: args.published !== false,
    thumbnailId,
  });
  await gallery.createPost(id, doc);
  const url = shapePostUrl(id, gallery.siteUrl);
  const state = doc.published ? "Published" : "Saved as a draft (only the user can see it, under My models)";
  const picture = thumbnailId ? "" : " No thumbnail could be attached; the gallery shows a placeholder until the user edits the post.";
  return { message: `${state}: "${doc.title}" is at ${url}.${picture}`, id, url, thumbnail: thumbnailId !== "" };
}
