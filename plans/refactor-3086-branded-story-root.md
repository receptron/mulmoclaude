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
- ops が export するメンバーは 32 種、うち **root を引数に取るのは 26 種**（位置引数が 22、
  引数オブジェクト経由が 4）。最初はこれを手で数えて **17 しか narrow していなかった**。
  26 種目の `runStoryOp` は round 2 で出た —— **sweep が読めない形を「root 無し」と同じ扱いに
  していた**ためで、下の「読めなかったら赤」を参照
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
代わりに、**root を取る 26 メンバーすべてに `ParsedStoryRoot` を要求する型**で見せる:

```ts
export const mulmoScriptOps: RootedMulmoScriptOps = rawOps;
```

**ランタイムのラッパーは無い** —— 同じオブジェクトで、型だけを狭めている。
歩調を合わせる実装が無いので、挙動を再検証する必要もない。

### 3. brand を parser から op まで流す

`suppliedRoot()` の戻り、`parseBeatQuery` の結果、`resolveStoryRequest` の戻り、
`BeatOpArgs.root`、`StoryWriteGuards`、`resolveStoryWriteTarget` の引数。
**型検査が全箇所を指してくれる**ので、漏れは構造的に起きない。

### 4. root を**必須**にする —— 省略も型で閉じる

`ParsedStoryRoot` は `undefined` を含むので、**既定 root は `undefined` と明示的に書く**。
optional のままだと「沈黙で既定を意味する」ことができ、それは #3014 のルール
（「呼び出しは root を名指す」）そのもので、**エイリアス経由だと textual sweep には見えない**:

```ts
const rs = mulmoScriptOps.resolveStory;
rs(filePath); // optional だった間はコンパイルが通った
```

必須にすると、直接呼び / エイリアス / destructure のどれもコンパイルエラーになる。

### 5. sweep は「型では言えない1つ」だけに

`test_storyRootSweep.ts` は **240行超 → 200行**、ルールは1つ（行数の半分は、下の
「読めなかったら赤」を成立させる導出そのもの）。

**どの値が root になれるか**も**名指しするか**も型が決めるようになったので、残るのは
**「ホストが narrow すべきメンバーを全部 narrow したか」**だけ。narrow し忘れたメンバーは
`string | undefined` のまま生き残るので、これは型では言えない。

そのチェックは**両側をソースから導出して突き合わせる** —— パッケージの source が
「どのメンバーが root を取るか」を、ホストの union が「どれを narrow したか」を語り、
パッケージに新しい root 付き op が入った日に赤くなる。

**読めなかったら赤**（round 2、Codex）。導出する側は「root を取らない」と「宣言が読めない」を
**区別できないと意味が無い** —— 外から見た答えが同じで、安全なのは片方だけだから。
実際これが起きていた: `async function runStoryOp<T>(` は generic なので宣言の regex に当たらず、
`backend` はファクトリの引数なのでどこにも宣言が無い。どちらも黙って「root 無し」に落ちていて、
**`runStoryOp` は本当に root を取る**（26 種目）。

**そして regex での読み取り自体をやめた（round 3）。** 同じ1箇所への指摘が3ラウンド連続で
出たので、ケースを足すのをやめて反転した —— #3083 でテキストルールに対してやったのと同じ判断:

| round | 読み違えた形 |
|---|---|
| 1 | 手で数えた 17 メンバーのリスト |
| 2 | `async function runStoryOp<T>(` —— generic なので宣言に当たらない |
| 3 | `const op = <T extends Record<string, unknown>>(…)` —— `indexOf(">")` が束縛の中の `>` で止まる |

3つとも**綴り**であって規則ではない。いまは **TypeScript 自身のパーサ**（`ts.createSourceFile`）で
ops.ts を読み、返しているオブジェクトリテラルのメンバーを AST で解決する:

- 返している各プロパティを、ファクトリ内のローカル宣言に解決する（shorthand / `name: impl` /
  インラインの arrow のいずれも）。**解決できなければ失敗**。`backend` のようなファクトリ引数だけは
  「op ではない」と明示的に分類する
- root を取るかは **`ts.ParameterDeclaration` を見て**判定する。括弧の数え間違い・generic の
  読み違い・コメント除去による破壊は、**そもそも起き得ない**
- root が**型の中**から来る形（`GenerateOpArgsWith<…>` → `GenerateOpArgs`、
  `RunStoryOpOptions<T>`、`RunStoryOpDeps`）は、名前を並べるのではなく
  **パッケージが宣言する型を AST で辿って**判定する。名前の列挙はこの PR が消したはずのもの

**9通りの形で赤を確認**: 上の表の3形 + callback の後ろの root + 新規 options interface +
`name: impl` 形 + インライン arrow + `" // )"` を含む文字列リテラル（regex 版のコメント除去が
壊していた形）+ union からの取りこぼし2種。

### 6. `backend` は narrow せず、**露出をやめる**（round 3、自分で発見）

`backend.artifactsFor?: (root: string) => FileOps | null` は**生の root を取る関数**で、
`mulmoScriptOps.backend.artifactsFor?.(req.query.root)` はコンパイルが通っていた ——
この PR が閉じようとしているクラスそのもの。呼び出し元は現時点で無いが、狭めた型は契約なので
`Omit<…, RootTakingOp | "backend">` で**外から見えなくした**。同じ問いには `artifactsForRoot` が答える。

ホスト自身が作ったオブジェクトなので narrow するのは筋が違う。`rawOps.backend` はモジュール内には残る。

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

**この表は round 2 で「書いてあるだけ」から「CI が落ちる」に変えた。**
`test/server/api/test_storyRootBrand.ts` に条件型の表明として置いてあり、`yarn typecheck` が
`test/` を見るので、`ParsedStoryRoot` を素の string に戻す・root を optional に戻す、のどちらも
コンパイルエラーになる。`@ts-expect-error` は CLAUDE.md が禁止しており、そもそも**行のどこかで
何かエラーが出れば通ってしまう**ので、`Assert<NotAssignable<string, ParsedStoryRoot>>` の方が強い。

sweep 側は 4 つのミューテーションで赤を確認済み: ホストの union から `runStoryOp` を落とす /
メンバーの宣言を読めない形にする / `runStoryOp` の引数型から root を両方（`RunStoryOpOptions` と
`RunStoryOpDeps`）消す / root を取らない `ffmpegGuard` を union に足す。

## やらないこと

**パッケージ側の署名は変えない。** `@mulmoclaude/mulmoscript-plugin` の ops は
`string | undefined` のまま。published API の破壊が無く、**MulmoTerminal は無改修**。
あちらは同じリスクを抱えたままで、それは別判断（#3086 の「決めること」1つ目）。

## 関連

- #3014 / #3076 / #3077 —— root 対応の系列。このクラスのバグの出所
- #3015 —— dispatch 側の `guardSuppliedRoot`（malformed root を拒否するルールの出所）
- #3083 —— テキストルールが5ラウンド消えた経緯
