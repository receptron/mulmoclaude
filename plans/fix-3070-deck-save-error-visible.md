# デッキ編集の保存失敗を画面に出す (#3070)

## 症状

Canvas の Deck editor（Edit タブ）で保存が失敗しても、**画面には何も出ない**。出るのは
ブラウザコンソールの `[presentMulmoScript] deck save failed: …` だけ。

入力欄には書き換えた値が残る（editor は props の最新編集を保持し続ける）ので、画面上は
保存されたように見える。気づくのはリロードして値が戻ってから。

## 原因

`packages/plugins/mulmoscript-plugin/src/vue/composables/useDeckEditor.ts` の `flushDeckSave()`:

```ts
if (!response.ok) {
  console.error("[presentMulmoScript] deck save failed:", response.error);
  return; // ← 画面に伝える経路が無い
}
```

失敗が composable の中で終わっていて、View がそれを知る手段が無い。

なお「スナップバックさせない」設計自体は正しい（一時的な失敗で打鍵を捨てない）。
だからこそ **失敗が見えない = 成功に見える** という最悪の組み合わせになっている。
変えるのは可視性だけで、スナップバックしない挙動は変えない。

## 直し方

Media タブの既存の扱い（ビート保存の失敗はそのビートに赤字でサーバ文言を出す）に合わせる。

1. `useDeckEditor` が `deckSaveError: Ref<string | null>` を返す。
   - 失敗 → `deckSaveError.value = response.error`（`TransportResult` の失敗側は必ず `error: string`）
   - 成功 → `null` にクリアしてから `commitScript`
   - console.error は残す（既存の調査導線）
   - **応答は「今の編集」のものだけ採用する**（`editRevision`）。debounce が 300ms 空けるのは
     write の**開始**であって応答ではなく、失敗する write は遅い（タイムアウトは予算を丸ごと使う）。
     revision は保存を投げたときではなく**編集をキューに入れたとき**に進める —— その2点は最大 300ms
     離れていて、その隙間を write が生き延びる。古い内容についての応答は、通ったなら画面で打っている
     テキストの上に古い script を commit し、落ちたならもう画面に無いテキストについて赤を出す。
   - **別の script に移ったら忘れる**（`clearDeckSaveError()`）。この View は result 切替で
     remount せずその場で再初期化する（`watch(() => props.selectedResult, initializeScript)`）ので、
     残したままだと他人のデッキの上にメッセージが居座る。`beatSaveErrors` と同じ関数で同じ理由でリセット。
2. `View.vue` のタブ行直下に赤いバナーを出す。文言は既存の i18n キー
   `m.saveErrorSaveFailed(error)`（「⚠ Save failed: …」）を再利用 —— 新しいキーは足さない。
   - `role="alert"`、`data-testid="mulmo-script-deck-save-error"`
   - `v-if="deckSaveError"` だけで足りる（デッキ保存を試みない限り non-null にならない）。
     Edit タブから離れても消えないのは意図どおり —— 保存されていない事実は変わらない。

**編集ではクリアしない。** 消えるのは「次の保存が成功したとき」と「別の script に移ったとき」の
2つだけ。編集のたびに消すと、再保存が飛ぶ 300ms の間だけバナーが消えて点滅し、しかも次も失敗すれば
戻ってくる。失敗したまま放置された編集が見えている方が正しい。

**foreign write でのリロードでは消さない。** agent などが同じファイルを書いて画面が disk の内容に
入れ替わるとき、ユーザーの編集は確実に失われている。バナーはその唯一の痕跡なので残す
（消すと #3070 の「黙って消える」が狭い形で戻る）。

## テスト

`test/test_useDeckEditor.ts` を新規作成（node:test、vue の `computed`/`ref` を直接使う。
`api` はフェイクを注入するので DOM もランタイムも要らない）。

- 保存失敗 → `deckSaveError` にサーバ文言が入り、`commitScript` は呼ばれない
- 続けて成功 → `deckSaveError` が null に戻り、`commitScript` が呼ばれる
- 成功のみ → 一度も non-null にならない
- 失敗の後に編集をスケジュールしただけでは消えない（点滅防止の意図を固定する）
- 2回目の失敗は文言が**置き換わる**（積み上がらない）
- **2本同時飛び**（deferred promise で順序を作る）: 新しい方が成功 → 古い方が後から失敗しても
  バナーは出ない / 新しい方が失敗 → 古い方が後から成功しても commit しない
- **debounce 中にキューされただけの編集**でも、飛んでいる古い保存の応答は捨てる
- `clearDeckSaveError()` で消える

View 側は `data-testid` と `deckSaveError` / `clearDeckSaveError` の結線をソース読み取りで検証
（`test_beatPaneDefault.ts` と同じ手法 —— View を mount するにはランタイム一式が要る）。

## バージョン

`@mulmoclaude/mulmoscript-plugin` の bump は publish 時にまとめる（`@mulmoclaude/*` は
publish 時に決める運用）。

## 関連

- receptron/mulmoterminal#1970 — 報告元（@ystknsh の「考えられるアプローチ」3点目）
- #3014 — `File not found` になる経路そのもの（別軸・未着手）
- receptron/mulmoterminal#2036 — MulmoTerminal 側は絶対パスで回避済み
