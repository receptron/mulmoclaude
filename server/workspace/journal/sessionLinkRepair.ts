import path from "node:path";
import { rewriteMarkdownLinks, splitFragmentAndQuery } from "../../utils/markdown.js";
import { WORKSPACE_DIRS } from "../paths.js";
import { endsHtmlBlock, openHtmlBlock, type HtmlBlockEnd } from "./htmlBlock.js";

const JSONL_SUFFIX = ".jsonl";
// Where summaries written before the prompt fix resolved their session links to.
const MISCOUNTED_CHAT_DIR = "chat";

export interface SessionLinkRepairResult {
  content: string;
  repairedCount: number;
  // Broken links left as written because their paragraph holds raw HTML or starts indented.
  skippedCount: number;
}

// Session id when `resolvedPath` is exactly `chat/<id>.jsonl` at the workspace root.
export function extractMiscountedSessionId(resolvedPath: string): string | null {
  const prefix = `${MISCOUNTED_CHAT_DIR}/`;
  if (!resolvedPath.startsWith(prefix) || !resolvedPath.endsWith(JSONL_SUFFIX)) return null;
  const sessionId = resolvedPath.slice(prefix.length, resolvedPath.length - JSONL_SUFFIX.length);
  return sessionId.length === 0 || sessionId.includes("/") ? null : sessionId;
}

function repairHref(href: string, currentDir: string, sessionExists: (sessionId: string) => boolean): string | null {
  const { pathPart, suffix } = splitFragmentAndQuery(href);
  if (pathPart.startsWith("/") || pathPart.includes("://")) return null;
  const sessionId = extractMiscountedSessionId(path.posix.join(currentDir, pathPart));
  if (sessionId === null || !sessionExists(sessionId)) return null;
  const target = `${WORKSPACE_DIRS.chat}/${sessionId}${JSONL_SUFFIX}`;
  return `${path.posix.relative(currentDir, target)}${suffix}`;
}

const BACKTICK = "`";
const HTML_OPEN = "<";
const FENCE_CHARS = ["`", "~"];
const MIN_FENCE_LENGTH = 3;
const MAX_FENCE_INDENT = 3;
const INDENTED_CODE_SPACES = "    ";
const TAB = "\t";
const DIGIT_ZERO = 48;
const DIGIT_NINE = 57;

interface FenceLine {
  char: string;
  length: number;
  rest: string;
}

// CommonMark fence line: up to three spaces of indent, then a run of at least three backticks or tildes.
function parseFenceLine(line: string): FenceLine | null {
  const indent = line.length - line.trimStart().length;
  const body = line.slice(indent);
  const [char] = body;
  if (indent > MAX_FENCE_INDENT || char === undefined || !FENCE_CHARS.includes(char)) return null;
  let length = 0;
  while (body[length] === char) length += 1;
  return length < MIN_FENCE_LENGTH ? null : { char, length, rest: body.slice(length) };
}

function opensFence(line: string): FenceLine | null {
  const fence = parseFenceLine(line);
  // A backtick fence's info string may not contain a backtick, otherwise the line is inline code.
  return fence !== null && fence.char === BACKTICK && fence.rest.includes(BACKTICK) ? null : fence;
}

function closesFence(line: string, open: FenceLine): boolean {
  const fence = parseFenceLine(line);
  return fence !== null && fence.char === open.char && fence.length >= open.length && fence.rest.trim() === "";
}

// Splits text (possibly several lines, never crossing a blank text) into prose and inline-code segments; an unmatched backtick run is plain prose.
function splitInlineCode(text: string): { text: string; isCode: boolean }[] {
  const segments: { text: string; isCode: boolean }[] = [];
  let proseStart = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== BACKTICK) {
      index += 1;
      continue;
    }
    const runLength = backtickRunLength(text, index);
    const closeIndex = findClosingRun(text, index + runLength, runLength);
    if (closeIndex === -1) {
      index += runLength;
      continue;
    }
    if (index > proseStart) segments.push({ text: text.slice(proseStart, index), isCode: false });
    segments.push({ text: text.slice(index, closeIndex + runLength), isCode: true });
    proseStart = closeIndex + runLength;
    index = proseStart;
  }
  if (proseStart < text.length) segments.push({ text: text.slice(proseStart), isCode: false });
  return segments;
}

function backtickRunLength(text: string, from: number): number {
  let end = from;
  while (text[end] === BACKTICK) end += 1;
  return end - from;
}

function findClosingRun(text: string, from: number, runLength: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] !== BACKTICK) {
      index += 1;
      continue;
    }
    const length = backtickRunLength(text, index);
    if (length === runLength) return index;
    index += length;
  }
  return -1;
}

const QUOTE_MARKER = ">";
const LIST_BULLETS = ["-", "*", "+"];

function listMarkerLength(text: string): number {
  const [first] = text;
  if (first !== undefined && LIST_BULLETS.includes(first)) return text[1] === " " || text[1] === TAB ? 2 : 0;
  let digits = 0;
  while (digits < text.length && text.charCodeAt(digits) >= DIGIT_ZERO && text.charCodeAt(digits) <= DIGIT_NINE) digits += 1;
  const after = text[digits];
  return digits > 0 && (after === "." || after === ")") && (text[digits + 1] === " " || text[digits + 1] === TAB) ? digits + 2 : 0;
}

// The line with leading blockquote and list-item markers removed, so a fence or HTML block wrapped in a container is still recognised.
function stripContainers(line: string): string {
  let rest = line.trimStart();
  for (;;) {
    const markerLength = rest.startsWith(QUOTE_MARKER) ? 1 : listMarkerLength(rest);
    if (markerLength === 0) return rest;
    rest = rest.slice(markerLength).trimStart();
  }
}

// The line with blockquote markers (and their one optional space) removed, keeping the indent that follows.
function stripQuoteMarkers(line: string): string {
  let rest = line;
  while (rest.trimStart().startsWith(QUOTE_MARKER) && line.length - rest.length <= MAX_FENCE_INDENT) {
    rest = rest.trimStart().slice(1);
    if (rest.startsWith(" ")) rest = rest.slice(1);
  }
  return rest;
}

function startsIndentedCode(line: string): boolean {
  const rest = stripQuoteMarkers(line);
  return rest.startsWith(INDENTED_CODE_SPACES) || rest.startsWith(TAB);
}

type BlockKind = "prose" | "fence" | "html" | "blank";

interface Block {
  kind: BlockKind;
  text: string;
}

type RawRegion = { kind: "fence"; fence: FenceLine } | { kind: "html"; end: HtmlBlockEnd };

// The region `line` opens (fenced code, or a raw HTML block that can span blank lines), and whether it already closes on that line.
function openRegion(rawLine: string): { region: RawRegion; closesHere: boolean } | null {
  const line = stripContainers(rawLine);
  const fence = opensFence(line);
  if (fence !== null) return { region: { kind: "fence", fence }, closesHere: false };
  const end = openHtmlBlock(line);
  if (end === null) return null;
  return { region: { kind: "html", end }, closesHere: endsHtmlBlock(line, end, line.toLowerCase().indexOf("<") + 1) };
}

function closesRegion(rawLine: string, region: RawRegion): boolean {
  const line = stripContainers(rawLine);
  return region.kind === "fence" ? closesFence(line, region.fence) : endsHtmlBlock(line, region.end, 0);
}

// Splits into raw regions (fenced code, raw HTML blocks), blank lines and paragraphs (runs of non-blank lines).
function splitBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let region: RawRegion | null = null;
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: "prose", text: paragraph.join("\n") });
    paragraph = [];
  };
  content.split("\n").forEach((line) => {
    if (region !== null) {
      blocks.push({ kind: region.kind, text: line });
      if (closesRegion(line, region)) region = null;
      return;
    }
    const opened = openRegion(line);
    if (opened !== null) {
      flush();
      blocks.push({ kind: opened.region.kind, text: line });
      region = opened.closesHere ? null : opened.region;
    } else if (line.trim() === "") {
      flush();
      blocks.push({ kind: "blank", text: line });
    } else paragraph.push(line);
  });
  flush();
  return blocks;
}

// A paragraph is edited only when it holds no construct this module does not parse: raw HTML, or an indented-code start.
// Code spans are parsed (they may cross lines, never a blank line); anything not parsed is left alone rather than guessed at.
function isEditableParagraph(text: string): boolean {
  return !text.includes(HTML_OPEN) && !text.split("\n").some(startsIndentedCode);
}

// Points links that resolve to `<workspace>/chat/<id>.jsonl` at the real `conversations/chat/<id>.jsonl`.
// A link is left alone when the session file exists in neither place, so links to deleted sessions are not touched.
// Rewrites link-shaped `[text](href)` destinations in editable prose (the scanner does not tell images, escaped or nested brackets apart). Fenced code, inline code spans (also across lines), paragraphs with raw HTML or an
// indented-code start, titled links (`[t](href "title")`), reference-style and angle-bracket links are left exactly as written.
export function repairSessionLinks(fileWsPath: string, content: string, sessionExists: (sessionId: string) => boolean): SessionLinkRepairResult {
  const currentDir = path.posix.dirname(fileWsPath);
  let repairedCount = 0;
  let skippedCount = 0;
  const repairLinks = (prose: string): string =>
    rewriteMarkdownLinks(prose, (href) => {
      const fixed = repairHref(href, currentDir, sessionExists);
      if (fixed === null) return href;
      repairedCount += 1;
      return fixed;
    });
  const repairProse = (paragraph: string): string =>
    splitInlineCode(paragraph)
      .map((segment) => (segment.isCode ? segment.text : repairLinks(segment.text)))
      .join("");
  const countBroken = (prose: string): void => {
    rewriteMarkdownLinks(prose, (href) => {
      if (repairHref(href, currentDir, sessionExists) !== null) skippedCount += 1;
      return href;
    });
  };
  const repaired = splitBlocks(content).map((block) => {
    if (block.kind === "prose" && isEditableParagraph(block.text)) return repairProse(block.text);
    if (block.kind === "prose" || block.kind === "html") countBroken(block.text);
    return block.text;
  });
  return { content: repaired.join("\n"), repairedCount, skippedCount };
}
