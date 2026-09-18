# 開発・設置・運営の手順

[プロジェクトの説明に戻る](../README.md)

ここからは、自分のパソコンで動かしたり、Cloudflareに設置したりする人向けの説明です。

- **Workers**：サイトの画面を返し、投稿や回答を受け付ける実行サービス。
- **D1**：投稿・回答・表示履歴などを整理して保存するデータベース。
- **R2**：分析結果や公開前のデータ一式を、ファイルとして保管するサービス。このプロジェクトでは非公開で使います。
- **管理トークン**：運営者の操作を認証する秘密の文字列。公開コードには含めません。

## 構成と実行

Cloudflare Workersでサイトを動かし、D1に投稿・回答を、非公開R2に分析結果・公開候補を保存します。GitHubの公開データリポジトリには、運営者が確認して公開した版だけを保存します。

Node.js 22.13以上とPython 3が必要です。

```sh
npm ci
python3 scripts/export-source.py
npm run build
npx wrangler d1 migrations apply DB --local
npx wrangler d1 execute DB --local --file scripts/initialize-empty.sql
npm run dev
```

`initialize-empty.sql` は未使用のDB専用です。既存の回答があるDBでは使わず、集計の移行手順を確認してください。初回の `/api/community` 取得で40件の初期意見を登録します。

管理機能をローカルで試す場合、無視対象の `.dev.vars` に `MODERATION_TOKEN=...` を置きます。実際の管理トークンは公開コードに含めません。

### Cloudflareへの配置

1. 自分のCloudflareアカウントで `npx wrangler login` を行う。
2. D1と非公開R2を作成し、`wrangler.jsonc` の名前・DB IDを設定する。
3. `npx wrangler d1 migrations apply DB --remote` で未適用分だけを適用する。
4. 新規の空DBに限り `npx wrangler d1 execute DB --remote --file scripts/initialize-empty.sql` を実行し、`ready=1` を確認する。
5. `npm run build`、`node tests/run-isolated.mjs .` を実行する。
6. 管理トークンを `npx wrangler secret put MODERATION_TOKEN` で登録し、`npm run deploy` で配置する。

別の環境へ配置するときは `data/project.json` の連絡先・公開データ先と `MODERATION_REPOSITORY` も運営者自身のものに変更してください。R2の公開アクセスは有効にしません。Cloudflareの契約・保存容量・実行時間の制限は利用するプランに従います。

## 性能と分析
- 賛成・反対・パス・無関係の件数を差分更新。重複INSERTでは加算しません。
- 非表示・復元でも原票を残し、承認済み集計を調整します。
- 次の意見の抽選は意見の保存済み件数と当該セッションの履歴を読みます。
- 回答直後に全体一覧を再取得せず、次の提示だけを取得します。
- PCA・k-means・共通点には対象全セッションを使います。共分散と省メモリの表を用い、シルエット係数だけ固定標本で近似します。Polis本体との完全互換ではありません。
- 分析結果はR2で共有し、変化がある場合は閲覧時から約1分間隔で再計算します。掲載判断は直ちに無効化します。本人の印は応答時に付け、内部のセッションID対応は送りません。
- 分析には人数の固定上限を設けていませんが、ホスティングのCPU・メモリ・容量・クエリ数制限は別にあります。大規模運用では有料プラン等の実際の制限を確認してください。候補ログを各提示に保存する容量は引き続き増加します。

仕様は `public/methodology.md`、利用者向け説明は `/technology` にあります。ライセンスはAGPLv3（Polisの追加許諾を含む）です。Polisを参考にした実装を、このプロジェクト用に2026年9月18日に改変しています。

## 確認・研究・公開データ
新しい投稿は承認待ちです。プロジェクト専用の非公開運営リポジトリの確認一覧から判断し、原データから公開候補を作ります。運営用リポジトリの設定が揃い、有効化された場合に確認一覧を更新します。

schema 3では500原行ずつJSONLページを作成します。`prepare_release` → `continue_release` の繰り返しで、途中再開・並行操作に対応します。作成中の候補は公開できません。開始時の確定済みレコード上限と掲載判断の版を固定し、判断変更時は候補を無効にします。

完成したルートJSONのSHA-256を運営者が確認し、`publish_release` で承認します。`/api/export?release=ID` が固定版のルート、`&part=部品ID` がその版に属するページを返します。未公開候補の部品は取得できません。`?list=1` は公開版一覧です。旧schema 2も読めます。

GitHub同期スクリプトは各ページを検証して分割したまま保存します。投稿者との対応・認証情報・詳細イベントは公開対象に含めません。認証付き `view=raw` で原記録、`view=analysis&id=スナップショットID` で当時の共有分析結果を取得できます。

## 検証
次のテストは既存ローカルDBを変更しません。

```sh
npx tsc --noEmit
node --experimental-strip-types tests/math.test.ts
node --experimental-strip-types tests/math-scale.test.ts
node --experimental-strip-types tests/routing.test.ts
python3 tests/counters.test.py .
node tests/releases-scale.test.mjs
node tests/run-isolated.mjs .
```

最後のテストはビルド済みコードを別のポート5184・一時D1/R2で起動し、実際のAPIを通して確認します。サイトの既存5173は操作しません。

## 専用アカウントの接続
サイトの `MODERATION_REPOSITORY` へ専用の `owner/repository` を設定します。未設定なら掲載判断・公開操作を受け付けません。管理者の表示名は「すすすす」です。既存の履歴には個人情報が含まれうるため、新しい公開リポジトリは配布用ファイルだけから作り、以前のgit履歴や管理記録は移しません。
