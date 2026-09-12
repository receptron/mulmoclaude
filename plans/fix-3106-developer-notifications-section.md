# fix: `developer.md` の Notifications 節を実装に合わせる (#3106)

## 背景

`docs/developer.md` の `## Notifications (PoC scaffold)` 節（約 100 行）が、
**削除済みの PoC** を今も「the endpoint and fan-out are **stable**」として説明しています。
`docs/` で notifications を扱う場所はここだけなので、「古い」ではなく「**唯一の記述が嘘**」です。

**一番まずいのは `curl -X POST /api/notifications/test` のレシピ**です。この経路は消えただけでなく、
**意図的に塞がれています** — `server/api/routes/notifier.ts` の冒頭が理由を述べています:
bearer 認証は「このマシンの誰かがトークンを知っている」ことしか証明せず、
「呼び出し元がプラグイン X である」ことを証明できないため、HTTP publish は任意のプラグイン名義で
publish できてしまう。**ドキュメントが、塞いだ穴を勧めている**状態です。

## 方針

**節を消すのではなく、実装に合わせて書き直す。** 消すと「notifications の記述がゼロ」になり、
実在する notifier エンジン（永続化・bell・history）が未文書のまま残ります。
ただし**読んでいないことは書かない** — 下の「典拠」に挙げたものだけを根拠にする。

## 典拠（実際に読んだもの）

| 事実 | 典拠 |
|---|---|
| entry / lifecycle / severity の契約、publish 時の 2 ルール | `packages/core/src/notifier/types.ts`（コメントが詳細） |
| `publish` を HTTP に出さない理由 | `server/api/routes/notifier.ts:1-21` |
| dispatch エンドポイントの action 4 種 | `server/api/routes/notifier.ts` + `src/config/apiRoutes.ts:224-226` |
| エンジンの公開 API | `packages/core/src/notifier/engine.ts` の `export` 一覧 |
| 永続化ファイルと `HISTORY_CAP = 50` | `packages/core/src/notifier/types.ts` |
| pubsub チャンネル名と `NotifierEvent` の 4 型 | `src/config/pubsubChannels.ts:199`、`types.ts` 末尾 |
| legacy ラッパーの役割・bridge fan-out が消えた理由 | `server/events/notifications.ts:1-28` |
| bell 側の購読と再構築 | `src/composables/useNotifications.ts` |
| e2e の実際の対象 | `e2e/tests/notifications.spec.ts` の 4 describe |

## 変更

1. `## Notifications (PoC scaffold)` → notifier エンジンの節として書き直し
   - PoC の curl / body 表 / fan-out 図 / Observing / Scope caveats を**削除**
   - 代わりに: entry の契約、publish の 2 ルール、**publish が HTTP に無い理由**、
     dispatch エンドポイント、永続化、pubsub、legacy ラッパー
2. `### Notification permalinks (#762)` — `action.target` の型表は**実装から消えている**
   （`src/utils/notification/dispatch.ts` は不在）。今は `navigateTarget`（相対 URL 文字列）1 本で、
   legacy な typed action は `legacyActionToNavigateTarget()` が平坦化する。そう書き直す
3. `#### Manual testing` — 参照するスクリプトが不在。**削除**し、実在する e2e に置き換える
4. `#### Automated coverage` — 不在の unit test を、実在する
   `test/server/notifier/test_engine.ts` / `packages/core/test/notifier/test_engine.ts` に差し替え

## 対象外

- notifier エンジン自体の変更。**ドキュメントのみ。**
- `plans/done/feat-notification-*.md`（歴史的記録なので、当時の記述のままでよい）

## 検証

- 節が名指しする**すべてのパス・ルート・定数の実在**を 1 つずつ確認する（issue の表と同じ方法）
- `check:doc-links` / `check:changelog-ships`
- 節に書いた主張を、上の「典拠」の行と突き合わせる

## レビューで広がった範囲（round 1〜9）

cross-review で **21 件**出ました（round 1〜9 の triage コメントで通し番号を振ってあります)。
**1 件も「壊れたコード」ではなく、全部が誤った記述**です。
そして**過半数は `packages/core/src/notifier/` と `server/` のコメント**にありました — つまり
**この節を書くときの典拠**です。典拠が間違っていたので節も間違い、写した側だけ直すと
**出どころが次の読者を同じ穴に落とす**ので、両方直しています。

（件数を「何件がコメント側か」と数え上げる書き方は最初にしていましたが、数え直すと合いませんでした。
finding #10 —「手で数えた一覧は時限式の嘘」— と同じ失敗なので、数えない形に直しています。）

### 生成器は 5 つ

| 変更 | 生き残った記述 |
|---|---|
| `f522dc101` PoC ルートと bridge fan-out を**削除** | `notify.ts` の tool description / prompt、`diagnostics.ts`、`src/types/notification.ts`、`server/index.ts` の mount コメント |
| `#789` 環境変数を**改名 + 極性反転**（`MACOS_REMINDER_NOTIFICATIONS` → `DISABLE_…`） | `developer.md` の env 表、`notify.ts` の 2 文字列 |
| `#2617` 設定画面のトグルを**追加** | env 表、`notify.ts` の prompt |
| `updated` イベントを**追加** | `pubsubChannels.ts` の docblock |
| （変更ではなく）**最初から使えないレシピ** | `runtime-api.ts` と `runtime-tasks-api.ts` の「プラグインはこう import する」 |

**「1 つの誤った考えが複数の住処を持つ」が最頻**でした（HTTP parity は **5 箇所**、
bridge 配信は **4 箇所**、プラグインの import レシピは **2 箇所**）。
直すたびに「他に住処は無いか」を grep する手順が、findings の半分を潰しています。

### 私自身が 2 回、偽の主張を別の偽の主張で置き換えた

`updateForPlugin` は throw しない / `fyi` は deep link を持つ。**コメントを書き換えるときは、
書き換えた内容を実装と突き合わせ直す**必要があります。コミットメッセージのテスト件数も 2 回間違え、
どちらも amend で訂正しました。

## 対象外（追記）

- `## [0.5.0]` の CHANGELOG が旧環境変数名を書いている件 — **そのリリース時点では正しい**ので触らない
  （公開済みセクションは書き換えない規律）。
- chat-service の `pushToBridge` 経路 — **現役**。消えたのは notifier の fan-out だけ。
