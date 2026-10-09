// CommonMark raw HTML blocks that continue across blank lines (spec types 1-5); other HTML blocks end at a blank line.
const RAW_TEXT_TAGS = ["script", "pre", "style", "textarea"];
const MAX_BLOCK_INDENT = 3;
const COMMENT_OPEN = "<!--";
const PROCESSING_OPEN = "<?";
const CDATA_OPEN = "<![CDATA[";
const DECLARATION_OPEN = "<!";

export interface HtmlBlockEnd {
  // Lower-cased text whose appearance on a line ends the block.
  terminator: string;
}

function startsRawTextTag(lowered: string): string | null {
  const tag = RAW_TEXT_TAGS.find((name) => lowered.startsWith(`<${name}`));
  if (tag === undefined) return null;
  const after = lowered[tag.length + 1];
  return after === undefined || after === ">" || after === " " || after === "\t" ? tag : null;
}

function isAsciiLetter(char: string | undefined): boolean {
  return char !== undefined && char.toLowerCase() !== char.toUpperCase() && char.charCodeAt(0) < 128;
}

// The terminator when `line` opens a block that can span blank lines, otherwise null.
export function openHtmlBlock(line: string): HtmlBlockEnd | null {
  const indent = line.length - line.trimStart().length;
  if (indent > MAX_BLOCK_INDENT) return null;
  const lowered = line.trimStart().toLowerCase();
  const rawTextTag = startsRawTextTag(lowered);
  if (rawTextTag !== null) return { terminator: `</${rawTextTag}>` };
  if (lowered.startsWith(COMMENT_OPEN)) return { terminator: "-->" };
  if (lowered.startsWith(PROCESSING_OPEN)) return { terminator: "?>" };
  if (lowered.startsWith(CDATA_OPEN.toLowerCase())) return { terminator: "]]>" };
  return lowered.startsWith(DECLARATION_OPEN) && isAsciiLetter(lowered[DECLARATION_OPEN.length]) ? { terminator: ">" } : null;
}

// True when the terminator appears on `line`; `searchFrom` skips the opener on the line that opened the block.
export function endsHtmlBlock(line: string, end: HtmlBlockEnd, searchFrom: number): boolean {
  return line.toLowerCase().indexOf(end.terminator, searchFrom) !== -1;
}
