# fix #3079 — 事故としての多重起動を止める（`--allow-multiple-instances` でオプトイン）

2026-09-12 / issue: https://github.com/receptron/mulmoclaude/issues/3079

## 問題

`yarn dev` / `yarn server` と `npx mulmoclaude` が、**無確認で 2 本目のサーバを立てる**。
`PORT` / `--port` を明示していなければ、塞がっているポートから黙って前進する:

- `server/index.ts:865` `resolvePort()` → `findAvailablePort(requested + 1)`
- `packages/mulmoclaude/bin/mulmoclaude.js:198` `chooseAvailablePort()` → 同型

出るのは `log.info` 1 行だけ。アイコン起動（`server/utils/launcher/start.mjs`）だけは
`findRunningServerPort()` で既存を検出しており、正しく守られている。

同一ワークスペースで 2 本走ると `.session-token` を互いに上書きし、プラグインの
`/api/internal/tool-result` push が存在しないセッションに落ちて**黙って**描画されなくなる
（`server/workspace/serverPort.ts:26-34` に記録済み）。壊れ方が静かなのが問題。

## 決定事項（ユーザーと合議、2026-09-12）

| 論点 | 決定 |
|---|---|
| 判定基準 | **`<workspace>/.server-port`** を読み、そのポートを `/api/health` で 1 回叩いて生きている MulmoClaude なら「既存インスタンスあり」 |
| オプションの形 | `server/utils/cli-flags.mjs` に登録: `--allow-multiple-instances` = `MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES=1` |
| 対話プロンプト | **入れない**。オプションが無ければ常に `exit(1)` |
| 置き場所 | **サーバ本体 + npx ランチャー**の両方（判定ロジックは共有） |
| オプション ON の挙動 | **今どおり前進**（3001 → 3002 …）。B-4（帯の外から探す）はこの PR の対象外 |

### 「ポート使用中」ではなく `.server-port` を基準にした理由

- 害の本体は「ポートが被ること」ではなく「**同一ワークスペースを 2 本が共有すること**」。
  `.server-port` はワークスペース単位なので、判定と害がぴったり一致する。
- `PORT=3100 yarn dev`（空きポートを明示）でも同一ワークスペースなら止まる。
  ポート基準（issue の B-1 / mulmoterminal と同じ）では素通りする経路。
- プローブが 1 回で済む（`findRunningServerPort` の 20 ポート走査が不要）。
- **e2e-live が無影響**: `isolated-dev-server.ts:338` が `MULMOCLAUDE_WORKSPACE_PATH` を
  mkdtemp の新規ディレクトリに差し替えるので、別の `.server-port` を見る。
- `.server-port` は graceful shutdown で消される（#3082, `server/index.ts:1379`）。
  ハードキル後に残った場合はプローブが `absent` を返すので無害。

### 対話プロンプトを入れない理由（実測）

`script` で本物の pty を割り当ててサーバ子プロセスの `process.stdin.isTTY` を計測した:

| 起動の仕方 | `isTTY` |
|---|---|
| 端末から直接 `node`（比較用） | `true` |
| `concurrently` 配下（= `yarn dev`） | **`undefined`**（Socket が渡る） |
| `stdio:"inherit"` で spawn（= `yarn server` の supervisor） | `true` |

mulmoterminal はプロンプトを**ランチャー 1 プロセス**で出すので成立するが、MulmoClaude の
`resolvePort()` は**サーバ本体**にあり、本命の `yarn dev` では TTY が来ないので必ず
「TTY 無し → 停止」に落ちる。プロンプトが実際に出るのは `yarn server` だけで、そこは
`scripts/dev-server.mjs` がクラッシュ時に最大 5 回再起動するので**再起動のたびに聞き直す**。

## 実装

### 1. `server/utils/workspace-path.mjs` + `.d.mts`（新規）

ワークスペースの解決規則（`MULMOCLAUDE_WORKSPACE_PATH` || `~/mulmoclaude`）を `.mjs` に 1 箇所だけ置く。
npx ランチャーは tsx より前に走るので `.ts` を import できず、この規則が必要。
`scripts/lib/devWorkspace.ts` は**ここへ委譲**する（規則を 2 つに増やさない。
`vite.config.ts` / `scripts/wait-for-backend.ts` の import は変えない）。

### 2. `server/utils/instance-guard.mjs` + `.d.mts`（新規）

- `SERVER_PORT_FILENAME` — `WORKSPACE_FILES.serverPort` のミラー（`.ts` を import できないため。
  `scripts/wait-for-backend.ts:38` と同じ前例）
- `parsePublishedPort(text)` — **純粋**。`"3001\n"` → `3001`、空/壊れ/範囲外 → `null`
- `decideInstanceGuard({ publishedPort, presence, allowMultiple })` — **純粋**。`"stop" | "proceed"`
- `instanceGuardMessage(port)` — **純粋**。停止時のメッセージ
- `findLiveInstancePort(serverPortPath, deps)` — I/O。`readPort` / `probe` を注入可能

### 3. `server/utils/cli-flags.mjs`

`{ flag: "--allow-multiple-instances", env: "MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES", help: ... }` を追加。
`--help` 生成と argv→env 注入は既存機構が自動で拾う。

### 4. `server/system/env.ts`

`allowMultipleInstances: flagOf("MULMOCLAUDE_ALLOW_MULTIPLE_INSTANCES")` を snapshot に追加。

### 5. `server/index.ts`

async IIFE の**先頭**、`resolvePort()` より前にガードを呼ぶ。

順序が効く: `await deleteServerPort()`（#3082）が `.server-port` を消すので、
その前に読まないと生きているインスタンスの publish を消してから読むことになる。

**副次的なバグ修正**: 現状 `PORT` 未指定 + 3001 使用中のとき `resolvePort()` は前進し、
その直後の `deleteServerPort()` が**1 本目の `.server-port` を消す**。#3082 のコメントは
明示 PORT の場合しか想定していない。ガードが先に止めるのでこの経路が塞がる。

### 6. `packages/mulmoclaude/bin/mulmoclaude.js`

- `.env` のマージブロック（現在 ~236 行）を**ポート解決より前に移動**。
  ワークスペースは `.env` の `MULMOCLAUDE_WORKSPACE_PATH` でも指定できるので、
  マージ後の値で見ないとサーバと違う `.server-port` を読む（正しさの問題であって順序の好みではない）。
- `chooseAvailablePort()` の前にガードを呼ぶ。

### 7. テスト `test/utils/test_instanceGuard.ts`（新規）

純粋関数を両方向で網羅: 正常入力 + 異常入力（空・null/undefined・型違い・境界・壊れた値）。

### 8. ドキュメント

- `docs/developer.md` — env 表に 1 行、CLI フラグ一覧に 1 つ、"Running two instances" 節を更新
- `packages/core/assets/helps/error-recovery.md` — 新しい停止メッセージの節（エージェントが
  ユーザーに聞く前に読むファイル）。→ `@mulmoclaude/core` の version bump が必要

## 挙動の変化（PR で明記する）

| コマンド | 変更前 | 変更後 |
|---|---|---|
| `yarn dev`（1 本目） | 起動 | 変わらず |
| `yarn dev` 2 本目（同一 WS） | 黙って 3002 で起動 | **停止**（フラグを案内） |
| `PORT=3100 yarn dev`（同一 WS、既存あり） | 起動 | **停止**（← 挙動変更。従来ドキュメントが勧めていた経路） |
| `MULMOCLAUDE_WORKSPACE_PATH=… PORT=3100 yarn dev` | 起動 | **変わらず**（別 WS = 別 `.server-port`） |
| `--allow-multiple-instances` 付き | — | 従来どおり前進して起動 |
| 3001 を他人のアプリが占有 | 3002 へ前進 | **変わらず**（`.server-port` が MulmoClaude を指さない） |
| e2e-live / CI | — | **変わらず**（別 WS / 空きポート） |

## 検証

1. `yarn format` → `yarn lint` → `yarn typecheck` → `yarn build`
2. `yarn test`（新規ユニットテスト含む）
3. **実機**: 1 本目を `yarn dev` で上げ、2 本目の `yarn dev` / `PORT=3100 yarn dev` /
   `--allow-multiple-instances` 付き / 別ワークスペース、の 4 通りを実際に走らせて出力を確認する
   （build が通ることは動くことの証明ではない）
