# fix: client-token usage test asserts POSIX mode bits on Windows (#3642)

## Problem

`test/server/test_clientTokenUsage.ts` "flushes the uses, owner-only, and drops revoked ids" checks `mode & 0o777 === 0o600`. Windows keeps no POSIX mode bits, so a writable file reads back as `0o666`. That makes `lint_test (Windows)` red on `main`.

## Change

- Split the test in two:
  - "flushes the uses and drops revoked ids" runs on every platform.
  - "writes the usage file owner-only" is skipped on `win32`, the same way `test_clientTokens.ts` skips its owner-only test.
- Production code is unchanged.

## Verification

- The test file passes locally on macOS.
- Changing `STORE_FILE_MODE` in `clientTokenStore.ts` to `0o644` turns "writes the usage file owner-only" red; restoring it turns it green again.
- Windows is verified by CI (`lint_test_windows`).
