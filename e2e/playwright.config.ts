import { defineConfig } from "@playwright/test";
import { ONE_SECOND_MS } from "../server/utils/time.ts";
import { E2E_AUTH_TOKEN } from "./fixtures/authToken";

// Every worker drives the SAME Vite dev server on 45173, so the server — not
// the CPU — is the ceiling. Playwright's default (about half the cores) puts
// ~10 browsers on it here, and past this cap they only queue: `page.goto`
// waits on `load` long enough to blow the 30s test timeout, in a different
// spec each run, always as a navigation timeout rather than a failed
// assertion. Measured on one machine, one commit, 10 vs 4 workers:
//
//   loaded   10 → 2 failed, 286s      4 → 456 passed, 278s
//   idle     10 →   0 failed, 245s    4 → 456 passed, 221s
//
// Fewer workers were never slower and never flakier, so the parallelism was
// buying nothing. CI is left on the default: it splits the suite with
// `--shard=N/2` across runners with far fewer cores, so its worker count is
// already below this cap and it has never shown these timeouts.
const LOCAL_MAX_WORKERS = 4;

export default defineConfig({
  testDir: "./tests",
  timeout: 30 * ONE_SECOND_MS,
  retries: 0,
  ...(process.env.CI ? {} : { workers: LOCAL_MAX_WORKERS }),
  // Pre-warm the Vite dev server before tests start so the first
  // navigation per spec doesn't pay Vite's on-demand module-compile cost
  // (which has been flaking `accounting-action-routing` and the
  // `files-path-url` non-ASCII redirect tests). See `./global-setup.ts`.
  globalSetup: "./global-setup.ts",
  use: {
    // E2E runs on a dedicated port so a parallel `yarn dev` on the
    // default 5173 isn't disturbed by Playwright spinning up (or
    // reusing) a Vite instance. If you want to hit the e2e server
    // manually, it's http://localhost:45173 while the test is running.
    baseURL: "http://localhost:45173",
    headless: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "webkit",
      use: { browserName: "webkit" },
      testMatch: "ime-enter.spec.ts",
    },
  ],
  webServer: {
    // `dev:client:e2e` runs `vite --port 45173 --strictPort` so it
    // never collides with the default `yarn dev` on 5173. The user's
    // running dev server stays untouched.
    //
    // `reuseExistingServer: true` — if a previous test run left a
    // Vite on 45173 we reuse it. If something else is squatting the
    // port, `--strictPort` makes Vite fail fast instead of silently
    // hopping to 5175 and leaving Playwright talking to the wrong
    // server.
    command: "yarn dev:client:e2e",
    port: 45173,
    reuseExistingServer: true,
    timeout: 15 * ONE_SECOND_MS,
    // Inject a fixed bearer token into the dev HTML so tests can
    // assert the auth flow end-to-end without touching the real
    // user's `~/mulmoclaude/.session-token`. See
    // vite.config.ts#readDevToken and #272 Phase 1 plan.
    env: { MULMOCLAUDE_AUTH_TOKEN: E2E_AUTH_TOKEN },
  },
});
