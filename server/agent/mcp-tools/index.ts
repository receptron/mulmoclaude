import { Router, Request, Response } from "express";
import { readXPost, searchX } from "@mulmoclaude/x-plugin";
import { notify } from "./notify.js";
import { handlePermission } from "./handlePermission.js";
import { spawnBackgroundChat } from "./spawnBackgroundChat.js";
import { manageCollection } from "./manageCollection.js";
import { renderShapeScript } from "./renderShapeScript.js";
import { exportShapeScriptUsdz } from "./exportShapeScriptUsdz.js";
import { errorMessage } from "../../utils/errors.js";
import { notFound, sendError, serverError } from "../../utils/httpError.js";
import { API_ROUTES } from "../../../src/config/apiRoutes.js";

// Per-call context the MCP bridge threads through to the tool handler.
// Currently just the chat session id (extracted from the `?session=`
// query string the bridge always appends, see mcp-server.ts), so a
// tool like `notify` can mark its outgoing notification with a
// click-target back to the originating chat. Optional because the
// HTTP route is also reachable by non-bridge callers (tests, ad-hoc
// scripts) that have no session.
export interface McpToolContext {
  sessionId?: string;
}

export interface McpTool {
  definition: {
    name: string;
    description: string;
    inputSchema: object;
  };
  requiredEnv?: string[];
  prompt?: string;
  /** When true, the tool is offered to EVERY role regardless of
   *  `role.availablePlugins` — like a built-in (Bash/Read/Write).
   *  `getActiveToolDescriptors` (server/agent/activeTools.ts) skips
   *  the per-role gate for these. Use only for generic host
   *  infrastructure that benefits every role. */
  alwaysActive?: boolean;
  /** Bridge timeout for THIS tool, when the shared `MCP_TOOL_BRIDGE_TIMEOUT_MS`
   *  (sized for external-API calls) is shorter than the work it does. The
   *  bridge must outlast the handler's own budget, or a slow-but-successful
   *  call is aborted in transit and the user sees a timeout for a job that was
   *  about to finish (codex on #3056: renderShapeScript's 60 s render under a
   *  30 s bridge). */
  bridgeTimeoutMs?: number;
  handler: (args: Record<string, unknown>, ctx?: McpToolContext) => Promise<string>;
}

export const mcpTools: McpTool[] = [
  readXPost,
  searchX,
  notify,
  handlePermission,
  spawnBackgroundChat,
  manageCollection,
  renderShapeScript,
  exportShapeScriptUsdz,
];

const toolMap = new Map(mcpTools.map((tool) => [tool.definition.name, tool]));

export function isMcpToolEnabled(tool: McpTool): boolean {
  return (tool.requiredEnv ?? []).every((key) => Boolean(process.env[key]));
}

export const mcpToolsRouter = Router();

interface McpToolParams {
  tool: string;
}

mcpToolsRouter.get(API_ROUTES.mcpTools.list, (_req: Request, res: Response) => {
  res.json(
    mcpTools.map((tool) => ({
      name: tool.definition.name,
      enabled: isMcpToolEnabled(tool),
      requiredEnv: tool.requiredEnv ?? [],
      prompt: tool.prompt,
    })),
  );
});

mcpToolsRouter.post(API_ROUTES.mcpTools.invoke, async (req: Request<McpToolParams, unknown, Record<string, unknown>>, res: Response) => {
  const tool = toolMap.get(req.params.tool);
  if (!tool) {
    notFound(res, `Unknown MCP tool: ${req.params.tool}`);
    return;
  }
  if (!isMcpToolEnabled(tool)) {
    sendError(res, 503, `Tool ${req.params.tool} is not configured.`);
    return;
  }
  try {
    const sessionRaw = typeof req.query.session === "string" ? req.query.session : "";
    const ctx: McpToolContext | undefined = sessionRaw.length > 0 ? { sessionId: sessionRaw } : undefined;
    const result = await tool.handler(req.body, ctx);
    res.json({ result });
  } catch (err) {
    serverError(res, errorMessage(err));
  }
});
