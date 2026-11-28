// Public entry for `@mulmoclaude/accounting-plugin/vue` — the browser
// UI surface (canvas app View + inline chat Preview) plus the
// host-injection seam. Imported by the host's thin plugin shim
// (src/plugins/accounting/index.ts) and standalone page mount, and by
// MulmoTerminal. The host wraps these in its own PluginScopedRoot and
// wires `configureAccountingHost(...)` once at startup.

// The library build EXTRACTS this CSS import into dist/style.css (Tailwind
// utilities compiled from this package's own SFCs). The host imports
// `@mulmoclaude/accounting-plugin/style.css` once — node_modules isn't in
// the host's Tailwind content scan, so the package ships its own classes.
import "../style.css";

import AccountingView from "./View.vue";
import AccountingPreview from "./Preview.vue";

export { AccountingView, AccountingPreview };

export { configureAccountingHost } from "./hostContext";
export { provideAccountingHost, type AccountingTreeHost } from "./treeHost";
export type { AccountingHostContext, AccountingApiCall, AccountingSubscribe, AccountingLocaleTag, ApiResult } from "./hostContext";
