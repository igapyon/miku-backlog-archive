# miku-backlog-api との連携方針

`miku-backlog-api` を Backlog への唯一の通信層とします。アーカイブ本体から `backlog-js` や Backlog REST API を直接呼び出しません。

## 呼び出し方式

アーカイブ本体は、`miku-backlog-api` の Node Core が公開する `runOperation(operation, input, options)` を使用します。CLI を子プロセスとして繰り返し起動する方式は採用しません。

Node Core を採用する理由は次のとおりです。

- 大量の課題・コメント・ファイルを取得する処理で、JSON の標準出力と子プロセス管理を繰り返さずに済む
- 操作ごとの構造化された成功・失敗結果と、読み取り専用の権限制御をそのまま扱える
- `onAccess` のアクセスイベントを、本文や認証情報を含めない進捗記録へ変換できる

CLI は、開発時の `tools describe` による入力仕様の確認と、接続診断に限って使用します。

## 依存する版と認証

初期実装では、GitHub Release の `miku-backlog-api` Runtime をバージョン固定で利用します。採用版は `v0.7.10`（コミット `cc9c203`、Runtime の SHA-256 は `7a8d9b78296009b204341ca49da2cd3a382f7b2bc656f607f670b69ef85601ec`）です。Runtime 資産はリポジトリへ同梱せず、利用者が取得したファイルを `runtime verify` で SHA-256・製品版・必要操作の順に検証します。リリース Runtime を将来リポジトリへ同梱する場合は、ライセンス表示も追加します。

認証情報は実行時環境から渡します。`BACKLOG_DOMAIN` と `BACKLOG_API_KEY` は、保存データ、生成 HTML、ログ、追跡対象ファイルに含めません。アーカイブの全操作は `READ` 権限だけで実行し、書き込み権限は有効化しません。

## 対応状況

`v0.7.10` で確認した、初期版で必要な操作の対応は次のとおりです。

| 対象 | 操作 | 状態 |
| --- | --- | --- |
| プロジェクトと設定 | `get_project`、`get_project_users`、`get_project_statuses`、`get_categories`、`get_custom_fields`、`get_issue_types`、`get_version_milestone_list` | 利用する |
| 課題 | `get_issues`、`get_issue`、`get_issue_comments`、`get_issue_participants`、`get_related_issues` | 利用する |
| Wiki | `get_wiki_pages`、`get_wiki` | 利用する |
| 課題・Wiki 添付ファイル | `get_issue`・`get_wiki` のメタデータ、`download_issue_attachment`・`download_wiki_attachment` の本体取得 | 利用する |
| 共有ファイル | `get_shared_files` のディレクトリ列挙、`download_shared_file` の本体取得 | 利用する |
| 課題参加者 | `get_issue_participants` | 利用する |

`v0.7.9` では共有ファイルの列挙と三種のバイナリダウンロードが追加され、`v0.7.10` では課題参加者の `get_issue_participants` が追加されました。ダウンロードには Node Core の `openDownload` を使い、`ReadableStream` をメモリへ全量保持せずに一時ファイルへ書き込み、完了後に確定保存します。

初期対象に必要な読み取り操作はそろいました。このリポジトリで直接 Backlog API を呼び出す代替実装は作りません。

## 実装前の互換性確認

アーカイブ実行前に、固定した Runtime の `listOperations()` から必要な操作がすべて得られることを検査します。操作が欠ける、バージョンが想定と異なる、または Runtime のハッシュ検証に失敗した場合は、ネットワーク取得を始めずに停止します。

取得処理は `runOperation` の成功結果だけを正規化して保存します。読み取り操作は直列に実行し、408・429・5xx と一時的な上流エラーだけを、初回を含めて最大3回試行します。再試行の待機は1秒、2秒の指数的な固定待機です。バイナリは `openDownload` の開始失敗までを同じ条件で再試行し、本文ストリーム中の失敗は不完全なファイルを確定せず、次回の `collect` で再開します。

最終失敗時は操作名、対象 ID、HTTP ステータスが得られる場合の状態、再試行可否、実行した API 試行回数を記録し、上流の応答本文や認証情報は記録しません。

## 参照

- [miku-backlog-api](https://github.com/igapyon/miku-backlog-api)
- [v0.7.10 Release](https://github.com/igapyon/miku-backlog-api/releases/tag/v0.7.10)
