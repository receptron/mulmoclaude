import { createUseT } from "gui-chat-protocol/vue";
import type { Messages } from "./messages";
import de from "./de";
import en from "./en";
import es from "./es";
import fr from "./fr";
import ja from "./ja";
import ko from "./ko";
import ptBR from "./ptBR";
import zh from "./zh";

const MESSAGES = { de, en, es, fr, ja, ko, "pt-BR": ptBR, zh } as const;

/** Reactive message bundle for the active host locale. The plugin carries its
 *  own translations (no host i18n dependency); it reads the locale off the
 *  injected `BrowserPluginRuntime.locale` ref and falls back to English. */
export const useT = createUseT(MESSAGES);

export type { Messages };
