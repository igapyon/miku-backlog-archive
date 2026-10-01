# miku-backlog-archive

Backlog の内容をローカルに保存し、静的 HTML 一式として閲覧できるようにするツールです。

課題や Wiki、添付ファイル、共有ファイルを手元に残し、Backlog に接続しなくてもプロジェクトの内容を読めることを目指します。

## Backlog へのアクセスは READ のみ

**本ツールは Backlog に対して READ（読み取り）操作だけを行います。** 課題・コメント・Wiki・共有ファイルなど、Backlog 側のデータを作成・更新・削除する操作は実行しません。

通信に使う `miku-backlog-api` Runtime 自体は作成・更新・削除にも対応していますが、本ツールが呼び出すのは取得・ダウンロード操作だけです。API キーの権限とは別に、Runtime の呼び出しごとに許可する権限を `READ` だけに制限し、Runtime 側でも操作に必要な権限を照合します。通常の CLI は、固定したバージョンと SHA-256 に一致する Runtime を検証して利用します。仕組みの詳細は [miku-backlog-api との連携方針](docs/backlog-api-integration.md#読み取り専用の制限) を参照してください。

この読み取り専用の制限は Backlog へのアクセスについてのものです。ローカルの出力先には、取得データ・添付ファイル・進捗記録・生成 HTML を作成・更新します。

## 開発状況

CLI の `init`、`verify`、`runtime verify`、`collect`、`render`、`report` を実装済みです。Backlog からプロジェクト、課題、コメント、参加者、関連課題、現在版 Wiki、課題・Wiki 添付、共有ファイルを取得し、保存データからホーム・課題・Wiki・ファイルの静的 HTML を生成します。閲覧画面はセマンティックな HTML と共通 CSS で Material Design 3 の配色・文字・余白・形状を使います。利用者によるブラウザー表示確認は実施済みです。

本文表示は安全な部分対応です。取得済み添付への限定的な画像参照、取得済み課題・Wikiへの内部リンク、共有ファイルへのリンク、基本的な Markdown 表示に対応しています。Wiki本文・ホーム説明・課題説明・コメントの `[[Wikiページ名]]` は、保存済みWiki題名に一意に一致する場合にローカルリンクになります。自動回帰確認は実施済みですが、`file://`・オフライン条件やアクセシビリティなど、個別の受け入れ確認と環境の記録が残っています。Backlog／Markdown の完全な記法互換は未実装で、コメントだけに添付された画像が現在の取得経路で扱えるかは未確認です。未完了作業は [TODO.md](TODO.md) にまとめています。

## 基本構想

Backlog からデータを取得する処理と、保存データから HTML を生成する処理を分けます。
Backlog との通信には `miku-backlog-api` を利用します。
データベースは使わず、保存データと取得の進捗は JSON などのファイルで管理します。

```text
Backlog
  ↓ miku-backlog-api による取得
ローカルの保存データ（JSON・添付ファイル・共有ファイル）
  ↓ HTML 生成
静的 HTML 一式
  ↓
ブラウザーでオフライン閲覧
```

保存データから HTML を再生成できる構成にし、表示の改善だけであれば Backlog からの再取得を不要にします。

選択した対象範囲の全件取得を基本とし、完了済みアーカイブに更新内容を差分反映する機能は対象外とします。
取得途中で中断した場合は、保存済みデータと進捗記録を使い、未完了の取得から続きを再開できるようにします。
再開は同じアーカイブ作成を完了させるための機能です。完了後に最新の内容を保存する場合は、新しい全件取得として扱います。

製品名の `archive` は、内容を保存して後から閲覧する用途を表します。
Backlog への復元は、将来の拡張を含めて恒久的な機能対象外です。本ツールは一方向の閲覧用アーカイブであり、完全な復元用バックアップとしての保証はありません。

## 想定する利用場面

主用途は、完了したプロジェクトを後から参照できる形で保存することです。課題の経緯、Wiki、添付ファイル、共有ファイルを、Backlog への接続を前提にせず閲覧できる状態で残します。

進行中のプロジェクトでは、リリース、移行、体制変更などの節目に、その時点の内容を別のアーカイブとして保存します。完了したアーカイブは更新せず、後の時点を保存する必要がある場合は新しい全件取得を作成します。

このツールは日常的な同期、Backlog への復元、法令・規程上の保存要件を満たすことの保証を目的にしません。生成物の保管場所と共有範囲は利用者が管理します。

## 初期版の対象範囲

取得単位は指定した 1 プロジェクトです。課題・コメント・参加者・関連課題、取得時点の Wiki、課題と Wiki の添付、共有ファイルをローカルに保存します。課題の保存項目と個人情報の扱いは [docs/issue-data.md](docs/issue-data.md) を参照してください。

| 対象 | 対応状況と境界 |
| --- | --- |
| 課題・コメント | 取得・保存し、課題詳細 HTML に表示します。コメントに付随する変更記録を含みます。 |
| Wiki | 取得時点の現行ページを取得・表示します。過去版は対象外です。 |
| 課題・Wiki の添付 | メタデータと本体を保存します。保存済み添付と対応づけられる本文記法だけをローカル表示します。 |
| コメント中の画像 | 課題添付として取得済みの画像は本文から参照できます。コメントだけに添付されたファイルが取得・対応づけできるかは未確認です。 |
| 共有ファイル | フォルダ構成と本体を保存し、一覧・フォルダ移動・本文中の対応リンクを生成します。 |
| HTML | `render` はホーム、課題一覧・詳細、Wiki 一覧・詳細、共有ファイル一覧、収集状況レポートをセマンティックな HTML とローカル共通 CSS で生成します。 |
| 内部リンク・画像 | 取得済みであることを確認できる対応範囲だけを相対リンク／ローカル画像へ変換します。`[[Wikiページ名]]` はホーム説明・課題説明・課題コメント・Wiki本文で、題名が一意に解決できる場合に限りローカルリンクにします。外部画像は取得・自動読込しません。 |

本文の画像・内部リンクの詳細な対応条件は [docs/inline-images.md](docs/inline-images.md) と [docs/internal-links.md](docs/internal-links.md)、履歴の対象範囲は [docs/history-scope.md](docs/history-scope.md) を参照してください。

## 対象外の機能

| 機能 | 方針 |
| --- | --- |
| 完了済みアーカイブの差分更新、Backlog への復元 | 対象外。更新時点を残す場合は別の空の出力先に全件収集します。 |
| 課題・Wiki の完全な過去履歴 | 初期版の対象外。課題コメントの変更記録と Wiki 現行版を保存します。 |
| ガントチャート | 初期版の対象外。将来の STEP2 候補です。 |
| ボード、Git／Subversion、プロジェクト設定、ドキュメント、課題の追加 | 対象外です。 |

## 保存と閲覧の考え方

- API が返したデータを保存し、HTML はローカルデータだけから生成します。保存対象は API キーに付与された読み取り権限で取得できる範囲です。
- 収集失敗は対象や HTTP 状態とともに記録し、未完了タスクがある場合は完了扱いにしません。進捗、再試行、レート制限の仕様は [アーカイブ形式 v1](docs/archive-format.md) と [miku-backlog-api との連携方針](docs/backlog-api-integration.md) に記載しています。
- 課題一覧に必要な情報が含まれる場合は、その正規化済みデータを課題本体にも再利用して API 呼び出しを減らします。
- API キーはアーカイブ、生成 HTML、ログに保存しません。生成 HTML は Backlog のアクセス制御を引き継がないため、保存先や共有先の閲覧範囲は利用者が管理してください。

## 既知の制約

- 収集は一時点を固定するスナップショットではありません。取得中に Backlog 側の一覧が変わると、ページ境界の変化で重複や取りこぼしが起きる可能性があります。
- コメント一覧のページ位置は保存しないため、中断した課題のコメントは先頭から再取得します。途中で失敗したファイルも、次回はファイル全体を先頭から再ダウンロードします。
- レート制限スケジューラはこのプロセス内だけで動作します。他アプリ・他プロセスとの利用枠は調整できず、429を完全には防げません。

詳細は [アーカイブ形式 v1](docs/archive-format.md#取得時点と再開の制約) と [miku-backlog-api との連携方針](docs/backlog-api-integration.md#実装前の互換性確認) を参照してください。

## 生成ページとリンク

生成サイトには「ホーム」「課題」「Wiki」「ファイル」のページを作ります。課題・Wiki・共有ファイルへの本文リンクは、収集済み ID と保存済み本体の両方を確認できる場合に限り、相対リンクへ変換します。コメントアンカーを含む URL の条件、対象外リンクの扱い、出力ファイルの配置は [本文中の内部リンク](docs/internal-links.md) と [アーカイブ形式 v1](docs/archive-format.md) を参照してください。

生成ファイルは `file://` で開ける相対参照を使います。自動テストに加えて、取得済みアーカイブの474ページ、8,622件のローカル参照を検証し、リンク先・アンカーの欠落がないことを確認しました。利用者による表示確認も実施済みです。ネットワーク遮断や支援技術など、条件別の確認記録は [TODO.md](TODO.md) に記載しています。

## 現在利用できる CLI

Node.js 22 以降で、依存ライブラリを追加せずに実行できます。`init` と `verify` は Backlog に接続せず、`runtime verify` は Runtime ファイルだけを検証します。`collect` は実行時環境の認証情報を使って Backlog を読み取り専用で収集します。

`collect` の認証情報は、次の手順で設定します。

1. Backlog の「個人設定」>「API」から API キーを発行します（[Backlog ヘルプ: API の設定](https://support-ja.backlog.com/hc/ja/articles/360035641754-API%E3%81%AE%E8%A8%AD%E5%AE%9A)）。
2. このリポジトリのルート、つまり `README.md` と同じ場所に `.env` ファイルを作ります。
3. `BACKLOG_DOMAIN` には Backlog URL のホスト名だけを記入し、`BACKLOG_API_KEY` には発行したキーを記入します。たとえば URL が `https://example.backlog.com` なら、ドメイン値は `example.backlog.com` です。`https://` やパスは含めず、アーカイブ作成時の `--source-domain` と同じ値にします。

`.env` の内容は次の形式です。

```dotenv
BACKLOG_DOMAIN=example.backlog.com
BACKLOG_API_KEY=your-backlog-api-key
```

`.env` は `.gitignore` に登録済みなので Git には追加されません。API キーを含むファイルを共有・コミットしないでください。

CLI は `.env` を自動では読み込みません。リポジトリのルートから、Node.js の [`--env-file` オプション](https://nodejs.org/api/cli.html#--env-fileconfig) を付けて `collect` を実行すると `.env` が読み込まれます。`example.backlog.com` と `your-backlog-api-key` は自分の値に置き換えます。

```sh
node src/cli.mjs init \
  --output ./my-archive \
  --source-domain example.backlog.com \
  --project-key DEMO
node src/cli.mjs verify --output ./my-archive
node src/cli.mjs runtime verify --runtime ./miku-backlog-api-runtime-0.8.0.mjs
node --env-file=.env src/cli.mjs collect \
  --archive ./my-archive \
  --runtime ./miku-backlog-api-runtime-0.8.0.mjs
node src/cli.mjs render --archive ./my-archive
node src/cli.mjs report --archive ./my-archive
```

`init` は空の出力先だけを受け付け、既存ファイルを上書きしません。`collect` は manifest のドメインと実行時の `BACKLOG_DOMAIN` を照合し、課題・コメント・参加者・関連課題、現在版 Wiki、課題・Wiki 添付、共有ファイルのフォルダ構成と本体を取得します。Wiki 本文に添付一覧で未解決の参照がある場合だけ、`get_wiki_attachments` で一覧を追加照会し、既存アーカイブの再開時にも補完します。API キーはアーカイブデータや生成 HTML、ログには保存せず、コマンド引数にも指定しません。`render` は完了済みアーカイブの保存データだけを使い、本文サイトと収集状況レポートを生成します。`report` は完了前でも実行でき、保存済みの進捗から収集状況を単独で生成・更新します。作成するファイルと中断に耐える書き込み方法は [アーカイブ形式 v1](docs/archive-format.md) を参照してください。

生成される閲覧ページ・収集状況レポート・CLIの待機メッセージでは、日時を `YYYY-MM-DD HH:mm:ss JST` 形式（`Asia/Tokyo`）で表示します。たとえば `2022-08-23T04:38:51Z` は `2022-08-23 13:38:51 JST` と表示します。アーカイブ内に保存したISO 8601形式の時刻は書き換えません。

## デザイン方針

セマンティックな HTML と CSS を基本にし、Material Design 3 の色・文字・余白・形状・状態表示を共通の CSS で取り入れています。ページ移動には通常のリンク、補助情報の開閉には `details`／`summary` を使い、閲覧時の JavaScript や UI ライブラリに依存しません。実ブラウザーの表示確認は実施済みです。`file://`・オフライン・支援技術など、個別の確認範囲と環境は [TODO.md](TODO.md) の計画に従って記録します。

導入方針・実装内容・残る確認項目は [Material Design 3 導入の設計・計画](docs/material-design-plan.md) にまとめています。CSS トークンと共通レイアウトを実装し、`render` と `report` が同じ CSS をアーカイブ内へ配備します。ナビゲーション修正を回帰テストで確認し、表示確認も実施済みです。条件別のオフライン・アクセシビリティ確認は引き続き記録します。

## 関連プロジェクト

[miku-backlog-api](https://github.com/igapyon/miku-backlog-api) は、Backlog API と通信する Node Core/CLI です。
本プロジェクトでは Backlog との通信に `miku-backlog-api` を利用し、取得の組み立て、ローカル保存、静的 HTML 生成を担います。
アーカイブ本体は Node Core を利用し、CLI は開発時の仕様確認と接続診断に限ります。課題参加者、添付・共有ファイルを含む初期対象の操作は利用できます。詳細は [docs/backlog-api-integration.md](docs/backlog-api-integration.md) を参照してください。

## 参考資料

- [Backlog API ドキュメント](https://developer.nulab.com/ja/docs/backlog/)
- [課題一覧の取得](https://developer.nulab.com/ja/docs/backlog/api/2/get-issue-list/)
- [課題添付ファイルのダウンロード](https://developer.nulab.com/ja/docs/backlog/api/2/get-issue-attachment/)
- [API レート制限](https://developer.nulab.com/docs/backlog/rate-limit/)

## ライセンス

[Apache License 2.0](LICENSE)

## リポジトリ運用

- `workplace/` は、外部リポジトリのクローン、取得結果、検証用の生成物などを置くローカル作業領域です。`workplace/.gitkeep` 以外は Git で管理しません。
- `.codex/skills/` は Codex スキルのローカル配備先です。スキルのソースが必要になった場合は、別の正規の保存先で管理します。
- `node_modules/`、ビルド生成物、テストカバレッジ、ローカルの VS Code MCP 設定は Git で管理しません。共有が必要な MCP 設定は、認証情報を含めない例示用ファイルまたはドキュメントとして管理します。
