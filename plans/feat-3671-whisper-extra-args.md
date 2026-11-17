# feat: pass extra flags to whisper-server via `WHISPER_SERVER_EXTRA_ARGS` (#3671)

## Problem

receptron/mulmoterminal#3296: with voice input on, phrases such as 「ご視聴ありがとうございました」 appear
while the user is silent. Whisper invents these for silent or noisy audio, and the shared
capture in `@mulmoclaude/core/whisper` sends such segments: the browser-side speech gate is a
fixed RMS threshold, every segment ends with the pause that closed it, and the sidecar starts
`whisper-server` with only `--model --host --port`, so whisper.cpp's own VAD cannot be used.

## Scope

An opt-in escape hatch for the affected user, with no change for anyone who does not set it.

- `extra-args.ts` (pure): `parseExtraServerArgs(raw)` → `{ ok, args }` or `{ ok: false, reason }`.
  Whitespace-split text, or a JSON string array when a path has spaces. Rejects `-m`,
  `--model`, `--host`, `--port`: whisper-server lets a later flag win, so an override would
  move the sidecar off the port/model we poll.
- `buildServerArgs` appends the extra args after the ones it owns; `createSidecar` /
  `defaultSpawnServer` thread them through.
- `createWhisper` reads `process.env.WHISPER_SERVER_EXTRA_ARGS`. A rejected value logs a warning
  and falls back to no extras, so a typo cannot disable voice input. Reading it in core means
  neither MulmoClaude nor MulmoTerminal needs a host change.

## Out of scope (follow-ups)

- Default fixes that help every user: dropping exact known hallucination phrases, not sending
  segments whose total speech time is too short, turning off browser auto-gain.
- Enabling VAD by default and downloading the VAD model automatically.

## Verification

- `packages/core/test/whisper/test_extra_args.ts`: accepted and rejected inputs.
- `test_sidecar_helpers.ts`: extra args are appended after the owned ones.
- `whisper-server` v1.9.1 (the `yarn build:whisper` default) accepts `--vad` and
  `--no-speech-thold` per the upstream source. Not run locally: no `whisper-server` on the
  development machine.
