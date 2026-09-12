// The port/int coercion rule now lives in `@mulmoclaude/common` (#3084): the
// messaging bridges need the same rule, and `@mulmobridge/*` cannot import from
// `server/`. This module stays as the server-side door to it — `vite.config.ts`
// reaches it through `scripts/lib/devServerPort.ts`, and `tsconfig.node.json`
// includes this exact path, so moving the file itself would drag the dev proxy's
// resolution along with it.
export { asInt, PORT_RANGE, type IntRange } from "@mulmoclaude/common";

/** The port the backend binds when `PORT` says nothing usable. Not shared: it is
 *  the host's own default, not part of the coercion rule. */
export const DEFAULT_PORT = 3001;
