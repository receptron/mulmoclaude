# fix(publish): drift ゲートの走査範囲と指標を直す (#3116)

## 測って分かったこと（設計はこれで決まった）

### 1. 走査範囲が 4 パッケージだけ

`detectMulmobridgeDeps()` は launcher の `dependencies` から `@mulmobridge/*` だけを拾う
（`drift.mjs:228`）。実際に見られているのは **chat-service / client / protocol / web-push** の 4 つ。
`@mulmoclaude/common`（他 32 workspace が依存）、`@mulmobridge/webhook-runtime`（9）、
`@mulmoclaude/core`（8）、`@mulmoclaude/markdown-utils`（2）、`@receptron/task-scheduler`（1）は
対象外。#3109 の export 追加 2 件が素通りしたのはこれ。

workspace が別の workspace を宣言しているものを数えると **20 パッケージ**が候補。

### 2. 指標（src の export 行数）が bundle ビルドで壊れる

| package                 | ビルド   | local src 行 | local dist 行 | 公開 dist 行 | 現指標の判定                       |
| ----------------------- | -------- | ------------ | ------------- | ------------ | ---------------------------------- |
| `@mulmoclaude/common`   | tsc      | 19           | 17            | 16           | 正しく drift                       |
| `@mulmoclaude/x-plugin` | **vite** | 6            | 1             | 1            | **DRIFTED（誤検知）**              |
| `@mulmoclaude/core`     | **vite** | —            | —             | —            | local 229 / 公開 30 の無意味な比較 |

現行の「local **src** の export 行数 vs 公開 **dist** の export 行数」は、dist が src を
1:1 で写す tsc ビルドでしか成立しない。広げた状態で測ると google / spotify / x の 3 plugin が
DRIFTED になるが、**3 件とも誤検知**（bundle 済み dist を src と比べている）。

### 3. 行数では bundle の追加 export を取りこぼす

```
x-plugin の dist: export { extractTweetId, formatTweet, readUrlArg, readXPost, searchX, tweetBody };
```

**1 行に 6 名前**。7 つ目を足しても行数は 1 のままなので、行数比較は素通りする。

## 決めたこと

1. **走査範囲**: 「publish 対象 かつ 別の workspace が宣言している」workspace すべて（scope 非依存、
   パス規約非依存）。launcher しか依存していない plugin も対象に含める — launcher の公開コードが
   その export を呼ぶので、壊れ方は同じ。
2. **比較対象**: **local の build 済み dist ↔ 公開 dist**。src とは比べない。
   smoke ワークフローは `yarn build:packages && yarn build` の後に走る（`mulmoclaude_smoke.yaml:80,86`）ので
   CI では dist は新鮮。
3. **指標**: 行数ではなく **export される名前の集合**。`exports` map の各 subpath entry について、
   同じ相対パスのファイルを local と公開で読み、名前集合の差を取る。
4. **ワークフローの `paths:` も広げる**。今は `packages/{mulmoclaude,protocol,client,chat-service}` と
   `server/` `src/` `scripts/mulmoclaude/` だけなので、**common に export を足す PR では smoke が起動すらしない**。
   走査対象を増やしても trigger しなければ意味が無い。

## やらないこと

- `audit:releases` への一本化（案 c）。README だけの drift が 45 件出るので PR ゲートにならない。
  役割分担はそのまま: drift.mjs = 「export を足して version を据え置いた」の検出、
  audit:releases = tag 基準の棚卸し。
- 既存の判定語彙（`ok` / `pending-publish` / `drifted` / `skipped`）は変えない。smoke.mjs が読む。

## 検証

- 20 パッケージを新指標で測り、**DRIFTED が 0 件**（= 赤いゲートを landing させない）ことを確認してから push
- `parseExportedNames` を両方向でユニットテスト（`export {a, b as c} from`、`export const/function/class`、
  `export default` を名前に数えない、`export * from` は opaque として扱う）
- 既存 `test/scripts/mulmoclaude/test_drift.ts` の fixture ベースのテストを新形に移す
- local dist が無い場合は `skipped` + 理由（黙って pass しない）

## cross-review で出た 4 つの追加穴（すべて再現してから修正）

どれも形が同じ — **間違った / 空の答えが clean と読まれる**:

1. **公開側 subpath の 404 が skip だった** → concrete target の 404 は drift（transport 失敗は skip のまま）
2. **非 JS target（`./style.css`）が「比較成功」に数えられていた** → 走査 20 のうち 8 個が該当。JS 未ビルドでも `ok` になり得た
3. **パーサが読めない名前を推測していた** → `export { a as "string name" }` が `a`、`export { café }` が `caf`
4. **opaque の fallback が名前比較を置き換えていた** / **ネスト条件と types のみの subpath** → 前者は 1 行対 1 行で clean、後者は別ファイルを比較

3 回続けて「もう 1 つの形を落としている」と指摘されたので、**ルールを ban-list から許可リストに反転**した（文 / 指定子 / 宣言名 / 条件解決の 4 段）。安全なコードの一部も粗い比較に落ちるが、リリースゲートとしてはその取引が正しい。

テストは 48 件。実ゲートは 20 パッケージ / drifted 0 / exit 0。
