# fix: tests that redirect HOME never touch a configured workspace

## Problem

Tests that isolate themselves by pointing `HOME` / `USERPROFILE` at a temp folder rely on `workspacePath` resolving
under it. But `MULMOCLAUDE_WORKSPACE_PATH` wins over `HOME` (`server/workspace/paths.ts`), and the server's own
port-fallback message tells developers to set it to run a second instance. With it exported in the shell, those tests
write into, and some empty, that real workspace.

Observed on `main` (a1f8f8f0f): with the variable pointing at a folder holding a marker file, `test_filesPutRoute.ts`
and `test_filesCreateRoute.ts` deleted the marker along with everything else in the folder.

## Fix

- `test/helpers/isolatedHome.ts`: `isolateHome(tmpRoot)` sets `HOME` and `USERPROFILE`, clears
  `MULMOCLAUDE_WORKSPACE_PATH`, and returns a function that restores all three.
- Every test that redirected `HOME` by hand without handling the variable now calls it. Tests that set the variable
  themselves, to a temp folder, are left as they are.
- `test_filesReadRoutes.ts` and `test_filesWriteContent.ts`, which had their own copy of the fix, use the helper too.

The rule stays in the tests rather than in `paths.ts`: several tests set the variable on purpose, alongside a
redirected `HOME`, so `paths.ts` cannot tell an inherited value from a deliberate one.

## Verified

- The changed tests pass, and pass again with the variable pointing at a folder holding a marker file; the marker
  and the folder are left alone.
- `grep -rlE 'process\.env\.(HOME|USERPROFILE) = ' test packages | xargs grep -LE 'MULMOCLAUDE_WORKSPACE_PATH|isolateHome'`
  lists no file.
