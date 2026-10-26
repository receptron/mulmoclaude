// Exclusive-create write for new files: dropped-file uploads (#2270) and the File Explorer's "New file".
//
// Route handlers don't call raw `fs` — this is the domain module for that
// write. It deliberately does NOT go through `writeFileAtomic`: that writes a
// temp file and renames over the destination, which would silently clobber an
// existing file. The upload route's non-clobbering rename loop is built on the
// create failing with EEXIST instead.

import { mkdir } from "fs/promises";
import path from "path";
import { createFileVerifiedInScope } from "@mulmoclaude/core/files";

/** Create `absPath` holding `content`, creating parents as needed. `workspaceRoot` is the async realpath of the
 *  workspace: the new file is proven to sit inside it before any byte is written (#3573). Throws with
 *  `code: "EEXIST"` when the file is already there — the caller's cue to try the next `name (n).ext` candidate. */
export async function writeNewFileExclusive(workspaceRoot: string, absPath: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(absPath), { recursive: true });
  await createFileVerifiedInScope({ trustedReal: workspaceRoot, scopeWithinTrusted: "" }, path.dirname(absPath), path.basename(absPath), content);
}
