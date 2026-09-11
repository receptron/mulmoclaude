import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/**
 * A story is addressed by the PAIR `(root, filePath)`, everywhere in the host.
 *
 * `stories/deck.json` exists in EVERY registered stories root (#3014), so a host call that
 * resolves a path alone reads the DEFAULT root's file of that name. This rule was patched three
 * times before it was written down — the media-byte download, the session rehydration, and the
 * movie/PDF generation body — so it is stated here as a rule instead of a fourth fix. #3077 then
 * used it to find and close the whole REST surface at once, which is what the rule is for.
 *
 * It is deliberately phrased as what is PERMITTED: a `resolveStory` call names a root, OR it is
 * in `ROOTLESS_BY_DESIGN` below with the reason it cannot have one. Everything else is reported.
 * That direction is the point — a new call site is red by default rather than correct by luck,
 * and the exceptions are a list someone has to justify rather than a silence.
 *
 * It over-reports by construction: a call whose root genuinely does not exist has to be added to
 * the list with a sentence. That is the trade, and it is the right one here, because the failure
 * this guards against is silent — the wrong deck is read and nothing errors.
 *
 * WHAT THIS DOES NOT COVER, said out loud rather than left to be discovered:
 *
 * - It is a TEXTUAL rule over host code under `server/` and `src/`. An aliased or computed call
 *   (`const rs = ops.resolveStory; rs(p)`) would slip past the argument check, so a second test
 *   below forbids naming these ops in any form other than a direct call. An AST rule would be
 *   stronger; this is the version that pays for itself today.
 * - It says nothing about the PACKAGE's own internals — `resolveStory` is defined there, and the
 *   package has its own root contract tests.
 * - A future helper that wraps one of these ops and takes `filePath` without `root` would be
 *   reported where it is WRITTEN, but its callers would not be. Exemptions are therefore kept at
 *   call granularity, never file granularity.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..");
const SEARCHED = ["server", "src"] as const;

/**
 * Every ops entry point that resolves a story, and therefore takes a root.
 *
 * `resolveStory` was the one the first three findings landed on, but it is not the only door:
 * the beat / status / generation ops resolve internally through `runStoryOp`, and reach the same
 * wrong file when the host calls them with a path alone (Codex, round 3 step C-bis).
 */
const ROOT_TAKING_OPS = [
  "resolveStory",
  "beatImageOp",
  "beatAudioOp",
  "beatMovieOp",
  "characterImageOp",
  "movieStatusOp",
  "pdfStatusOp",
  "renderBeatOp",
  "generateBeatAudioOp",
  "renderCharacterOp",
  "uploadBeatImageOp",
  "uploadCharacterImageOp",
] as const;

/**
 * An op call handed a root straight off the REQUEST — `movieStatusOp(p, req.query.root)` and its
 * siblings (Codex, round 5).
 *
 * Narrow on purpose. A request read is unambiguously unparsed; an arbitrary `x.root` may well be
 * an already-parsed root coming out of a helper's result, and telling those apart is provenance,
 * which a regex cannot do. Two widenings were tried and both misfired: every member read
 * (`\\w+\\.root`) reported `const { … root … } = parsed`, and a bare `query.root` reported
 * `beatImageOp(query.filePath, query.beatIndex, query.root)` — where `query` is the PARSED result
 * of `parseBeatQuery`, not `req.query`. Only `req.query.root` / `req.body.root` name the request
 * without ambiguity.
 */
const OPS_RECEIVING_A_REQUEST_ROOT = new RegExp(`\\b(?:${ROOT_TAKING_OPS.join("|")})\\([^;]*?[(,]\\s*req\\.(?:query|body)\\.root\\b`);

/**
 * Call sites that may address a story by path alone, and why.
 *
 * Keyed by `<path-from-repo-root>:<the call's own line text, trimmed>` so moving a file or
 * changing the call breaks the exemption rather than silently carrying it.
 */
const ROOTLESS_BY_DESIGN = new Map<string, string>([
  [
    "server/api/routes/mulmo-script.ts:const resolved = mulmoScriptOps.resolveStory(outcome.filePath);",
    "The AGENT's tool path: this route's body IS `SaveMulmoScriptArgs`, and `root` is deliberately not in the tool schema, so a model cannot name one (#3015). Every save reaching here is in the default root by construction.",
  ],
]);

/**
 * Ops handed to a factory as a VALUE rather than called directly.
 *
 * `makeBeatOpHandler(op, …)` invokes them with a `BeatOpArgs` that carries `root` since #3077, so
 * the root reaches these ops through the factory rather than through an argument list this
 * textual rule can read.
 *
 * What makes that safe rather than a hole is a BEHAVIOURAL test, not this sentence:
 * `test/server/api/test_mulmoScriptBeatOp.ts` → "makeBeatOpHandler — the root it hands the op"
 * asserts the factory forwards a named root, reads an absent or empty one as the default, and
 * REFUSES a wrong-typed one with a 400 without running the op. Delete that suite and these two
 * entries become unchecked.
 */
const OP_VALUES_BY_DESIGN = new Set<string>([
  "server/api/routes/mulmo-script.ts:makeBeatOpHandler(mulmoScriptOps.generateBeatAudioOp, (result) => ({ audio: result.audio })),",
  "server/api/routes/mulmo-script.ts:makeBeatOpHandler(mulmoScriptOps.renderBeatOp, (result) => ({ image: result.image })),",
]);

/** Every `.ts` file under the searched directories. */
function sourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  return SEARCHED.flatMap((dir) => walk(join(REPO_ROOT, dir)));
}

/**
 * Calls to a root-taking op whose arguments never mention a root.
 *
 * The test is "does the argument text name `root`", NOT "is there a second argument": these ops
 * have different arities (`resolveStory(p, root)` but `beatImageOp(p, beatIndex, root)`), and a
 * positional count passed `beatImageOp(filePath, beatIndex)` as though it were rooted — a FALSE
 * NEGATIVE, which is the direction that matters. Naming the token is arity-independent.
 */
function rootlessCalls(): string[] {
  const found: string[] = [];
  sourceFiles().forEach((file) => {
    readFileSync(file, "utf-8")
      .split("\n")
      .forEach((line) => {
        const call = new RegExp(`\\b(?:${ROOT_TAKING_OPS.join("|")})\\(([^;]*)`).exec(line);
        if (!call) return;
        if (!/\broot\b/.test(call[1] ?? "")) found.push(`${relative(REPO_ROOT, file)}:${line.trim()}`);
      });
  });
  return found;
}

describe("a story is addressed by the pair, not the path", () => {
  it("finds the resolveStory call sites at all — a sweep that matches nothing proves nothing", () => {
    const total = sourceFiles().filter((file) => readFileSync(file, "utf-8").includes("resolveStory(")).length;
    assert.ok(total > 0, "at least one file calls resolveStory");
  });

  it("every resolveStory call names a root, or is exempted with a reason", () => {
    const unexplained = rootlessCalls().filter((site) => !ROOTLESS_BY_DESIGN.has(site));
    assert.deepEqual(unexplained, [], `these resolve a story by path alone: ${unexplained.join(" | ")}`);
  });

  it("names these ops only as a direct call — an alias would walk straight past the argument check", () => {
    // `const rs = ops.resolveStory; rs(p)` resolves a story with no root and matches no
    // `resolveStory(` line. Rather than enumerate the spellings, this forbids every mention that
    // is not immediately a call (Codex, round 3 step C-bis).
    const evasions: string[] = [];
    sourceFiles().forEach((file) => {
      readFileSync(file, "utf-8")
        .split("\n")
        .forEach((line) => {
          ROOT_TAKING_OPS.forEach((opName) => {
            if (!new RegExp(`\\b${opName}\\b`).test(line)) return;
            const asDirectCall = new RegExp(`\\b${opName}\\(`).test(line);
            const asImportOrType = /^\s*(import|export)\b/.test(line) || line.includes("//");
            const site = `${relative(REPO_ROOT, file)}:${line.trim()}`;
            if (!asDirectCall && !asImportOrType && !OP_VALUES_BY_DESIGN.has(site)) evasions.push(site);
          });
        });
    });
    assert.deepEqual(evasions, [], `these name a story op without calling it directly: ${evasions.join(" | ")}`);
  });

  it("binds every root it passes from `parseSuppliedRoot`, never from an inline fold", () => {
    // THIRD finding on one rule, so the rule is inverted rather than patched again: the REST
    // readers (round 1), the claims about them (round 2), and the session replay (round 3) each
    // folded a malformed root into the DEFAULT root. Folding is the silent misaddressing
    // `guardSuppliedRoot` was added to dispatch to stop (#3015).
    //
    // Stated as what is PERMITTED, at BINDING level rather than file level: in a file that hands
    // a root to a story op, every `const root`/`const { root }` must be initialised from
    // `parseSuppliedRoot` or `suppliedRoot`. A file-level "does it mention the parser anywhere"
    // check was the first draft and Codex walked past it in four ways — the file's other
    // legitimate parse blinded it to `getOptionalStringQuery(req, "root")` in the same file,
    // which was a live fold in the download routes.
    //
    // KNOWN LIMITS — enumerated rather than implied, because this guard was tightened three
    // times in one review loop and a regex has a ceiling. NOT reported:
    //
    //   1. a root laundered through a helper — in another file OR in THIS one. A function that
    //      takes `root` as a PARAMETER and passes it on is not examined either, and neither is a
    //      root carried inside an intermediate object (`const args = { root: raw }`) and spread
    //      or read at the call (Codex, round 6);
    //   2. an op reached by `ops["movieStatusOp"]`, `?.()`, or an alias;
    //   3. a DESTRUCTURED root — its provenance is not visible here (see below);
    //   4. a root read and passed in one expression other than a direct request read.
    //
    // The real closure for all four is a branded `ParsedStoryRoot` that only `parseSuppliedRoot`
    // can produce, with the host's op wrappers typed to require it — a package signature change,
    // so not this PR. What this DOES assert is the shape every fold in this loop actually took:
    // a direct `const root = <something that is not the parser>`. Comments are stripped before
    // scanning, so a `// parseSuppliedRoot` cannot forge compliance.
    const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const offenders: string[] = [];
    sourceFiles().forEach((file) => {
      const source = stripComments(readFileSync(file, "utf-8"));
      const passesARoot = new RegExp(`\\b(?:${ROOT_TAKING_OPS.join("|")})\\([^;]*\\broot\\b`).test(source);
      if (!passesARoot) return;
      // Every binding of a name `root` in this file has to come from the parser.
      // Two simple alternatives rather than one nested-quantifier pattern: `[^}]*root[^}]*`
      // backtracks super-linearly on a long brace body (sonarjs/super-linear-regex), and a
      // linter finding inside the guard is the guard nobody keeps.
      const bindings = [
        // The optional `: <type>` is not cosmetic: `const root: string | undefined = <fold>` is
        // the very shape this asserts, and without it the annotation alone was enough to hide a
        // fold (Codex, round 7). A type is anything up to the `=` that is not one.
        ...source.matchAll(/(?:const|let|var)\s+root\s*(?::[^=;\n]+)?=\s*([^;\n]*)/g),
        ...source.matchAll(/(?:const|let|var)\s+(\{[^}]*\})\s*=\s*([^;\n]*)/g),
      ].filter((binding) => /\broot\b/.test(binding[0]));
      bindings.forEach((binding) => {
        // A plain `const root = …` carries its initialiser in group 1; a destructure carries the
        // brace body there and the initialiser in group 2.
        const initialiser = binding[2] ?? binding[1] ?? "";
        // A DESTRUCTURE is permitted, and listed as a limit below: `const { filePath, root } =
        // parsed` may be taking an already-parsed root out of a helper's result, and a regex
        // cannot tell that from `= entry.result.data`. Two earlier drafts tried — one trusted the
        // file to mention the parser anywhere, one demanded that no op receive a bare `root` —
        // and each was wrong in its own direction (Codex, rounds 4 and 5). What IS assertable is
        // the direct assignment, and that is where every fold this loop actually found lived.
        const parsed = /\b(parseSuppliedRoot|suppliedRoot)\(/.test(initialiser);
        if (!parsed && !binding[0].includes("{")) offenders.push(`${relative(REPO_ROOT, file)}: ${binding[0].trim()}`);
      });
      // The one member read that needs no provenance chase: straight off the request.
      if (OPS_RECEIVING_A_REQUEST_ROOT.test(source)) {
        offenders.push(`${relative(REPO_ROOT, file)}: an op is handed a root straight off the request`);
      }
    });
    assert.deepEqual(offenders, [], `these bind a root without parsing it: ${offenders.join(" | ")}`);
  });

  it("every exemption still exists — a stale one hides the next real call site", () => {
    const rootless = new Set(rootlessCalls());
    const gone = [...ROOTLESS_BY_DESIGN.keys()].filter((site) => !rootless.has(site));
    assert.deepEqual(gone, [], `these exemptions no longer match any call: ${gone.join(" | ")}`);
  });
});
