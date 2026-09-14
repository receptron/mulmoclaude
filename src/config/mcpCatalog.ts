// Curated catalog of pre-configured MCP servers (#823 Phases 1+2).
//
// Goal: a checkbox toggle in Settings → MCP tab that installs / removes
// a known-good server with sane defaults. The general user shouldn't
// have to read a README to wire up Memory or a calendar.
//
// Phase 1 (#825) shipped 2 config-free entries (Memory / Sequential
// Thinking) — Apple-native / Screenshot were explored but dropped
// at merge because no community package was stable enough to pin.
// Phase 2 adds 6 more in the docs / info-gathering / general-task
// buckets and wires up the per-server config form (api keys, paths,
// etc.) — fields described by `configSchema` are interpolated into
// the spec template at install time via `interpolateMcpSpec`.
//
// Selection criteria:
//   - 🟢 catalogue value > Claude Code built-in coverage
//     Built-ins (`Read` / `Write` / `Edit` / `WebFetch` / `WebSearch` /
//     `Bash`) already cover filesystem, fetch, and search; entries
//     duplicating those are out (#823 §"価値マトリクス").
//   - safe defaults: no auth required, or one-time API key the user
//     can paste during install.
//
// **community package names are best-effort** — Slack, Google Maps,
// and Open-Meteo MCPs vary by maintainer activity; PR reviewers
// should pin the exact package + version on merge after checking
// weekly downloads / last commit.

import type { McpServerSpec } from "./mcpTypes";

export interface McpConfigField {
  /** Env var name (stdio) or placeholder name referenced as `${KEY}` in
   *  the spec template (works for url / headers on http too). */
  key: string;
  /** i18n key for the form label above the input. */
  label: string;
  kind: "secret" | "text" | "path" | "url" | "select";
  /** Raw placeholder text shown inside the input. Technical hints like
   *  `sk-…` or `xoxb-…` aren't localised; use `helpText` for prose. */
  placeholder?: string;
  required: boolean;
  /** Direct link to the provider's "how to get this" page. Rendered
   *  next to the label as a 🔑 affordance. */
  helpUrl?: string;
  /** i18n key for inline help text under the field. */
  helpText?: string;
  /** For kind: "select" only. */
  options?: string[];
}

export interface McpCatalogEntry {
  /** Catalog id; also used as `McpServerEntry.id` when installed. */
  id: string;
  /** i18n key for the display name (e.g. "Memory"). */
  displayName: string;
  /** i18n key for a 1-sentence general-user description. */
  description: string;
  /** UI grouping. General is default-expanded; Developer is collapsed. */
  audience: "general" | "developer";
  /** 📦 npm package or GitHub repo — main project page. */
  upstreamUrl: string;
  /** 📚 provider's setup / onboarding guide (optional, often same as upstream). */
  setupGuideUrl?: string;
  /** Server spec template. `${VAR}` placeholders refer to configSchema keys. */
  spec: McpServerSpec;
  /** Per-entry form fields. Phase 1 entries are all empty. */
  configSchema: McpConfigField[];
  /** Coarse risk hint shown as a badge next to the entry name. */
  riskLevel: "low" | "medium" | "high";
}

// Phase 1 ships the two upstream-pinned entries; Phase 2 adds six
// more with `configSchema` form-driven setup. The official
// `@modelcontextprotocol/*` packages are pinned by the upstream
// Anthropic team; community packages added in Phase 2 should be
// re-verified at every release.
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "memory",
    displayName: "settingsMcpTab.catalog.entry.memory.displayName",
    description: "settingsMcpTab.catalog.entry.memory.description",
    audience: "general",
    upstreamUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
    configSchema: [],
    riskLevel: "low",
  },
  {
    id: "sequential-thinking",
    displayName: "settingsMcpTab.catalog.entry.sequentialThinking.displayName",
    description: "settingsMcpTab.catalog.entry.sequentialThinking.description",
    audience: "general",
    upstreamUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
    configSchema: [],
    riskLevel: "low",
  },
  // Apple-native + screenshot entries explored during the #823
  // design were intentionally dropped from Phase 1 (#825) because no
  // community package was stable enough to pin. They land in a
  // follow-up once a maintained package is selected.

  // ── Phase 2 entries (#823) ────────────────────────────────────

  // Library docs lookup. Up-to-date docs for popular libraries
  // fetched at runtime — beats the model's training-cutoff
  // memory for fast-moving frameworks.
  {
    id: "context7",
    displayName: "settingsMcpTab.catalog.entry.context7.displayName",
    description: "settingsMcpTab.catalog.entry.context7.description",
    audience: "general",
    upstreamUrl: "https://github.com/upstash/context7",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    },
    configSchema: [],
    riskLevel: "low",
  },

  // GitHub repo wiki lookup over HTTP. Hosted by Cognition;
  // no install / no auth — the model can ask "what is X repo
  // about" and get a structured summary.
  {
    id: "deepwiki",
    displayName: "settingsMcpTab.catalog.entry.deepwiki.displayName",
    description: "settingsMcpTab.catalog.entry.deepwiki.description",
    audience: "general",
    upstreamUrl: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    spec: {
      type: "http",
      url: "https://mcp.deepwiki.com/sse",
    },
    configSchema: [],
    riskLevel: "low",
  },

  // Notion workspace access. The official Notion MCP server's
  // README marks `NOTION_TOKEN` as the recommended env shape (the
  // older `OPENAPI_MCP_HEADERS` JSON-string form is kept for
  // "advanced use cases"). Switching to NOTION_TOKEN also stops
  // pinning a stale Notion-Version — the server falls back to the
  // current API (2025-09-03 at time of writing) on its own. See
  // https://github.com/makenotion/notion-mcp-server.
  {
    id: "notion",
    displayName: "settingsMcpTab.catalog.entry.notion.displayName",
    description: "settingsMcpTab.catalog.entry.notion.description",
    audience: "general",
    upstreamUrl: "https://github.com/makenotion/notion-mcp-server",
    setupGuideUrl: "https://www.notion.so/help/create-integrations-with-the-notion-api",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: {
        NOTION_TOKEN: "${NOTION_API_KEY}",
      },
    },
    configSchema: [
      {
        key: "NOTION_API_KEY",
        label: "settingsMcpTab.catalog.entry.notion.field.apiKey.label",
        kind: "secret",
        placeholder: "secret_...",
        required: true,
        helpUrl: "https://www.notion.so/my-integrations",
        helpText: "settingsMcpTab.catalog.entry.notion.field.apiKey.help",
      },
    ],
    riskLevel: "medium",
  },

  // Slack channel + message access. TODO(reviewer): the official
  // @modelcontextprotocol/server-slack package is archived but still
  // resolves on npm; check community forks (e.g. mcp-server-slack)
  // for active maintenance before merge.
  {
    id: "slack",
    displayName: "settingsMcpTab.catalog.entry.slack.displayName",
    description: "settingsMcpTab.catalog.entry.slack.description",
    audience: "general",
    upstreamUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    setupGuideUrl: "https://api.slack.com/quickstart",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: {
        SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}",
        SLACK_TEAM_ID: "${SLACK_TEAM_ID}",
      },
    },
    configSchema: [
      {
        key: "SLACK_BOT_TOKEN",
        label: "settingsMcpTab.catalog.entry.slack.field.botToken.label",
        kind: "secret",
        placeholder: "xoxb-...",
        required: true,
        helpUrl: "https://api.slack.com/apps",
        helpText: "settingsMcpTab.catalog.entry.slack.field.botToken.help",
      },
      {
        key: "SLACK_TEAM_ID",
        label: "settingsMcpTab.catalog.entry.slack.field.teamId.label",
        kind: "text",
        placeholder: "T01ABC23DEF",
        required: true,
        helpUrl: "https://api.slack.com/methods/team.info",
        helpText: "settingsMcpTab.catalog.entry.slack.field.teamId.help",
      },
    ],
    riskLevel: "medium",
  },

  // Google Maps — places search + directions. TODO(reviewer):
  // @modelcontextprotocol/server-google-maps is also archived;
  // verify a maintained alternative if a healthier package exists.
  {
    id: "google-maps",
    displayName: "settingsMcpTab.catalog.entry.googleMaps.displayName",
    description: "settingsMcpTab.catalog.entry.googleMaps.description",
    audience: "general",
    upstreamUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps",
    setupGuideUrl: "https://developers.google.com/maps/documentation/javascript/get-api-key",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-google-maps"],
      env: {
        GOOGLE_MAPS_API_KEY: "${GOOGLE_MAPS_API_KEY}",
      },
    },
    configSchema: [
      {
        key: "GOOGLE_MAPS_API_KEY",
        label: "settingsMcpTab.catalog.entry.googleMaps.field.apiKey.label",
        kind: "secret",
        placeholder: "AIza...",
        required: true,
        helpUrl: "https://console.cloud.google.com/google/maps-apis/credentials",
        helpText: "settingsMcpTab.catalog.entry.googleMaps.field.apiKey.help",
      },
    ],
    riskLevel: "low",
  },

  // Weather forecast / current conditions via Open-Meteo. Open-Meteo
  // is keyless for non-commercial use, so this entry is config-free.
  // Apple native apps (macOS only) — bundles Reminders / Calendar /
  // Notes / Mail / Maps / Messages via AppleScript bridges. No
  // credentials needed since it talks to the local system apps; the
  // package no-ops on Linux/Windows. Bundle entry keeps install simple;
  // if per-app granularity is wanted later, split into separate ids.
  //
  // TODO(reviewer): pin the most-active bundle package — as of 2026-04
  // candidates include `apple-mcp` (Dhravya) and per-app variants like
  // `mcp-server-apple-reminders` / `apple-notes-mcp`.
  {
    id: "apple-native",
    displayName: "settingsMcpTab.catalog.entry.appleNative.displayName",
    description: "settingsMcpTab.catalog.entry.appleNative.description",
    audience: "general",
    upstreamUrl: "https://github.com/Dhravya/apple-mcp",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@dhravya/apple-mcp"],
    },
    configSchema: [],
    // Reads + writes Reminders / Notes / Calendar etc. — flagged
    // medium because the agent can modify the user's data, even
    // though no auth secret leaves the box.
    riskLevel: "medium",
  },

  // Gmail read / send / label via a community MCP server. BYO OAuth
  // credentials: the user creates an OAuth client in their own Google
  // Cloud project, downloads `credentials.json`, and points the entry
  // at it. Avoids the verified-app / CASA-audit cost — see plan
  // `plans/done/feat-mcp-catalog-community-expansion.md`.
  //
  // TODO(reviewer): pin the most-active Gmail MCP — as of 2026-04
  // `@gongrzhe/server-gmail-autoauth-mcp` is widely used; alternatives
  // include `mcp-gmail` and Smithery-hosted variants.
  {
    id: "gmail",
    displayName: "settingsMcpTab.catalog.entry.gmail.displayName",
    description: "settingsMcpTab.catalog.entry.gmail.description",
    audience: "general",
    upstreamUrl: "https://github.com/GongRzhe/Gmail-MCP-Server",
    setupGuideUrl: "https://developers.google.com/workspace/guides/create-credentials#desktop-app",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
      env: {
        GMAIL_OAUTH_PATH: "${GMAIL_OAUTH_PATH}",
      },
    },
    configSchema: [
      {
        key: "GMAIL_OAUTH_PATH",
        label: "settingsMcpTab.catalog.entry.gmail.field.credentials.label",
        kind: "path",
        placeholder: "~/.gmail-mcp/credentials.json",
        required: true,
        helpUrl: "https://console.cloud.google.com/apis/credentials",
        helpText: "settingsMcpTab.catalog.entry.gmail.field.credentials.help",
      },
    ],
    // Full mailbox access if the OAuth scope is broad — high.
    riskLevel: "high",
  },

  // Google Calendar via a community MCP server. Same BYO-credentials
  // pattern as Gmail above.
  //
  // TODO(reviewer): pin the most-active GCal MCP — as of 2026-04
  // `@cocal/google-calendar-mcp` is a candidate.
  {
    id: "google-calendar",
    displayName: "settingsMcpTab.catalog.entry.googleCalendar.displayName",
    description: "settingsMcpTab.catalog.entry.googleCalendar.description",
    audience: "general",
    upstreamUrl: "https://github.com/nspady/google-calendar-mcp",
    setupGuideUrl: "https://developers.google.com/workspace/guides/create-credentials#desktop-app",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@cocal/google-calendar-mcp"],
      env: {
        GOOGLE_OAUTH_CREDENTIALS: "${GOOGLE_OAUTH_CREDENTIALS}",
      },
    },
    configSchema: [
      {
        key: "GOOGLE_OAUTH_CREDENTIALS",
        label: "settingsMcpTab.catalog.entry.googleCalendar.field.credentials.label",
        kind: "path",
        placeholder: "~/.gcal-mcp/credentials.json",
        required: true,
        helpUrl: "https://console.cloud.google.com/apis/credentials",
        helpText: "settingsMcpTab.catalog.entry.googleCalendar.field.credentials.help",
      },
    ],
    riskLevel: "medium",
  },

  // Google Drive via the official-style MCP server. Token-cached
  // OAuth — the package writes a refresh token next to the
  // credentials file on first auth.
  //
  // TODO(reviewer): the upstream `@modelcontextprotocol/server-gdrive`
  // was archived; double-check whether to point at the maintained
  // fork or another community package.
  {
    id: "google-drive",
    displayName: "settingsMcpTab.catalog.entry.googleDrive.displayName",
    description: "settingsMcpTab.catalog.entry.googleDrive.description",
    audience: "general",
    upstreamUrl: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/gdrive",
    setupGuideUrl: "https://developers.google.com/workspace/guides/create-credentials#desktop-app",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-gdrive"],
      env: {
        GDRIVE_CREDENTIALS_PATH: "${GDRIVE_CREDENTIALS_PATH}",
      },
    },
    configSchema: [
      {
        key: "GDRIVE_CREDENTIALS_PATH",
        label: "settingsMcpTab.catalog.entry.googleDrive.field.credentials.label",
        kind: "path",
        placeholder: "~/.gdrive-mcp/credentials.json",
        required: true,
        helpUrl: "https://console.cloud.google.com/apis/credentials",
        helpText: "settingsMcpTab.catalog.entry.googleDrive.field.credentials.help",
      },
    ],
    riskLevel: "medium",
  },

  // GitHub repos / issues / PRs / search via the official MCP server.
  // Auth is a single Personal Access Token (classic or fine-grained).
  // Token scope dictates the risk: a `repo` scope can write to any
  // repository the user has access to, so we flag this medium-to-high
  // and tell users to scope down in the help text.
  //
  // TODO(reviewer): pin version. The package has been actively
  // maintained as of 2026-04.
  {
    id: "github",
    displayName: "settingsMcpTab.catalog.entry.github.displayName",
    description: "settingsMcpTab.catalog.entry.github.description",
    audience: "general",
    upstreamUrl: "https://github.com/github/github-mcp-server",
    setupGuideUrl: "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server",
    // Switched stdio (@modelcontextprotocol/server-github) → the
    // provider-hosted remote MCP (#1421 A1). HTTP transport works
    // under the Docker sandbox, where the stdio reference server is
    // dropped (server/agent/config.ts — no npx in the minimal
    // image). PAT auth keeps it OAuth-free; the configSchema key
    // and its i18n are unchanged so installs/migrations stay valid.
    spec: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}",
      },
    },
    configSchema: [
      {
        key: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "settingsMcpTab.catalog.entry.github.field.token.label",
        kind: "secret",
        placeholder: "ghp_…",
        required: true,
        helpUrl: "https://github.com/settings/tokens",
        helpText: "settingsMcpTab.catalog.entry.github.field.token.help",
      },
    ],
    // Token scope is on the user — high if `repo` is granted, low if
    // it's read-only public. Default to medium.
    riskLevel: "medium",
  },

  // Linear issues / projects / cycles via a community MCP server.
  // Auth is a single Linear API key from the user's Linear settings.
  //
  // TODO(reviewer): pin the most-active Linear MCP — as of 2026-04
  // candidates include `@tacticlaunch/mcp-linear` and various
  // smithery-hosted variants.
  {
    id: "linear",
    displayName: "settingsMcpTab.catalog.entry.linear.displayName",
    description: "settingsMcpTab.catalog.entry.linear.description",
    audience: "general",
    upstreamUrl: "https://github.com/tacticlaunch/mcp-linear",
    setupGuideUrl: "https://linear.app/docs/personal-api-keys",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@tacticlaunch/mcp-linear"],
      env: {
        LINEAR_API_KEY: "${LINEAR_API_KEY}",
      },
    },
    configSchema: [
      {
        key: "LINEAR_API_KEY",
        label: "settingsMcpTab.catalog.entry.linear.field.apiKey.label",
        kind: "secret",
        placeholder: "lin_api_…",
        required: true,
        helpUrl: "https://linear.app/settings/api",
        helpText: "settingsMcpTab.catalog.entry.linear.field.apiKey.help",
      },
    ],
    riskLevel: "medium",
  },

  // Open-Meteo weather forecasts. Package switched from the
  // (non-existent on npm) `mcp-server-open-meteo` to `open-meteo-mcp`,
  // verified via `npm view` 2026-04-27. No API key required —
  // Open-Meteo is keyless for non-commercial use.
  {
    id: "weather-open-meteo",
    displayName: "settingsMcpTab.catalog.entry.weatherOpenMeteo.displayName",
    description: "settingsMcpTab.catalog.entry.weatherOpenMeteo.description",
    audience: "general",
    upstreamUrl: "https://www.npmjs.com/package/open-meteo-mcp",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "open-meteo-mcp"],
    },
    configSchema: [],
    riskLevel: "low",
  },

  // Spotify Web API access — search tracks, manage playlists, control
  // playback. Switched from the (non-existent on npm) package
  // `@superseoworld/mcp-spotify` to `spotify-mcp` (calebWei/SpotifyMCP),
  // verified via `npm view` 2026-04-27. Uses PKCE flow — no client
  // secret needed; just a Client ID. Users must run a one-time
  // `npx spotify-mcp@latest auth` to log in (browser window opens, the
  // refresh token is cached at `~/.spotify-mcp/tokens.json`). The
  // help text below points users at that step.
  {
    id: "spotify",
    displayName: "settingsMcpTab.catalog.entry.spotify.displayName",
    description: "settingsMcpTab.catalog.entry.spotify.description",
    audience: "general",
    upstreamUrl: "https://github.com/calebWei/SpotifyMCP",
    setupGuideUrl: "https://developer.spotify.com/documentation/web-api/concepts/apps",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "spotify-mcp@latest"],
      env: {
        SPOTIFY_CLIENT_ID: "${SPOTIFY_CLIENT_ID}",
      },
    },
    configSchema: [
      {
        key: "SPOTIFY_CLIENT_ID",
        label: "settingsMcpTab.catalog.entry.spotify.field.clientId.label",
        kind: "secret",
        placeholder: "spotify-client-id",
        required: true,
        helpUrl: "https://developer.spotify.com/dashboard",
        helpText: "settingsMcpTab.catalog.entry.spotify.field.clientId.help",
      },
    ],
    riskLevel: "medium",
  },

  // YouTube transcript fetcher — give it a video URL and it returns
  // the captions. No auth needed; the package scrapes the public
  // transcript endpoint. Useful for "summarise this YouTube video"
  // workflows where Claude Code's built-in WebFetch can't reach the
  // separate transcript subresource.
  //
  // TODO(reviewer): pin the most-active package — as of 2026-04
  // candidates include `@kimtaeyoon83/mcp-server-youtube-transcript`
  // and `mcp-youtube-transcript`.
  {
    id: "youtube-transcript",
    displayName: "settingsMcpTab.catalog.entry.youtubeTranscript.displayName",
    description: "settingsMcpTab.catalog.entry.youtubeTranscript.description",
    audience: "general",
    upstreamUrl: "https://github.com/kimtaeyoon83/mcp-server-youtube-transcript",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@kimtaeyoon83/mcp-server-youtube-transcript"],
    },
    configSchema: [],
    riskLevel: "low",
  },
  // Japanese station-area open data over HTTP. All 9,273 railway
  // stations in Japan, aggregated by a radius you pick (500 m – 20 km):
  // ridership, population (and its 2040 projection), land price,
  // estimated retail / food sales, businesses and workers, plus flood
  // and landslide hazard zones and live JMA warnings. Read-only, no
  // auth, hosted by the project — nothing to install.
  //
  // Catalogue value over the built-ins: `WebFetch` / `WebSearch` can
  // reach the same government portals, but each one is a separate
  // PDF / viewer with its own units and vintages. This returns one
  // self-describing catalog and a CSV the model can compute on, so
  // "which stations near Yokohama suit a family buying a flat" is
  // answered with numbers rather than recollection.
  //
  // Verified 2026-09-15: `initialize` + `tools/list` over streamable
  // HTTP return 13 tools with no credentials (protocol 2025-06-18).
  {
    id: "ai-database-map",
    displayName: "settingsMcpTab.catalog.entry.aiDatabaseMap.displayName",
    description: "settingsMcpTab.catalog.entry.aiDatabaseMap.description",
    audience: "general",
    upstreamUrl: "https://github.com/kusui26/AI-Database-Map",
    setupGuideUrl: "https://ai-database-map.vercel.app/ai",
    spec: {
      type: "http",
      url: "https://ai-database-map.vercel.app/api/mcp",
    },
    configSchema: [],
    riskLevel: "low",
  },
];

/** Look up by id. Returns null when the id isn't in the catalog
 *  (i.e. the server was added by hand via Custom servers). */
export function findCatalogEntry(entryId: string): McpCatalogEntry | null {
  return MCP_CATALOG.find((entry) => entry.id === entryId) ?? null;
}

/** Set of `${KEY}` names the spec template requires the user to fill. */
export function requiredKeysOf(entry: McpCatalogEntry): Set<string> {
  return new Set(entry.configSchema.filter((field) => field.required).map((field) => field.key));
}
