# fix(deps): plugin の `@mulmoclaude/common` を peer + dev に揃える (#3117)

`@mulmoclaude/core` は 8 plugin で `devDependencies` + `peerDependencies` に揃っているのに、
`@mulmoclaude/common` は 6 plugin が `dependencies` で宣言していた。CLAUDE.md の規則:

> A plugin declares host-provided packages as `peer` + `dev` — never `dependencies`.
> `dependencies` makes npm install a **second copy nested under the plugin**, so the plugin
> and the host each get their own module instance.

launcher 自身が `@mulmoclaude/common` を宣言しているので common も host 提供 package。
**方針 (a)**（ユーザー判断 2026-09-13）: 規則の文面は変えず、**6 つを core と同じ形に揃える**。

## 現状 → 目標

| plugin | 現状 | 目標 |
|---|---|---|
| `x-plugin` | `dependencies: ^1.3.0` | `peerDependencies` + `devDependencies` |
| `accounting-plugin` | 同上 | 同上 |
| `html-plugin` | `dependencies` **と** `devDependencies` の両方 | `dependencies` を削り peer を追加（dev は既にある） |
| `mulmoscript-plugin` | `dependencies: ^1.3.0` | `peerDependencies` + `devDependencies` |
| `spotify-plugin` | 同上 | 同上 |
| `markdown-plugin` | 同上 | 同上 |

**`dependencies` から消すだけでは駄目**（import しているものが未宣言になる）。CLAUDE.md が
明記しているとおり、**peer への追加と dev への追加が対になる**。6 つとも実際に src から
common を import している（3 / 9 / 2 / 10 / 3 / 2 ファイル）。

## 検証すること

- `check:launcher-sync` の "no peer-dep violations" — launcher は `@mulmoclaude/common: ^1.3.0` を
  宣言しているので新しい peer（`^1.3.0`）を満たす。**これが唯一の機械的ゲート**
- lockfile が変わらないこと（workspace 内部解決なので変わらない見込み。変わったら
  クリーン install で検証する — 温かい `node_modules` は嘘をつく）
- 6 plugin が standalone でビルド/テストできること（dev 宣言がそれを担保する）
- 各 plugin の build + typecheck + test

## この PR でやらないこと

- **規則の文面は変えない**。判定基準（module state / singleton 要求）を書き足す案 (b) は採らない
- **publish はしない**。配置変更は各 plugin の次の publish でユーザーに届く。
  それまで npm 上の 6 つは `dependencies` のまま = 現状と同じ挙動
