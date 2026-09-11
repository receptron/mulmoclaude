# mulmoScript の REST ルートが root を渡していない (#3077)

## 症状

`server/api/routes/mulmo-script.ts` の REST アダプタが story を **`filePath` 単体で指していた**。
`stories/deck.json` は登録済み root ごとに存在するので、登録 root を持つホストがこれらのルートを
叩くと**既定 root の同名ファイル**を読み書きする。**静かに間違う**（`stories/deck.json` はどちらの
root でも正しいパスなので、下流の誰も気づけない）。

#3076 で入れた `test/plugins/mulmoscript/test_storyRootSweep.ts` が 11 箇所を列挙していた。

## 前提（#3076 で測ったもの、ここでも変わらず）

この repo にはこの面の**呼び出し元が無い**。`pluginEndpoints<MulmoScriptEndpoints>` を使うのは
`src/plugins/presentMulmoScript/index.ts` の1ファイルだけで、使うのは download 2本（#3076 で
root 対応済み）。View は root 対応の **dispatch 経路**を通る。

**それでも直す理由**: 登録 root を持つホストがこのルートを叩いた瞬間に静かに壊れる。#3076 では
「黙った穴を書かれた穴にする」ところまでにしたので、ここで閉じる。

## 直し方

### 読み取り・アップロード系（9 箇所）

`parseSuppliedRoot(value)`（純粋関数）を1つ置き、query / body から root を読む。
**absent と空文字は既定 root**、**string でないものが present なら 400 で拒否**する ——
折りたたんではいけない。折りたたむと「呼び出し側は別の root を名指したつもりなのに、既定 root の
同名 script を読み書きする」という #3015 が dispatch 側で直した欠陥そのものになる
（`guardSuppliedRoot`。`?root=` を2回書くと配列になるので、事故でこの形が届く）。

> **この PR の最初の版はここを間違えていた。** dispatch の `str()` と揃えたつもりで、実際の
> dispatch は単一エントリで `guardSuppliedRoot` により**型違いを 400 で拒否**している。
> しかも「型違いは既定に落ちる」と assert するテストを書いて通していた。round 1 で自分と Codex が
> 独立に発見。

- GET: `beatImage` / `beatAudio` / `beatMovie`（`parseBeatQuery` が返す）、`movieStatus` /
  `pdfStatus` / `characterImage`（`req.query.root`）
- POST: `uploadBeatImage` / `uploadCharacterImage` / `renderCharacter`（`req.body.root`）

### beat 生成系（2 箇所）—— factory 経由

`makeBeatOpHandler(op, …)` は op を**値として**受け取るので、呼び出し側に引数リストが無い。
`BeatOpArgs` / `BeatOpBody` に `root` を足し、factory が body から読んで渡す。
これで2箇所とも一度に閉じる。

### 書き込み系（updateBeat / updateScript）

**一番危険な部分**なので、ルールを純粋関数に切り出す —— `server/api/routes/mulmoScriptWriteRoot.ts`
の `resolveStoryWriteTarget(guards, filePath, root)`。dispatch と**同じ3ステップ・同じ順序**:

1. `guardStoryWriteRoot(root)` —— このホストがその root に書いてよいか
2. `guardStoryWirePath(filePath, root)` —— その wire path がその root のものか（**path 単体では
   判定できない**。`stories/deck.json` はどの root でも整形式）
3. `artifactsForRoot(root)` —— その root に束ねた FileOps。無ければ**既定にフォールバックせず**
   未登録として拒否する

guards は注入するので、プラグインのランタイム無しで駆動できる。

### ダウンロード2ルート（round 3 で追加）

`downloadMovie` / `downloadPdf` は `getOptionalStringQuery(req, "root")` で root を読んでいた。
これは**非 string を `undefined` に畳む**ので、`?root=a&root=b`（配列）が既定 root になる ——
他で消したはずの fold が、#3076 で自分が書いたコードに残っていた。`suppliedRoot` 経由へ。

### session 再水和（round 3 で追加）

`enrichWithMulmoScript` も同じ fold をしていた。壊れた root は **absent ではなく corrupt** なので、
既定 root の同名デッキをセッション履歴に混ぜず、この関数の既存契約（「失敗したら entry をそのまま
返す」）でそのまま返す。

### ルールの反転（round 3）

同じルールへの**3件目**だったので、ケースを足すのをやめて反転した。
`test_storyRootSweep.ts` に**呼び出し単位**で: story op に root を渡すファイルでは、
`const root` / `const { … root … }` の**初期化が必ず `parseSuppliedRoot` / `suppliedRoot` から**
であること。最初はファイル単位（「どこかで parser に触れているか」）にしたが、Codex が4通りで
素通りした —— 同じファイルの別の正当な parse が `getOptionalStringQuery` を隠していた。

**このガードは round 3〜5 で3回締め直し、そこで止めた。** regex には天井があり、
2回の拡張はどちらも誤爆した —— すべての member read（`\w+.root`）は `const { … root … } = parsed`
を、素の `query.root` は `beatImageOp(query.filePath, query.beatIndex, query.root)` を報告した
（`query` は `parseBeatQuery` の**解析済み**結果であって `req.query` ではない）。

いま断言するのは、**このループが実際に見つけた fold の形**だけ:
直接代入 `const root = <parser 以外>`、および **request から直に** op へ渡す形
（`req.query.root` / `req.body.root`）。

**報告しない形は列挙してある**（docblock）: 別ファイルのヘルパー経由、`ops["movieStatusOp"]` 等の
綴り、destructure された root（来歴が見えない）、上記以外の1式で読んで渡す形。
4つとも本当の封じは `parseSuppliedRoot` だけが作れる branded type だが、パッケージの
シグネチャ変更になるのでこの PR には入れない。コメントは走査前に除去しているので
`// parseSuppliedRoot` で偽装はできない。

### SSE の生成2ルート（round 5 で追加）

`generateMovie` / `generatePdf` は root で story を解決していたが、**パッケージの
`guardStoryGenerationRoot` を迂回**し、さらに生成イベントと成果物 ref から root を落としていた。

このガードは「このホストは2つの root の生成状態を区別できるか」を判定するもので、
`rootScopedGenerationState` を宣言していないホストでは**名前付き root の生成を拒否**する ——
生成の start イベントは story を解決する前に publish されるので、未対応の root は
「存在しない作業の start/finish ペア」を出してしまう（#3020）。迂回していた以上、
rooted な生成はそのまま走っていた。

いまは ffmpeg ガードより**前に** root を parse して `guardStoryGenerationRoot` を通し、
`publishGeneration(..., { root })` と `outputRef(..., root)` にも渡す。

### `/save` は触らない

このルートの body は**エージェントのツール引数**（`SaveMulmoScriptArgs`）そのもので、`root` は
意図的にスキーマに無い（#3015 —— モデルが root を名指しできないことが封じ込めの一部）。
sweep の例外にその1文ごと残す。

## テスト

- `test/server/api/test_mulmoScriptWriteRoot.ts` —— `parseSuppliedRoot` を**両方向**から
  （通す形 / 拒む形、および「ok のとき root は必ず string か undefined」という呼び出し側が
  依存している性質）。加えて書き込み先の決定を**両方向**から
  （許すもの / 拒むもの）。とくに「**どの拒否でも既定 root にフォールバックしない**」を明示。
  ミューテーション4種すべてで赤になることを確認
- `test/server/api/test_mulmoScriptBeatOp.ts` に factory の root 転送を**挙動で**追加
  （named / absent / 空 → 既定、型違い → **400 かつ op を呼ばない**）。これが sweep の「値渡し例外」を穴でなくしている
- `test_storyRootSweep.ts` の例外は**エージェント経路1件だけ**に戻る

## 関連

- #3014 / #3076 —— View 側。sweep もそこで入った
- #3015 / #3019 / #3020 —— パッケージ側の root 対応。書き込みの3ステップはそこの dispatch を鏡写し
