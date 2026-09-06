// Built-in plugin registry — single source of truth for "which
// in-tree plugins ship in the bundle".
//
// Each plugin co-locates its TOOL_NAMES key with its Vue entry by
// exporting a `REGISTRATION` (singular) or `REGISTRATIONS` (array,
// for multi-entry plugins like scheduler). The codegen barrel below
// (`_generated/registrations.ts`) discovers them by scanning
// `src/plugins/<name>/index.ts`. External-package plugins (mindmap /
// quiz / googleMap) live in `_extras.ts` because they aren't
// co-located in this source tree.
//
// **Auto-generated**. To add a built-in plugin: drop a new
// `src/plugins/<name>/` directory with an `index.ts` exporting
// `REGISTRATION` (or `REGISTRATIONS`); `yarn plugins:codegen` (run
// automatically via `predev` / `prebuild`) picks it up. This file
// stays unchanged.
//
// Runtime-installed plugins (#1043 C-2) live in a separate registry
// and are merged at lookup time in `src/tools/index.ts:getPlugin`;
// the array below is build-time-bundled only.

import type { PluginRegistration } from "../tools/types";
import { GENERATED_PLUGIN_REGISTRATIONS } from "./_generated/registrations";
import { EXTERNAL_PLUGIN_REGISTRATIONS } from "./_extras";

// `@gui-chat-plugin/weather` is now installed via the user's
// workspace ledger (`~/mulmoclaude/plugins/plugins.json`) rather
// than as a build-time bundle. The View loads via the runtime-plugin
// dynamic-import path; no static import here. (Briefly registered as
// a preset in `server/plugins/preset-list.ts` — that wedged because
// users who'd already installed it via the ledger then saw a
// "name collides" warning on every boot. Until that double-source
// case is handled cleanly, no presets ship by default.)

export const BUILT_IN_PLUGINS: readonly PluginRegistration[] = [...GENERATED_PLUGIN_REGISTRATIONS, ...EXTERNAL_PLUGIN_REGISTRATIONS];
