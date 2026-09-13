// Tests for `server/utils/launcher/messages.mjs` — the icon launcher's
// standalone message catalog. It cannot use vue-i18n (it runs before the
// server exists), so nothing else enforces the "all 8 locales in
// lockstep" rule from docs/i18n.md for it. These tests do.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LAUNCHER_LOCALES, fillPlaceholders, launcherMessages, pickLauncherLocale } from "../../../server/utils/launcher/messages.mjs";

const keyPaths = (value: unknown, prefix = ""): string[] => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => keyPaths(child, prefix === "" ? key : `${prefix}.${key}`));
};

describe("launcher message catalog", () => {
  it("covers the same 8 locales as the app UI", () => {
    assert.deepEqual([...LAUNCHER_LOCALES].sort(), ["de", "en", "es", "fr", "ja", "ko", "pt-BR", "zh"]);
  });

  it("has identical key structure in every locale", () => {
    const expected = keyPaths(launcherMessages("en")).sort();
    LAUNCHER_LOCALES.forEach((locale) => {
      assert.deepEqual(keyPaths(launcherMessages(locale)).sort(), expected, `locale ${locale} key mismatch`);
    });
  });

  it("has no empty string anywhere", () => {
    LAUNCHER_LOCALES.forEach((locale) => {
      const flat = JSON.stringify(launcherMessages(locale));
      assert.ok(!flat.includes('""'), `locale ${locale} has an empty value`);
    });
  });

  it("keeps every failure actionable — a title and body are useless without a next step", () => {
    const failures = ["nodeMissing", "nodeTooOld", "npxMissing", "claudeMissing", "startFailed", "noPort"] as const;
    LAUNCHER_LOCALES.forEach((locale) => {
      const messages = launcherMessages(locale);
      failures.forEach((key) => {
        assert.ok(messages[key].title.length > 0, `${locale}.${key}.title`);
        assert.ok(messages[key].body.length > 0, `${locale}.${key}.body`);
        assert.ok(messages[key].action.length > 0, `${locale}.${key}.action`);
      });
    });
  });

  it("carries the same placeholders in every locale", () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    LAUNCHER_LOCALES.forEach((locale) => {
      const messages = launcherMessages(locale);
      assert.deepEqual(placeholders(messages.nodeTooOld.body), ["{found}", "{required}"], `${locale}.nodeTooOld`);
      assert.deepEqual(placeholders(messages.startFailed.body), ["{seconds}"], `${locale}.startFailed`);
      assert.deepEqual(placeholders(messages.noPort.body), ["{port}"], `${locale}.noPort`);
    });
  });

  it("keeps the install commands verbatim — a translated command is a broken command", () => {
    LAUNCHER_LOCALES.forEach((locale) => {
      assert.deepEqual(launcherMessages(locale).claudeMissing.steps, ["npm install -g @anthropic-ai/claude-code", "claude"], locale);
    });
  });
});

describe("pickLauncherLocale", () => {
  it("accepts what macOS and Windows actually report", () => {
    assert.equal(pickLauncherLocale("ja_JP"), "ja");
    assert.equal(pickLauncherLocale("ja-JP"), "ja");
    assert.equal(pickLauncherLocale("pt_BR"), "pt-BR");
    assert.equal(pickLauncherLocale("pt-br"), "pt-BR");
    assert.equal(pickLauncherLocale("zh_Hans_CN"), "zh");
    assert.equal(pickLauncherLocale("zh-Hans_US"), "zh");
  });

  it("gives a language its shipped regional variant rather than English", () => {
    assert.equal(pickLauncherLocale("pt"), "pt-BR");
    assert.equal(pickLauncherLocale("pt_PT"), "pt-BR");
  });

  it("falls back to English instead of throwing", () => {
    assert.equal(pickLauncherLocale("kl_GL"), "en");
    assert.equal(pickLauncherLocale(""), "en");
    assert.equal(pickLauncherLocale(undefined), "en");
    assert.equal(pickLauncherLocale(null), "en");
  });
});

describe("fillPlaceholders", () => {
  it("substitutes known keys", () => {
    assert.equal(fillPlaceholders("needs {required}, found {found}", { required: "22.19", found: "v18.0.0" }), "needs 22.19, found v18.0.0");
  });

  it("leaves an unknown placeholder visible rather than rendering undefined", () => {
    assert.equal(fillPlaceholders("port {port} and {typo}", { port: 3001 }), "port 3001 and {typo}");
  });
});
