// Which workspace `yarn dev`'s client half is looking at (#2981).
//
// Both halves of the dev client read files out of the workspace — `vite.config.ts`
// takes the session token from it, and the readiness wait takes the published
// port — so they have to agree on WHERE it is. They did not: the config matched
// `^MULMOCLAUDE_WORKSPACE_PATH=(.+)$` by hand while the wait used the launcher's
// `dotenv.parse`. For `MULMOCLAUDE_WORKSPACE_PATH="/tmp/ws"  # scratch` the hand
// match keeps the quotes and the comment, so the two look in different places
// and the config finds neither the token nor the port (Codex, #2981).
//
// Same failure as the one `devServerPort.ts` exists to prevent, one value over:
// a second opinion about what `.env` says. So the rule is borrowed rather than
// written — it lives in `server/utils/workspace-path.mjs`, which the npm
// launcher can also reach (it boots before tsx, so it cannot import this file).
export type { WorkspacePathSources as DevWorkspaceSources } from "../../server/utils/workspace-path.d.mts";
export { resolveWorkspacePath as resolveDevWorkspacePath } from "../../server/utils/workspace-path.mjs";
