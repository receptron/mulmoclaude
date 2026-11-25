// The scaffold's devDependency ranges must match the canonical in-tree plugin,
// or every generated plugin starts on a toolchain the repo has already left.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TEMPLATE_FILES } from "../src/template.js";

const CANONICAL_MANIFEST_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/bookmarks-plugin/package.json");

const DOCUMENTED_TOOLCHAIN = ["@vitejs/plugin-vue", "typescript", "vite", "vite-plugin-dts", "vue"];

// The template is on the 1.x protocol and the canonical plugin on 2.x; moving
// the scaffold across that major is its own decision, not a toolchain sync.
const NOT_SYNCED = new Set(["gui-chat-protocol"]);

type RangeMap = Record<string, string>;

const isRangeMap = (value: unknown): value is RangeMap =>
  typeof value === "object" && value !== null && Object.values(value).every((range) => typeof range === "string");

function devDependenciesOf(manifestText: string, source: string): RangeMap {
  const manifest: unknown = JSON.parse(manifestText);
  const devDependencies = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "devDependencies") : undefined;
  assert.ok(isRangeMap(devDependencies), `no devDependencies map in ${source}`);
  return devDependencies;
}

async function loadBoth(): Promise<{ template: RangeMap; canonical: RangeMap }> {
  const templatePackage = TEMPLATE_FILES.find((entry) => entry.path === "package.json");
  assert.ok(templatePackage);
  const canonicalText = await readFile(CANONICAL_MANIFEST_PATH, "utf8");
  return {
    template: devDependenciesOf(templatePackage.content, "template package.json"),
    canonical: devDependenciesOf(canonicalText, CANONICAL_MANIFEST_PATH),
  };
}

describe("template devDependencies — synced with bookmarks-plugin", () => {
  it("declares every documented toolchain dep on both sides", async () => {
    const { template, canonical } = await loadBoth();
    DOCUMENTED_TOOLCHAIN.forEach((name) => {
      assert.ok(Object.hasOwn(template, name), `template is missing ${name}`);
      assert.ok(Object.hasOwn(canonical, name), `bookmarks-plugin is missing ${name}`);
    });
  });

  it("uses the canonical range for every dep both declare", async () => {
    const { template, canonical } = await loadBoth();
    const shared = Object.keys(template).filter((name) => Object.hasOwn(canonical, name) && !NOT_SYNCED.has(name));
    const drifted = shared
      .filter((name) => template[name] !== canonical[name])
      .map((name) => `${name}: template ${template[name]} vs bookmarks-plugin ${canonical[name]}`);
    assert.deepEqual(drifted, []);
  });
});
