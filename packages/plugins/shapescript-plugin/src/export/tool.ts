// The `exportShapeScriptUsdz` TOOL: schema, description and what one call does.
//
// Like `renderShapeScript` it lives in the package so the parts a MODEL sees
// cannot drift between hosts. Unlike it, nothing here is host-shaped: reading
// a `.shape` and writing the `.usdz` both go through the generic
// gui-chat-protocol `files` capability the dispatch router already uses, so a
// host wires this tool with the SAME `{ files }` context it built for
// `executeShapeScriptDispatch` — no new file layer, no browser, no `node:*`.

import { locateShape, type ShapeScriptDispatchContext } from "../core/dispatch";
import { usdzArtifactPath } from "../core/paths";
import { DEFAULT_MAX_DURATION_MS } from "../shapescript/toThreeJS";
import { shapeScriptToUsdz } from "./usdz";

export const EXPORT_USDZ_TOOL_NAME = "exportShapeScriptUsdz";

/** Milliseconds a host must allow this tool before its own transport gives up.
 *  Conversion may legitimately spend its whole `DEFAULT_MAX_DURATION_MS` on a
 *  near-limit model, and serialising the result to USDZ (plus the write) comes
 *  AFTER that — a transport sized to the conversion alone aborts an export that
 *  was about to succeed, exactly as #3056 found for `renderShapeScript`. */
export const EXPORT_USDZ_TOOL_TIMEOUT_MS = DEFAULT_MAX_DURATION_MS + 30_000;

export const EXPORT_USDZ_DESCRIPTION =
  "Export a ShapeScript model to a USDZ file (Apple's AR / 3D format, openable with AR Quick Look on iPhone, iPad and Mac) and save it under artifacts/shapes/. Returns the saved path. Takes the same source as presentShapeScript: inline `script`, or `path` to a saved .shape file. USDZ units are metres, so a `size 1` cube becomes a one-metre object in AR — scale the model in the script if that is not what the user wants.";

export const EXPORT_USDZ_PROMPT =
  "Use exportShapeScriptUsdz when the user wants to take a 3D model out of the chat — to view it in AR, open it in a 3D app, or share the file. It saves a .usdz next to the model's .shape file and returns the path; tell the user where it is. The user can also press \"Download USDZ\" in the model's view themselves.";

/** The tool's JSON schema, in the shape both a gui-chat-protocol `ToolDefinition`
 *  (`parameters`) and an MCP tool (`inputSchema`) take. */
export const EXPORT_USDZ_SCHEMA = {
  type: "object" as const,
  properties: {
    script: {
      type: "string",
      description: "ShapeScript source to export. Provide either this or `path`, not both.",
    },
    path: {
      type: "string",
      description: "Path to an existing .shape file to export (e.g. one presentShapeScript saved under artifacts/shapes/).",
    },
    title: {
      type: "string",
      description: "Name for the exported file; it is slugified into the filename. Defaults to the .shape file's own name when `path` is given.",
    },
  },
  required: [] as string[],
};

/** What one call did: the sentence the agent reads, and the path for a host
 *  that wants to log or link it. */
export interface ExportUsdzResult {
  message: string;
  /** Workspace-relative, `artifacts/shapes/<slug>-<epoch>-<token>.usdz`. */
  filePath: string;
  bytes: number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The basename of a source path without its extension — the natural title of
 *  an export made from a file the user already named. */
function stemOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace(/\.shape$/i, "");
}

async function resolveSource(context: ShapeScriptDispatchContext, args: Record<string, unknown>): Promise<{ script: string; title: string | undefined }> {
  const script = optionalString(args.script);
  const filePath = optionalString(args.path);
  const title = optionalString(args.title);
  if (script && filePath) throw new Error("Provide either `script` or `path`, not both");
  if (script) return { script, title };
  if (!filePath) throw new Error("Provide either `script` (inline source) or `path` (an existing .shape file)");
  const target = locateShape(context, filePath);
  if (!target) throw new Error("`path` must name a .shape file, without `.` / `..` segments");
  if (!(await target.files.exists(target.rel))) throw new Error(`No ShapeScript exists at ${filePath}`);
  return { script: await target.files.read(target.rel), title: title ?? stemOf(filePath) };
}

/**
 * Run one `exportShapeScriptUsdz` call. Throws on a missing / invalid source
 * and on ShapeScript errors — the host's own error path reports those to the
 * model, exactly as it does for `renderShapeScript`.
 */
export async function executeExportShapeScriptUsdz(context: ShapeScriptDispatchContext, args: Record<string, unknown>): Promise<ExportUsdzResult> {
  const { script, title } = await resolveSource(context, args);
  const bytes = await shapeScriptToUsdz(script);
  const { relPath, filePath } = usdzArtifactPath(title);
  await context.files.artifacts.write(relPath, bytes);
  return {
    message: `Saved USDZ to ${filePath} (${bytes.byteLength} bytes). Open it with AR Quick Look or any USD viewer.`,
    filePath,
    bytes: bytes.byteLength,
  };
}
