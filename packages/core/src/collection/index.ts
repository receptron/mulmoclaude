// @mulmoclaude/core/collection — isomorphic collection engine.
//
// Pure, framework-free logic shared by the host server (validation /
// derive / notifications) and the host frontend (rendering). Lives in
// @mulmoclaude/core so MulmoClaude and MulmoTerminal share one implementation;
// the Vue surfaces live in @mulmoclaude/collection-plugin/vue.

export * from "./core/schema";
// Type-only: queryZ carries zod, which stays OUT of the browser bundle
// (same rule as schemaZ) — servers import `CollectionQueryZ` via
// `collection/server`; browser code needs only the derived types.
export type { CollectionQuery, CollectionQueryAggregate, CollectionQueryOrder, CollectionQueryWhere } from "./core/queryZ";
export * from "./core/ids";
export * from "./core/collectionKey";
export * from "./core/fieldText";
export * from "./core/fieldDefaults";
export * from "./core/project";
export * from "./core/uiTypes";
export * from "./core/presentCollection";
export * from "./core/enumColors";
export * from "./core/draft";
export * from "./core/actionVisible";
export * from "./core/viewChatPolicy";
export * from "./core/viewFields";
export * from "./core/backlinks";
// The server-time codec. Exported from the PUBLIC subpath because both hosts
// need the decode half: a page's payload is assembled by each host from its own
// read (mulmoserver reads Firestore directly and never passes through
// `collection/server`), and a second implementation of this is the drift this
// module exists to remove.
export * from "./core/serverTime";
export * from "./core/linkTargets";
export * from "./core/where";
export * from "./core/completion";
export * from "./core/chatSeed";
export * from "./core/dynamicIcon";
export * from "./core/iconGlyph";
export * from "./core/accentColor";
export * from "./core/shortcutInfo";
export * from "./core/derivedFormula";
export * from "./core/deriveAll";
export * from "./core/sortItems";
export * from "./core/sortValueOf";
export * from "./core/textSearch";
export * from "./core/recordKeys";
export * from "./core/itemLabel";
export * from "./core/calendarGrid";
export * from "./core/errorMessage";
export * from "./core/itemId";
export * from "./core/promptSafety";
export * from "./core/ontologyGraph";
