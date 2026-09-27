---
title: はじめに — 起動するまで
layout: default
parent: 日本語
nav_order: 1
description: MulmoClaude を動かすのに必要なもの（Node.js と Claude Code）の準備から、起動、アイコンからの起動まで。
---

# はじめに — 起動するまで
{: .no_toc }

<details open markdown="block">
<summary>このページの内容</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

## 用意するもの

| 必要なもの | 何に使うか | 必須？ |
|---|---|---|
| **Node.js 22.19 以上** | MulmoClaude を動かす土台 | 必須 |
| **Claude Code** | MulmoClaude の頭脳。ログイン済みであること | 必須 |
| Docker Desktop | Claude の作業を安全な箱（サンドボックス）の中で行う | 任意（おすすめ） |
| ffmpeg | 動画を作るときだけ | 任意 |

### Node.js を入れる

[nodejs.org](https://nodejs.org/) から **LTS 版**をダウンロードしてインストールします。
入ったかどうかは、ターミナル（mac は「ターミナル」、Windows は「PowerShell」）で次を打つと分かります。

```bash
node -v
```

`v22.19.0` 以上の数字が出れば OK です。

### Claude Code を入れてログインする

[Claude Code のページ](https://claude.ai/code) の手順でインストールしたら、ターミナルで一度だけ

```bash
claude
```

を実行し、画面の案内に従ってログインします。ログインが済めば、ターミナルは閉じてかまいません。

{: .note }
MulmoClaude は、あなたの Claude Code のログインを使って動きます。別途 API キーを用意する必要はありません。

## 起動する

ターミナルで次の 1 行を実行します。

```bash
npx mulmoclaude@latest
```

しばらくするとブラウザが開き、[http://localhost:3001](http://localhost:3001) に MulmoClaude の画面が出ます。
これで準備完了です。

{: .warning }
**ターミナルを閉じると MulmoClaude も止まります。** 使っている間はターミナルを開いたままにしてください。

### アイコンから起動できるようにする（mac / Windows）

毎回ターミナルを開くのが面倒なら、一度だけ次を実行します。

```bash
npx mulmoclaude@latest create-shortcut
```

mac では「アプリケーション」に `MulmoClaude.app` が、Windows ではスタートメニューにショートカットができます。
以後はダブルクリックで起動できます。必要なものが足りないときは、何を入れればいいかを教えてくれます。

## 画面の言語

画面の言語は、ブラウザや OS の言語設定から自動で選ばれます。日本語の環境なら日本語で表示されます。

## データはどこに保存される？

MulmoClaude が作るものは、すべてあなたのパソコンの **`~/mulmoclaude`** フォルダ（ホームフォルダの中）に
普通のファイルとして保存されます。これを **ワークスペース** と呼びます。
クラウドに勝手にアップロードされることはありません。

---

準備ができたら、次は [コレクションとは](what-is-a-collection.md) へ。
すぐ作ってみたい人は [コレクションを作る](create.md) へどうぞ。
