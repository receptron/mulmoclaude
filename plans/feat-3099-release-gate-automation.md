# リリース面の自動化 —— `--release` と「その版は公開されているか」 (#3099 の案 B / C)

## なぜ

`mulmoclaude@1.16.0` を出す直前、`@mulmobridge/client` が**ローカル 1.1.0 / npm 1.0.2** で、
launcher は `^1.1.0` を宣言していた。そのまま publish すれば `npx mulmoclaude@1.16.0` は
**ETARGET で落ちる**。公開中の 1.0.2 には `resolveApiUrl` が無く、consumer 25本が未公開版を指していた。

**拾ったのは自動ゲートではなく、`/publish-mulmoclaude` SKILL.md §6 の手書きシェルループ**だった。
skill のドキュメントに書かれたループなので、回し忘れればそれで終わる。#3099 の案 A（表示の修正）は
マージ済みで、これは残りの B / C。

## B. `drift.mjs --release`

`pending-publish`（src に新しい export があり version も上がっているが未 publish）は、
通常 PR では**失敗させないのが正しい** —— export を足して version も上げた PR を
cascade publish の前にブロックしないため。その判断は `drift.mjs:187` のコメントにある。

**リリース時は逆で、それがブロッカーそのもの。** `--release` を付けたときだけ
`pending-publish` も exit 1 にする。`main()` の判定だけを変え、分類も表示も触らない。

## C. 「その版は公開されているか」（`publishedDeps.mjs`）

§6 が見ている問いは `drift.mjs` とは**別物**:

| | 問い |
|---|---|
| `drift.mjs` | src の export が**公開 dist に無い**か |
| `launcherSync.mjs` | launcher の range を**ワークスペースの version が満たす**か |
| **これ（C）** | **そのワークスペース version が npm に公開されているか** |

3つ目だけ誰も見ていない。launcher は CLAUDE.md の規則で `^<最新公開版>` を宣言するので、
**その下限が npm に存在しなければ install は解決できない**。1.16.0 で起きたのはこれ。

semver は入れない。`launcherSync.mjs` が既に自前の range 解析を持っており、ここで要るのは
range 演算ではなく「**この exact version が公開一覧にあるか**」という存在確認だけ。

**置き換えである以上、旧ループが出していた信号を落とさない。** round 1 で2つ落ちていた ——
「workspace に manifest が無い」（レジストリを見ずに通していた）と「local が npm より古い」。
前者は range が未検証のまま通るので**落とす**、後者は ETARGET にならないので報告のみ。

## 直さないもの

- `pending-publish` への降格そのもの（通常 PR では正しい）
- `drift.mjs` の分類・表示（#3099 案 A でマージ済み）
- `launcherSync.mjs`（重複しない別の不変条件）

## テスト

registry fetch は注入する（`drift.mjs` の `fetchPublishedSource` と同じ形）。
両方向から: 公開済みで通る / 未公開で落ちる / npm に無いパッケージ / ワークスペースに無い依存。
`--release` は `pending-publish` の exit code が**フラグの有無で変わる**ことを断言する。

## 関連

- #3099 —— 案 A はマージ済み（PR #3101）
- #3097 —— 実害が出たリリース
