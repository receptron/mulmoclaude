// Unit tests for the pure helpers in `server/api/routes/files.ts`.
//
// This file accumulates tests across several security-hardening
// PRs:
//   #146 — `parseRange` (zero-byte crash fix) + `classify`
//   #147 — `RAW_SECURITY_HEADERS` (CSP sandbox pin)
//   #148 — `isSensitivePath` (.env + secrets denylist)
//
// `parseRange` is the most security-sensitive piece — a naive
// implementation crashes the server on `bytes=-N` against a
// zero-byte file because Node's `fs.createReadStream({end: -1})`
// throws ERR_OUT_OF_RANGE synchronously. The whole function is
// covered here including the zero-byte edge case.
//
// `classify` is simpler but regresses easily when a new extension
// is added in the wrong set — keep the table honest.
//
// `isSensitivePath` keeps workspace secrets (.env, SSH keys, TLS
// certs, credentials files) off the HTTP surface.
//
// `RAW_SECURITY_HEADERS` pins the exact CSP strings so a silent
// edit can't reopen the XSS surface.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRange,
  classify,
  isSensitivePath,
  RAW_SECURITY_HEADERS,
  RAW_SECURITY_HEADERS_NO_SANDBOX,
  isSandboxExemptMime,
  rawSecurityHeadersForMime,
} from "../../server/api/routes/files.js";

describe("parseRange — happy path", () => {
  it("parses a basic start-end range", () => {
    assert.deepEqual(parseRange("bytes=0-99", 200), { start: 0, end: 99 });
  });

  it("parses an open-ended start-end range", () => {
    assert.deepEqual(parseRange("bytes=100-", 200), { start: 100, end: 199 });
  });

  it("parses a start-end range covering just the last byte", () => {
    assert.deepEqual(parseRange("bytes=199-199", 200), {
      start: 199,
      end: 199,
    });
  });

  it("parses a start-end range covering the whole file", () => {
    assert.deepEqual(parseRange("bytes=0-199", 200), { start: 0, end: 199 });
  });

  it("parses a suffix range that fits inside the file", () => {
    assert.deepEqual(parseRange("bytes=-50", 200), { start: 150, end: 199 });
  });

  it("clamps a suffix range longer than the file to the whole file", () => {
    // RFC 7233: a suffix-length longer than the representation → whole thing.
    assert.deepEqual(parseRange("bytes=-500", 30), { start: 0, end: 29 });
  });

  it("parses a single-byte suffix", () => {
    assert.deepEqual(parseRange("bytes=-1", 10), { start: 9, end: 9 });
  });

  it("accepts case-insensitive token (defensive — browsers send lowercase)", () => {
    assert.deepEqual(parseRange("BYTES=0-99", 200), { start: 0, end: 99 });
    assert.deepEqual(parseRange("Bytes=0-99", 200), { start: 0, end: 99 });
  });

  it("accepts leading/trailing whitespace", () => {
    assert.deepEqual(parseRange("  bytes=0-99  ", 200), { start: 0, end: 99 });
  });
});

describe("parseRange — unsatisfiable ranges (returns null for 416)", () => {
  it("rejects start >= size", () => {
    assert.equal(parseRange("bytes=200-300", 200), null);
  });

  it("rejects end >= size (inclusive check)", () => {
    assert.equal(parseRange("bytes=0-200", 200), null);
  });

  it("rejects start > end", () => {
    assert.equal(parseRange("bytes=100-50", 200), null);
  });

  it("rejects past-EOF start with open end", () => {
    // bytes=200- with size=200: end = 199, start = 200, end < start → null
    assert.equal(parseRange("bytes=200-", 200), null);
  });
});

describe("parseRange — malformed input (returns null)", () => {
  it("rejects multi-range requests", () => {
    assert.equal(parseRange("bytes=0-99,200-299", 500), null);
  });

  it("rejects non-numeric values", () => {
    assert.equal(parseRange("bytes=abc-def", 200), null);
  });

  it("rejects the wrong unit token", () => {
    assert.equal(parseRange("pixels=0-99", 200), null);
  });

  it("rejects an entirely empty spec", () => {
    assert.equal(parseRange("bytes=-", 200), null);
  });

  it("rejects a missing range body", () => {
    assert.equal(parseRange("bytes=", 200), null);
  });

  it("rejects a zero-length suffix", () => {
    // bytes=-0 is malformed per RFC 7233 §2.1 (suffix-length must be > 0).
    assert.equal(parseRange("bytes=-0", 200), null);
  });

  it("rejects a negative-looking start", () => {
    // -99-199 fails the regex (\d* doesn't match `-`)
    assert.equal(parseRange("bytes=-99-199", 200), null);
  });

  it("rejects garbage wrapping a valid-looking range", () => {
    assert.equal(parseRange("x bytes=0-99", 200), null);
    assert.equal(parseRange("bytes=0-99 junk", 200), null);
  });
});

describe("parseRange — zero-byte file (regression: PR #134 review)", () => {
  // A naive suffix-range implementation produces {start: 0, end: -1}
  // for a zero-byte file, which then crashes `fs.createReadStream`
  // synchronously with `ERR_OUT_OF_RANGE`. This was a live 500-error
  // bug on the PR; the regression test below pins every flavor of
  // range spec against size=0 so it can't creep back.

  it("rejects a suffix range on a zero-byte file (the bug)", () => {
    assert.equal(parseRange("bytes=-1", 0), null);
    assert.equal(parseRange("bytes=-100", 0), null);
  });

  it("rejects a start-end range on a zero-byte file", () => {
    assert.equal(parseRange("bytes=0-0", 0), null);
    assert.equal(parseRange("bytes=0-", 0), null);
  });

  it("rejects any range on a zero-byte file uniformly", () => {
    for (const header of ["bytes=0-0", "bytes=0-", "bytes=-1", "bytes=-100", "bytes=0-99"]) {
      assert.equal(parseRange(header, 0), null, `expected null for ${header} on empty file`);
    }
  });
});

describe("parseRange — integer / precision boundaries", () => {
  it("accepts very large finite numbers that are still in-range", () => {
    // Double-precision can represent integers up to 2^53 exactly. A
    // 50 MB file is far below that, but the parser shouldn't choke
    // on big numbers per se — only on ones that fall outside the
    // file bounds.
    assert.deepEqual(parseRange("bytes=0-49", 50), { start: 0, end: 49 });
  });

  it("rejects very large out-of-range numbers", () => {
    assert.equal(parseRange("bytes=9999-99999", 200), null);
  });
});

describe("classify", () => {
  it("classifies common audio extensions", () => {
    for (const name of ["foo.mp3", "foo.wav", "foo.m4a", "foo.ogg", "foo.oga", "foo.flac", "foo.aac"]) {
      assert.equal(classify(name), "audio", `expected audio for ${name}`);
    }
  });

  it("classifies common video extensions", () => {
    for (const name of ["foo.mp4", "foo.webm", "foo.mov", "foo.m4v", "foo.ogv"]) {
      assert.equal(classify(name), "video", `expected video for ${name}`);
    }
  });

  it("is case-insensitive on the extension", () => {
    assert.equal(classify("SONG.MP3"), "audio");
    assert.equal(classify("MOVIE.MP4"), "video");
    assert.equal(classify("Photo.PNG"), "image");
  });

  it("classifies PDFs", () => {
    assert.equal(classify("doc.pdf"), "pdf");
  });

  it("classifies images", () => {
    for (const name of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.svg"]) {
      assert.equal(classify(name), "image");
    }
  });

  it("classifies common text extensions", () => {
    for (const name of ["README.md", "notes.txt", "data.json", "config.yaml", "index.ts", "app.vue"]) {
      assert.equal(classify(name), "text");
    }
  });

  it("classifies the whole subtitle family as text (#3213)", () => {
    for (const name of ["talk.srt", "talk.vtt", "talk.ass", "talk.ssa", "talk.sbv", "song.lrc", "TALK.SRT"]) {
      assert.equal(classify(name), "text", `expected text for ${name}`);
    }
  });

  it("classifies the plain-text docs, config, source and script extensions as text", () => {
    const names = [
      "notes.mdx",
      "notes.text",
      "guide.rst",
      "guide.adoc",
      "guide.asciidoc",
      "paper.tex",
      "tsconfig.jsonc",
      "conf.json5",
      "pyproject.toml",
      "setup.ini",
      "tool.cfg",
      "nginx.conf",
      "app.properties",
      "feed.xml",
      "rows.tsv",
      "bundle.mjs",
      "bundle.cjs",
      "types.mts",
      "types.cts",
      "Widget.svelte",
      "page.astro",
      "theme.scss",
      "theme.sass",
      "theme.less",
      "main.rb",
      "main.go",
      "main.rs",
      "Main.java",
      "Main.kt",
      "build.kts",
      "main.c",
      "main.h",
      "main.cpp",
      "main.cc",
      "main.hpp",
      "Main.cs",
      "index.php",
      "main.swift",
      "Main.scala",
      "init.lua",
      "main.dart",
      "script.pl",
      "analysis.r",
      "mod.ex",
      "mod.exs",
      "schema.sql",
      "schema.graphql",
      "schema.gql",
      "run.bash",
      "run.zsh",
      "run.fish",
      "run.ps1",
      "run.bat",
      "run.cmd",
      "change.diff",
      "change.patch",
      "yarn.lock",
      "sub.dockerignore",
      "sub.editorconfig",
      // Found by surveying a real workspace: both read as "binary" before.
      "schema.xsd",
      "bundle.js.map",
      "firestore.rules",
      "stonehenge.shape",
      "scrape.utf8",
      // Feeds, calendars and geo data — the workspace has a feeds/ tree and
      // the product has calendar and maps features.
      "feed.rss",
      "feed.atom",
      "subs.opml",
      "site.webmanifest",
      "trip.ics",
      "card.vcf",
      "track.gpx",
      "places.kml",
      "shape.geojson",
      "notebook.ipynb",
      "api.proto",
      "page.hbs",
      "page.ejs",
      "page.pug",
      "main.tf",
      "config.nix",
      "build.gradle",
      "CMakeLists.cmake",
      "list.m3u8",
      "album.cue",
    ];
    for (const name of names) {
      assert.equal(classify(name), "text", `expected text for ${name}`);
    }
  });

  it("treats files with no extension as text (README, LICENSE, etc.)", () => {
    assert.equal(classify("README"), "text");
    assert.equal(classify("LICENSE"), "text");
    assert.equal(classify(""), "text");
  });

  it("classifies unknown extensions as binary", () => {
    assert.equal(classify("archive.zip"), "binary");
    assert.equal(classify("data.bin"), "binary");
    assert.equal(classify("font.ttf"), "binary");
  });

  it("classifies the browser-renderable image formats the attachment store writes", () => {
    for (const name of ["shot.bmp", "shot.avif", "favicon.ico"]) {
      assert.equal(classify(name), "image", `expected image for ${name}`);
    }
  });

  it("leaves the image formats no browser renders as binary", () => {
    // Downloadable via the fallback, but there is nothing to preview them
    // with, so claiming `image` would render a broken <img>.
    for (const name of ["photo.heic", "photo.heif", "scan.tif", "scan.tiff"]) {
      assert.equal(classify(name), "binary", `expected binary for ${name}`);
    }
  });

  it("keeps VobSub `.sub` out of the text set — the name cannot tell it from MicroDVD", () => {
    // A `.sub` beside an `.idx` is bitmap subtitle data. Classifying it text
    // decodes the bitmap as UTF-8 in the preview, and a saved edit would write
    // that back over the bitmap.
    assert.equal(classify("movie.sub"), "binary");
  });

  it("keeps real binaries out of the widened text set", () => {
    for (const name of ["book.xlsx", "deck.pptx", "report.docx", "archive.tar.gz", "installer.exe", "lib.so", "photo.heic"]) {
      assert.equal(classify(name), "binary", `expected binary for ${name}`);
    }
  });

  it("keeps the Terraform and keystore secret formats out of the text set", () => {
    for (const name of ["prod.auto.tfvars", "terraform.tfstate", "client.p12", "client.pfx", "app.jks", "debug.keystore"]) {
      assert.equal(classify(name), "binary", `expected binary for ${name}`);
    }
  });

  it("keeps credential-shaped extensions out of the text set", () => {
    // `isSensitivePath` refuses these before classify is consulted, but a
    // stray entry in TEXT_EXTENSIONS would make them editable through the
    // write routes, which gate on classify alone.
    for (const name of ["server.pem", "server.key", "server.crt", "project.npmrc", "home.netrc"]) {
      assert.equal(classify(name), "binary", `expected binary for ${name}`);
    }
  });

  it("uses the LAST extension when multiple dots are present", () => {
    // path.extname semantics.
    assert.equal(classify("report.final.pdf"), "pdf");
    assert.equal(classify("jingle.txt.mp3"), "audio");
    assert.equal(classify("archive.tar.gz"), "binary");
  });

  it("handles paths with directories", () => {
    assert.equal(classify("/path/to/song.mp3"), "audio");
    assert.equal(classify("dir\\windows\\file.png"), "image");
  });
});

describe("RAW_SECURITY_HEADERS", () => {
  // These tests don't exercise Express — supertest isn't in the
  // dependency tree — but they pin the exact header strings down.
  // Silently dropping the CSP header would reopen the SVG / HTML /
  // PDF-with-JS XSS surface documented in
  // plans/done/fix-files-raw-csp-sandbox.md.

  it("sets Content-Security-Policy to `sandbox` (no allow flags)", () => {
    // The bare `sandbox` directive is the strictest setting — it
    // creates an opaque origin, blocks scripts, forms, and
    // same-origin access. If a future edit weakens this to
    // `sandbox allow-scripts` or similar, this assertion fires.
    assert.equal(RAW_SECURITY_HEADERS["Content-Security-Policy"], "sandbox");
  });

  it("sets X-Content-Type-Options to nosniff", () => {
    assert.equal(RAW_SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
  });

  it("does not set any allow-listing header that would defeat sandbox", () => {
    // Guardrails: if someone adds a future header that opens the
    // sandbox back up, this catches it early.
    assert.equal(RAW_SECURITY_HEADERS["Access-Control-Allow-Origin"], undefined);
    assert.equal(RAW_SECURITY_HEADERS["Cross-Origin-Resource-Policy"], undefined);
  });
});

describe("RAW_SECURITY_HEADERS_NO_SANDBOX — the PDF (#1299) and media (#3437) carve-out", () => {
  // WebKit refuses to render `Content-Security-Policy: sandbox` PDFs
  // and forces a download; Chrome's media page re-fetches a sandboxed
  // audio / video file from the `null` origin and CORS blocks it.
  // Neither can run script in the document that shows it, so the
  // response CSP is dropped and only `nosniff` stays. These tests pin
  // the carve-out so a future "let's just apply the CSP to
  // everything" refactor can't silently regress either issue.

  it("does NOT set Content-Security-Policy", () => {
    assert.equal(RAW_SECURITY_HEADERS_NO_SANDBOX["Content-Security-Policy"], undefined);
  });

  it("still sets X-Content-Type-Options nosniff", () => {
    // Keeping `nosniff` prevents the file being re-interpreted as HTML
    // even if a misbehaving server (or proxy) drops Content-Type.
    assert.equal(RAW_SECURITY_HEADERS_NO_SANDBOX["X-Content-Type-Options"], "nosniff");
  });

  it("does not set any allow-listing header either", () => {
    // Dropping the sandbox is not the same as opening the file to other
    // origins: a CORS header here would let any page read workspace files.
    assert.equal(RAW_SECURITY_HEADERS_NO_SANDBOX["Access-Control-Allow-Origin"], undefined);
    assert.equal(RAW_SECURITY_HEADERS_NO_SANDBOX["Cross-Origin-Resource-Policy"], undefined);
  });
});

// Every audio / video MIME the route's MIME_BY_EXT table can emit.
const MEDIA_MIMES = [
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/ogg",
  "audio/flac",
  "audio/aac",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "video/ogg",
];
// SVG and HTML are the original threat shapes the sandbox CSP was
// added to defend (plans/done/fix-files-raw-csp-sandbox.md); the rest
// are other types a file route could plausibly emit.
const SANDBOXED_MIMES = ["image/svg+xml", "text/html", "image/png", "image/gif", "text/plain", "text/markdown", "application/json", "application/octet-stream"];
// Near-misses: a prefix or a substring is not a match.
const NEAR_MISS_MIMES = ["application/x-pdf", "application/pdf+xml", "audiox/mpeg", "application/audio", "audio", "video", "x-audio/mpeg", "image/video"];

describe("isSandboxExemptMime", () => {
  it("exempts application/pdf", () => {
    assert.equal(isSandboxExemptMime("application/pdf"), true);
  });

  it("exempts every audio and video MIME the route can emit", () => {
    MEDIA_MIMES.forEach((mime) => assert.equal(isSandboxExemptMime(mime), true, `expected no sandbox for ${mime}`));
  });

  it("keeps the sandbox for images, text, markup and unknown types", () => {
    SANDBOXED_MIMES.forEach((mime) => assert.equal(isSandboxExemptMime(mime), false, `expected sandbox for ${mime}`));
  });

  it("keeps the sandbox for near-miss MIMEs", () => {
    // Strict matches only: the route's MIME_BY_EXT emits the canonical
    // forms, so anything else is a hardening assertion.
    NEAR_MISS_MIMES.forEach((mime) => assert.equal(isSandboxExemptMime(mime), false, `expected sandbox for ${mime}`));
  });

  it("is case-sensitive, as the MIME table is lowercase", () => {
    assert.equal(isSandboxExemptMime("AUDIO/MPEG"), false);
    assert.equal(isSandboxExemptMime("Application/PDF"), false);
  });
});

describe("rawSecurityHeadersForMime", () => {
  it("returns the no-sandbox set for application/pdf and for every media MIME", () => {
    ["application/pdf", ...MEDIA_MIMES].forEach((mime) =>
      assert.equal(rawSecurityHeadersForMime(mime), RAW_SECURITY_HEADERS_NO_SANDBOX, `expected no sandbox for ${mime}`),
    );
  });

  it("returns the default sandbox set for everything else", () => {
    [...SANDBOXED_MIMES, ...NEAR_MISS_MIMES].forEach((mime) =>
      assert.equal(rawSecurityHeadersForMime(mime), RAW_SECURITY_HEADERS, `expected sandbox CSP for ${mime}`),
    );
  });
});

describe("isSensitivePath — blocks secret files", () => {
  it("blocks a bare .env", () => {
    assert.equal(isSensitivePath(".env"), true);
  });

  it("blocks .env.<variant> files", () => {
    for (const name of [".env.local", ".env.production", ".env.development", ".env.staging", ".env.test"]) {
      assert.equal(isSensitivePath(name), true, `expected ${name} blocked`);
    }
  });

  it("blocks .env variants nested under subdirectories", () => {
    // The check is basename-based so it follows the file wherever
    // it lives in the tree.
    assert.equal(isSensitivePath("config/.env"), true);
    assert.equal(isSensitivePath("subdir/deeper/.env.local"), true);
  });

  it("is case-insensitive on .env", () => {
    // macOS / Windows are case-insensitive by default; a malicious
    // `.ENV` on either FS should still be rejected.
    assert.equal(isSensitivePath(".ENV"), true);
    assert.equal(isSensitivePath(".Env.Local"), true);
  });

  it("blocks SSH private keys but NOT their .pub counterparts", () => {
    for (const priv of ["id_rsa", "id_ecdsa", "id_ed25519", "id_dsa"]) {
      assert.equal(isSensitivePath(priv), true, `expected ${priv} blocked`);
    }
    // .pub files are public and safe to preview.
    assert.equal(isSensitivePath("id_rsa.pub"), false);
    assert.equal(isSensitivePath("id_ed25519.pub"), false);
  });

  it("blocks TLS / cert extensions", () => {
    assert.equal(isSensitivePath("cert.pem"), true);
    assert.equal(isSensitivePath("server.key"), true);
    assert.equal(isSensitivePath("ca.crt"), true);
    assert.equal(isSensitivePath("some/path/to/cert.PEM"), true);
  });

  it("blocks known credential filenames", () => {
    assert.equal(isSensitivePath("credentials.json"), true);
    assert.equal(isSensitivePath(".npmrc"), true);
    assert.equal(isSensitivePath(".htpasswd"), true);
  });

  it("blocks `.env` as a SUFFIX, not only as a whole filename", () => {
    // The two basename rules cover `.env` and `.env.local`. `prod.env` matched
    // neither, so /files/content refused it as binary while /files/raw served
    // the bytes — and the Files view now has a Download button on that branch.
    for (const name of ["prod.env", "secrets.env", "config/staging.env", "PROD.ENV"]) {
      assert.equal(isSensitivePath(name), true, `expected ${name} blocked`);
    }
  });

  it("blocks the keystore and Terraform secret formats", () => {
    for (const name of ["client.p12", "client.pfx", "app.jks", "debug.keystore", "terraform.tfstate", "prod.auto.tfvars"]) {
      assert.equal(isSensitivePath(name), true, `expected ${name} blocked`);
    }
  });

  it("blocks the extensionless credential files classify() would call text", () => {
    // These have no extname, and classify() answers "text" for every such
    // name — so the basename list is the only thing standing between them
    // and /files/content. `_netrc` is the Windows spelling of `.netrc`.
    for (const name of [".netrc", "_netrc", ".git-credentials", "home/.netrc", "SUB/.Git-Credentials"]) {
      assert.equal(isSensitivePath(name), true, `expected ${name} blocked`);
    }
  });
});

describe("isSensitivePath — does not over-block", () => {
  it("allows .env lookalikes that are not actually env files", () => {
    // `.environment` / `.envoy.yaml` / etc. should not match.
    assert.equal(isSensitivePath(".environment"), false);
    assert.equal(isSensitivePath(".envoy"), false);
    assert.equal(isSensitivePath("envelope.md"), false);
    assert.equal(isSensitivePath("env.json"), false);
  });

  it("allows ordinary source and document files", () => {
    assert.equal(isSensitivePath("README.md"), false);
    assert.equal(isSensitivePath("notes.txt"), false);
    assert.equal(isSensitivePath("server/api/routes/files.ts"), false);
    assert.equal(isSensitivePath("wiki/pages/sakura.md"), false);
  });

  it("allows files with similar but non-sensitive extensions", () => {
    assert.equal(isSensitivePath("foo.pkm"), false);
    assert.equal(isSensitivePath("foo.keypress"), false);
    // `.cert.ts` is a TypeScript file, extname is `.ts` not `.cert`.
    assert.equal(isSensitivePath("server.cert.ts"), false);
  });

  it("allows an empty path (resolveSafe guards those separately)", () => {
    assert.equal(isSensitivePath(""), false);
  });
});
