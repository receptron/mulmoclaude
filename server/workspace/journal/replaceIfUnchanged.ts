import fsp from "node:fs/promises";
import { writeFileAtomic } from "../../utils/files/atomic.js";

// Compares bytes, not decoded text: invalid UTF-8 and U+FFFD decode to the same string but are different files.
// Narrows, but cannot close, the window between this read and the rename; a concurrent writer can still win it.
export async function replaceIfUnchanged(filePath: string, expectedBytes: Buffer, content: string): Promise<boolean> {
  if (!(await fsp.readFile(filePath)).equals(expectedBytes)) return false;
  await writeFileAtomic(filePath, content);
  return true;
}
