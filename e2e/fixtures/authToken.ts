// The bearer token the e2e Vite server injects into index.html
// (`playwright.config.ts` sets `MULMOCLAUDE_AUTH_TOKEN` to it). Specs that
// assert the client presents the token — the `/api/*` header and the
// `/ws/pubsub` handshake — compare against this one value.
export const E2E_AUTH_TOKEN = "e2e-test-token";
