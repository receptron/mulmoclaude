// The dev server's half of the owner-token handoff (#3627): the connect
// middleware decides, `transformIndexHtml` substitutes. Driven through the
// plugin's real hooks, so a broken AsyncLocalStorage hand-over shows up here.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mulmoclaudeAuthTokenPlugin } from "../../vite.config.js";

const DEV_TOKEN = "dev-token-for-test";
const PAGE = '<meta name="mulmoclaude-auth" content="__MULMOCLAUDE_AUTH_TOKEN__" />';

// What the plugin's middleware reads from a request. The hooks are reached
// through `unknown`, so these fakes need no cast.
interface FakeRequest {
  url: string;
  headers: Record<string, string>;
  rawHeaders: string[];
  socket: { remoteAddress: string };
}
type Middleware = (req: FakeRequest, res: object, next: () => void) => void;
interface Hooks {
  configureServer: (server: unknown) => void;
  transformIndexHtml: (html: string) => string;
}

const isHooks = (plugin: unknown): plugin is Hooks =>
  typeof plugin === "object" &&
  plugin !== null &&
  typeof Reflect.get(plugin, "configureServer") === "function" &&
  typeof Reflect.get(plugin, "transformIndexHtml") === "function";

function loadPlugin(): { middleware: Middleware; transform: (html: string) => string; warnings: string[] } {
  const plugin = mulmoclaudeAuthTokenPlugin();
  assert.ok(isHooks(plugin));
  const warnings: string[] = [];
  const registered: Middleware[] = [];
  plugin.configureServer({
    middlewares: { use: (handler: Middleware) => registered.push(handler) },
    config: { logger: { warn: (message: string) => warnings.push(message) } },
    httpServer: null,
  });
  const [middleware] = registered;
  assert.equal(registered.length, 1);
  assert.ok(middleware);
  return { middleware, transform: (html) => plugin.transformIndexHtml(html), warnings };
}

interface PageLoad {
  url: string;
  remoteAddress: string;
  rawHeaders: string[];
}

function servePage(load: PageLoad): { html: string; warnings: string[] } {
  const { middleware, transform, warnings } = loadPlugin();
  const headers = Object.fromEntries(
    load.rawHeaders.flatMap((value, index, all) => (index % 2 === 0 ? [[value.toLowerCase(), all[index + 1]]] : [])).reverse(),
  );
  const req: FakeRequest = { url: load.url, headers, rawHeaders: load.rawHeaders, socket: { remoteAddress: load.remoteAddress } };
  const page = { html: "" };
  middleware(req, {}, () => {
    page.html = transform(PAGE);
  });
  return { html: page.html, warnings };
}

const LOOPBACK = ["127", "0", "0", "1"].join(".");
const browserLoad = (extra: string[] = []): PageLoad => ({
  url: "/",
  remoteAddress: LOOPBACK,
  rawHeaders: ["Host", "localhost:5173", "Accept", "text/html", ...extra],
});

describe("mulmoclaudeAuthTokenPlugin", () => {
  const saved = { token: process.env.MULMOCLAUDE_AUTH_TOKEN };
  before(() => {
    process.env.MULMOCLAUDE_AUTH_TOKEN = DEV_TOKEN;
  });
  after(() => {
    if (saved.token === undefined) delete process.env.MULMOCLAUDE_AUTH_TOKEN;
    else process.env.MULMOCLAUDE_AUTH_TOKEN = saved.token;
  });

  it("embeds the token for a direct localhost load, without a warning", () => {
    const { html, warnings } = servePage(browserLoad());
    assert.match(html, new RegExp(`content="${DEV_TOKEN}"`));
    assert.deepEqual(warnings, []);
  });

  [
    { name: "a tunnel Host", load: { ...browserLoad(), rawHeaders: ["Host", "abc.trycloudflare.com", "Accept", "text/html"] } },
    { name: "a forwarding header", load: browserLoad(["X-Forwarded-For", "203.0.113.9"]) },
    { name: "a second Host", load: browserLoad(["Host", "public.example"]) },
    { name: "an absolute-form target", load: { ...browserLoad(), url: "http://public.example/" } },
  ].forEach(({ name, load }) => {
    it(`serves ${name} without the token, and says why`, () => {
      const { html, warnings } = servePage(load);
      assert.match(html, /content=""/);
      assert.equal(warnings.length, 1);
    });
  });
});
