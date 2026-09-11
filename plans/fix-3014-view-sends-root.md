# View が dispatch に `root` を載せる（#3014 の順序 1 の残り）

## 症状

登録済み root 配下のデッキを Canvas で開くと、**開けるのにビート画像も保存も `File not found`**。
実測（MulmoTerminal 4.19 台のサーバに直接投げたもの。デッキは `<workspace>/acme-docs/decks/launch.json`、
`acme-docs` は登録済み root）:

```
相対 + root なし → {"ok":false,"code":"not_found","error":"File not found: stories/acme-docs/decks/launch.json"}
絶対 + root なし → {"ok":true}   ファイルの中身が実際に書き変わる
```

## 原因

**ホストは既にカードに `root` を載せている。View がそれを一度も読まない。**

MulmoTerminal 側（`src/composables/canvasOpenFile.ts:291`）:

```ts
card: { toolName: STORY_TOOL, data: { script: body.script, filePath: body.filePath, ...root } }
```

プラグイン側の `MulmoScriptData`（`src/core/types.ts:21`）は `{ script, filePath }` しか宣言していない。
View は `data.value?.filePath` だけを読み、transport は受け取った引数をそのまま流すので、
**Vue 層の 20 箇所の dispatch すべてで `root` が落ちる**。購読2つも `root: () => undefined` とベタ書き。

サーバ側の受け皿（`artifactsForRoot` / `guardStoryWriteRoot` / `rootScopedGenerationState`）は
#3015 / #3019 / #3020 で入っていて動く。**View が送りさえすれば通る。**

## もう1つ、同じ根から出る問題 —— staleness ガードが `filePath` 単体

View と composable の随所にこの形がある:

```ts
const requestedFilePath = filePath.value;
const response = await api.call(...);
if (staleSince(filePath.value, requestedFilePath)) return;
```

`stories/deck.json` は根ごとに存在するので、**別の root の同名デッキに切り替えてもこのガードを素通りし、
片方の応答がもう片方の状態に書き込まれる**。issue 本文の表 #1〜#3 と同じクラスで、`root` を送るだけでは
閉じない。同一性の鍵を対 `(root, filePath)` に広げる必要がある。

## 直し方

1. `MulmoScriptData` に `root?: string` を宣言する（ホストが既に送っている値に型を付けるだけ。
   省略 = 既定 root で、roots 以前と同じ意味）。
2. View に `root = computed(() => data.value?.root)` を置き、**全 dispatch に載せる**。
   composable 4つ（`useDeckEditor` / `useBeatMovie` / `useCharacterImages` / `useMediaExport`）は
   `filePath` と同じ形で `root: ComputedRef<string | undefined>` を受け取る。
3. 購読2つ（`onGenerationEvent` / `onScriptChanged`）の `root: () => undefined` を
   カードの root にする。
4. `staleSince(current, requested)` を **対を取る形**に変える。`sameRoot`（`core/contract.ts:103`）が
   既にあるので、root の比較はそれを使う（`undefined` と既定 root の綴りを同一視する正規化込み）。

**エージェントのツールスキーマは変えない。** `root` は意図的にスキーマに無く、ホストが埋める
（#3015 の設計。モデルが任意の root を名指しできないことが封じ込めの一部）。

## やらないこと

- MulmoTerminal 側の順序 2・3（別リポ）
- #2036 の絶対パス回避の撤回（あちらの判断）
- したがって **`Closes #3014` にはしない** —— この PR は issue の一部

## テスト

`staleSince` の対化は純粋関数なので `test/test_helpers.ts` に両方向（同じ root で同じパス /
同じパスで別 root / root 省略 と 既定 root の綴り）。

dispatch が root を載せることは、composable には注入した fake transport で、View には
ソース読み取りで（`test_beatPaneDefault.ts` と同じ手法 —— mount にはランタイム一式が要る）。

## 関連

- #3014 —— 親 issue（順序 2・3 は MulmoTerminal 側に残る）
- #3015 / #3019 / #3020 —— サーバ側
- receptron/mulmoterminal#1970 —— 症状の報告元、#2036 で絶対パスに切り替えて回避済み
