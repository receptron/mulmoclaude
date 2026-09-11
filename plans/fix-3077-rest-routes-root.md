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

`suppliedRoot(value)` を1つ置き、query / body から root を読む。**absent / 空文字 / 型違いは
すべて既定 root**として読む —— パッケージの dispatch が使う `str()` と同じ規則で、**1つの
リクエストがどちらの transport でも同じ意味**になるようにする。

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

### `/save` は触らない

このルートの body は**エージェントのツール引数**（`SaveMulmoScriptArgs`）そのもので、`root` は
意図的にスキーマに無い（#3015 —— モデルが root を名指しできないことが封じ込めの一部）。
sweep の例外にその1文ごと残す。

## テスト

- `test/server/api/test_mulmoScriptWriteRoot.ts` —— 書き込み先の決定を**両方向**から
  （許すもの / 拒むもの）。とくに「**どの拒否でも既定 root にフォールバックしない**」を明示。
  ミューテーション4種すべてで赤になることを確認
- `test/server/api/test_mulmoScriptBeatOp.ts` に factory の root 転送を**挙動で**追加
  （named / absent / 空 / 型違い）。これが sweep の「値渡し例外」を穴でなくしている
- `test_storyRootSweep.ts` の例外は**エージェント経路1件だけ**に戻る

## 関連

- #3014 / #3076 —— View 側。sweep もそこで入った
- #3015 / #3019 / #3020 —— パッケージ側の root 対応。書き込みの3ステップはそこの dispatch を鏡写し
