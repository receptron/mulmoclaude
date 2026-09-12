# drift.mjs の CLI が `pending-publish` を「✓ src == published」と表示する (#3099)

## 症状

`node scripts/mulmoclaude/drift.mjs` を単体で回すと、**bump 済みだが未 publish** の
パッケージが完全に緑として表示される。1.16.0 のリリース準備中（`ee06d7646`）に出た行:

```
✓ @mulmobridge/client v1.1.0 → published v1.0.2: 9 value-export lines (src == published)
```

実際は src が 9 行、公開中 1.0.2 の dist が 8 行で、公開 dist に `resolveApiUrl` は無かった。
`✓` も `(src == published)` も事実に反し、しかも表示している数字は `localCount` だけなので
**公開側の 8 は画面に出ない** —— 読み手に見分ける手段が無い。

## 原因（測ったもの）

`formatLine`（`drift.mjs:268`）に `pending-publish` の分岐が無く、else の ok 分岐に落ちる。
`checkPackageDrift` は4状態を返す（`drift.d.mts:16`）のに `formatLine` は2つしか見ていない。

再現:

```
localCount (src @ ee06d7646)      = 9
distCount  (published 1.0.2)      = 8
drifted (local > dist)            = true
isLocalVersionAhead(1.1.0, 1.0.2) = true
=> status = pending-publish
```

**検出そのものは正しく動いている。壊れているのは表示だけ。**

## 直さないもの

- **`pending-publish` への降格**（`drift.mjs:187`）は意図的。export を足して version も上げた
  PR を cascade publish 前にブロックしないため、とコメントに理由がある
- **`smoke.mjs` の報告**。`runDriftStage`（`smoke.mjs:48`）は `pending publish (client@1.1.0)` と
  名指しするので、CI ゲートは素通りしていない。影響は SKILL.md §2 が案内している単体 CLI に限定される
- **リリース時に失敗させる `--release`**（issue の案 B）と **§6 のループのスクリプト化**（案 C）は
  別判断。C は「宣言 range が公開版で解決するか」という**別の問い**を見ているので、同じ issue に
  混ぜない

## 直し方

`formatLine` に `pending-publish` の分岐を足し、**両側の数と「未 publish」であること**を出す。

```
⧗ @mulmobridge/client v1.1.0 → published v1.0.2: src has 9 value-export lines,
  published dist has 8 — bumped but NOT published yet
```

`⚠`（drifted = 要対応）とも `✓`（clean）とも見た目で区別できる記号にする。

## なぜテストをすり抜けたか、どう閉じるか

`formatLine` は **export されておらずテストが1本も無い**。`test_drift.ts` は分類を厚く検証していて
`pending-publish` への降格も163行目で確認しているのに、**その結果がどう表示されるかは誰も見ていない**。

`formatLine` を export し、**4状態すべて**をテストする。テスト容易性のために純粋関数を切り出すのは
この repo の既定方針で、`countValueExportLines` / `isLocalVersionAhead` が既に同じ形。

**性質の断言をやめ、許される出力そのものを断言する**。レビューで**3ラウンド連続**、
性質を満たす別々の誤実装が出たため —— ラベル入れ替え / 1組のハードコード /
入れ替えたうえで正しい数を末尾に付け足す。**presence は「文字列を足す」で常に破れる**ので、
誤実装を並べるのは仕様ではなく待ち行列。

- **4状態すべて**（`ok` / `drifted` / `pending-publish` / `skipped`）を **行そのものの一致で
  断言**する。fallback 注記の有無も両方。期待文字列は fixture の数から組み立てるので、
  ハードコードした実装も落ちる。3組（17/4, 9/8, 231/5）で回す。
  数を持つ2状態だけ厳密にして `ok` / `skipped` を弱いまま残したら、**次の round でそこを
  突かれた**（` EXTRA` を足す実装が通った）—— site を直して twin を残す、そのもの
- これは**文言を変えると赤になる**。意図的にそうしている: この行は operator が
  「publish して安全か」を読む行で、**言い換えは判断であって副作用であってはならない**
- 弱い形の重複テスト（「ok と見分けられる」「not published と言う」「文言を維持」
  「fallback が落ちない」）は**一致断言に吸収された**ので残さない —— 期待文字列そのものに
  `⧗` と `bumped but NOT published yet` が入っており、意図はそこで読める

## 関連

- #3099 —— この issue
- #3097 —— 実害が出たリリース（`mulmoclaude@1.16.0`）
- #3078 / #3081 —— 未 publish だった `resolveApiUrl` の出どころ
