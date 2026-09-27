---
title: schema.json のしくみ
layout: default
parent: 日本語
nav_order: 6
description: コレクションの設計図 schema.json の読み方。項目の種類、条件付きの項目、ボタン（アクション）、通知、カスタムビュー。
---

# schema.json のしくみ
{: .no_toc }

{: .note }
このページは**読まなくてもコレクションは作れます**。設計図は Claude が書き、書き込む前に自動でチェックされます。
「中はどうなっているの？」「どんなことが頼めるの？」を知りたい人向けです。

<details open markdown="block">
<summary>このページの内容</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

## 小さな例

行きたいお店のコレクションなら、設計図はたとえばこうなります。

```json
{
  "title": "行きたいお店",
  "icon": "restaurant",
  "dataPath": "data/restaurants/items",
  "primaryKey": "id",
  "fields": {
    "id":      { "type": "string",  "label": "ID", "primary": true, "required": true },
    "name":    { "type": "string",  "label": "店名", "required": true },
    "genre":   { "type": "enum",    "label": "ジャンル", "values": ["和食", "中華", "イタリアン", "その他"] },
    "visited": { "type": "boolean", "label": "行った" },
    "rating":  { "type": "number",  "label": "評価", "when": { "field": "visited", "in": ["true"] } },
    "memo":    { "type": "text",    "label": "メモ" }
  }
}
```

読み方:

| 部分 | 意味 |
|---|---|
| `title` / `icon` | 画面に出る名前とアイコン（[Material Symbols](https://fonts.google.com/icons) の名前か、絵文字 1 文字） |
| `dataPath` | 記録を置くフォルダ |
| `primaryKey` | どの項目を ID（＝記録のファイル名）にするか |
| `fields` | 項目の一覧。書いた順が表の列の順番になります |
| `"when"` | 条件付きで表示。上の例では「行った」にチェックが付くまで「評価」は隠れます |

## 項目の種類

| 種類 | 何を入れるか | 画面では |
|---|---|---|
| `string` | 1 行の文字 | 入力欄 |
| `text` | 複数行の文字 | 大きな入力欄 |
| `markdown` | 見出しや箇条書きのある文章 | 整形して表示 |
| `email` | メールアドレス | |
| `number` | 数 | |
| `money` | 金額（通貨つき、例: 円） | 通貨の書式で表示 |
| `date` | 日付（`2026-10-01`） | **カレンダー** で見られるようになる |
| `datetime` | 日時（`2026-10-01T19:00`） | 同上 |
| `boolean` | はい / いいえ | チェックボックス。表から直接切り替え可 |
| `enum` | 決まった選択肢から 1 つ | プルダウン。**カンバン** で見られるようになる |
| `image` | 画像 | 詳細に画像を表示 |
| `file` | ファイル | 開けるリンク |
| `table` | 表（明細など、行が増える項目） | **行を追加** / **行を削除** |
| `ref` | ほかのコレクションの記録へのリンク | 例: 請求書 → 取引先 |
| `embed` | ほかのコレクションの記録を中に表示 | |
| `backlinks` | 自分を指している記録の一覧（`ref` の逆向き） | 例: 取引先から見た請求書の一覧 |
| `rollup` | `backlinks` の合計や件数 | 例: 取引先ごとの請求合計 |
| `derived` | 計算して出す値（`+ - * /`、合計など） | 例: 数量 × 単価 |
| `toggle` | 選択肢の項目を、チェックボックスとして操作する | 例: 「完了」チェック ⇔ 状態が「完了」 |
| `flag` | 条件に合うかどうか（計算で決まる） | **絞り込み** メニューに出る |

## ボタン（アクション）

記録の詳細や、コレクションのヘッダーにボタンを付けられます。種類は 3 つです。

| 種類 | 押すと | 向いていること |
|---|---|---|
| `chat` | その記録について **Claude とのチャットが始まる** | 請求書の PDF を作る、メールの下書き |
| `agent` | **裏で Claude が作業して**、記録が更新される（チャットは出ない） | 最新の株価を取ってくる、情報を調べて書き足す |
| `mutate` | **Claude を使わず**、決まった値をすぐ書き込む | 「支払い済みにする」「担当者を決める」 |

「〇〇ボタンを付けて」と頼めば、Claude が適した種類を選んで付けてくれます。

## 通知（ベル）

| 書き方 | 意味 |
|---|---|
| `completionField` と `completionDoneValues` | 「完了」になっていない記録を通知に出す |
| `notifyWhen` | 条件に合う記録だけ通知する |
| `triggerField` と `triggerLeadDays` | 日付の N 日前から通知する |
| `spawn` | 完了したら次の回の記録を自動で作る（毎月の支払いなど） |

## 見え方

| 書き方 | 意味 |
|---|---|
| `calendarField` | カレンダーでどの日付を使うか |
| `kanbanField` | カンバンでどの選択肢で列を分けるか |
| `displayField` | カードや通知に出す名前にどの項目を使うか |
| `color` | コレクションの色（`violet` `indigo` `sky` `teal` `emerald` `lime` `fuchsia`） |
| `views` | カスタムビュー（HTML で作った自由な見た目）の一覧。スマホ用は `"target": "mobile"` |

## 自分で書き換えたいときは
{: #edit-by-hand }

`schema.json` を直接エディタで書き換えることもできますが、書き間違えるとコレクションが**一覧から消えてしまいます**
（壊れた設計図は読み込まれません）。Claude に「〇〇に変えて」と頼めば、書き込む前に全体をチェックしてくれるので、
そちらをおすすめします。

もっと詳しい仕様は、Claude 向けの手引き
[collection-skills.md](https://github.com/receptron/mulmoclaude/blob/main/packages/core/assets/helps/collection-skills.md)（英語）にあります。

---

次は [困ったとき](faq.md) へ。
