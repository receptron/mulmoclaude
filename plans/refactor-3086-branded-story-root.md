# story root を branded type にして、parse していない root を型で弾く (#3086)

## 症状

mulmoScript の story root が `string | undefined` なので、**parse していない root を渡すコードが
型検査を通る**。`mulmoScriptOps.beatImageOp(filePath, 0, req.query.root)` はコンパイルできる。

このクラスのバグが直近で**4回**出ている（#3076 / #3077）。どれも**静かに間違う** ——
`stories/deck.json` はどの root でも整形式なので、既定 root の同名ファイルを読み書きしても
下流の誰も気づけない。

守りは `test/plugins/mulmoscript/test_storyRootSweep.ts` の**テキストルール**だったが、
#3083 のレビューが**その綴りだけで5ラウンド**消えた（同一ファイルのヘルパー、型注釈付き束縛、
`let root; root = raw;` …）。テキストのルールには無限に盲点があり、列挙は仕様ではなく待ち行列。

## 測ったこと（設計の根拠）

- root を渡す呼び出しは **14 箇所 / 2 ファイル**
- ルートが使う ops のメンバーは **24 種、うち 12 種が root を取る**
- `mulmoScriptOps` を import しているのは **その2ファイルだけ**

最後の1つが効いた。**生の ops を export しなければ、未 parse の root は届きようがない。**

## 直し方

### 1. brand を作る（`server/api/routes/mulmoScriptWriteRoot.ts`）

```ts
export type ParsedStoryRoot = (string & { readonly __parsedStoryRoot: unique symbol }) | undefined;
```

`undefined` は brand 不要 —— 既定 root の意味で、roots 以前の全呼び出しがそれ。

**mint は `as` ではなく型ガード**（このリポは `as` を禁止しており lint も効いている）:

```ts
const isNamedStoryRoot = (value: string): value is string & ParsedStoryRoot => value.length > 0;
```

条件は本物（named root = 空でない文字列で、直前に string であることを確認済み）。
mint できるのは `parseSuppliedRoot` の中だけ。

### 2. 生の ops を隠す（`server/plugins/mulmoscript-server.ts`）

`createMulmoScriptServerOps(...)` の結果を **export しない**（`rawOps`）。
代わりに、**root を取る 17 メンバーだけ `ParsedStoryRoot` を要求する型**で見せる:

```ts
export const mulmoScriptOps: RootedMulmoScriptOps = rawOps;
```

**ランタイムのラッパーは無い** —— 同じオブジェクトで、型だけを狭めている。
歩調を合わせる実装が無いので、挙動を再検証する必要もない。

### 3. brand を parser から op まで流す

`suppliedRoot()` の戻り、`parseBeatQuery` の結果、`resolveStoryRequest` の戻り、
`BeatOpArgs.root`、`StoryWriteGuards`、`resolveStoryWriteTarget` の引数。
**型検査が 18 エラーで全箇所を指してくれる**ので、漏れは構造的に起きない。

### 4. sweep から、型が肩代わりした規則を外す

`test_storyRootSweep.ts` は **240行超 → 90行**。残したのは **#3014 のルール
「`resolveStory` の呼び出しは root を名指す」**だけ —— root が **optional** なので省略は今も
コンパイルが通り、これは型では言えない。

provenance（誰が root を作ったか）の規則は全部削除。型が、しかも**テキストルールが原理的に
見えなかった形まで含めて**保証するようになったため。

## 検証

brand が効くことは**型検査で**確かめる（5形）。とくに **D は #3083 round 6 で Codex が
「regex には見えない」と名指しした形**:

| 形                                                              | 結果     |
| --------------------------------------------------------------- | -------- |
| A. `movieStatusOp(p, req.query.root as string \| undefined)`    | **拒否** |
| B. `beatImageOp(p, 0, "acme")`                                  | **拒否** |
| C. インラインの fold（`typeof q === "string" ? q : undefined`） | **拒否** |
| D. **同一ファイルのヘルパー経由**で洗った root                  | **拒否** |
| E. `parseSuppliedRoot` を通した root                            | **通る** |

> **ハーネスの落とし穴**: 最初この検証を `server/tmpbrand.ts` に置き、`yarn typecheck | grep "error TS"`
> で見て「全部 0 エラー = brand が効いていない」と読んだ。実際は **grep が tsc の出力形式に
> 合っていなかった**だけで、同時に自分の変更が 18 エラーを出していたのも見えていなかった。
> **以後 typecheck は終了コードで判定する。**

残した sweep の2規則も break-verify 済み（root を名指さない呼び出し / 古い例外、どちらも赤）。

## やらないこと

**パッケージ側の署名は変えない。** `@mulmoclaude/mulmoscript-plugin` の ops は
`string | undefined` のまま。published API の破壊が無く、**MulmoTerminal は無改修**。
あちらは同じリスクを抱えたままで、それは別判断（#3086 の「決めること」1つ目）。

## 関連

- #3014 / #3076 / #3077 —— root 対応の系列。このクラスのバグの出所
- #3015 —— dispatch 側の `guardSuppliedRoot`（malformed root を拒否するルールの出所）
- #3083 —— テキストルールが5ラウンド消えた経緯
