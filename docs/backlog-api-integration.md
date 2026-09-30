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

## 読み取り専用の制限

`miku-backlog-api` Runtime は作成・更新・削除の操作も公開しています。本ツールはそのうち `get_*` と三種の `download_*` だけを呼び出し、Backlog API への取得・ダウンロードは HTTP GET で行います。

通常の API 呼び出し（`runOperation`）とダウンロード（`openDownload`）の両方に `allowedPermissions: ['READ']` を渡します。Runtime は、操作に必要な権限がこの許可一覧に含まれるかを通信前に検査します。作成・更新・削除にはそれぞれ `CREATE`・`UPDATE`・`DELETE` が必要なため、本ツールの呼び出し経路では拒否されます。API キーに書き込み権限がある場合も、呼び出しごとの許可範囲は `READ` だけです。

通常の CLI は Runtime ファイルの固定 SHA-256 と製品バージョンを検証し、必要操作がすべて `mutationClass: 'read'`・`requiredPermission: 'READ'` であることも検査します。実装は [`src/archive/collector.mjs`](../src/archive/collector.mjs) と [`src/backlog/runtime.mjs`](../src/backlog/runtime.mjs) にあります。`collectArchive` を直接呼ぶ際のテスト用 Runtime オブジェクトにはファイルのハッシュ検証が適用されないため、この経路では呼び出し元が Runtime の実装を管理します。

`READ` の制限は Backlog 側のデータ操作に適用します。アーカイブの初期化・収集・HTML 生成・収集状況レポート生成では、ローカルの出力先にファイルを作成・更新します。

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

取得処理は `runOperation` の成功結果だけを正規化して保存します。読み取り操作とダウンロードは直列に実行し、Runtime の `onAccess` から検索枠・読み込み枠の `limit`・`remaining`・`resetAt` を受け取り、次のAPI呼び出し時刻を調整します。`get_issues` と `get_wiki_pages` は検索枠、その他のGETとダウンロードは読み込み枠を共有します。枠情報がない場合も1秒を基本間隔とし、検索は最低1秒空けます。

429は、未来の `resetAt` があればその時刻に1秒を加えた時点まで待ち、欠落・不正・過去の時刻なら60秒待って再試行します。初回を含め最大3回で解消しない場合、現在の取得タスクを失敗記録にして収集全体を止めます。`progress.json` に次回送信可能時刻を保存し、次回の `collect` は最初のAPIを呼ぶ前に残りの待機を行います。408・5xx・一時的な上流エラーは従来の1秒・2秒の待機で最大3回試行します。バイナリは `openDownload` の開始失敗までを同じ条件で扱い、本文ストリーム中の失敗は不完全なファイルを確定せず、次回の `collect` で再開します。

`get_issues` の各項目は正規化済みの補助キャッシュとして先に保存します。個別課題APIとの同等性を確認できるだけの項目が揃っている場合は課題本体に再利用し、コメント・参加者・関連課題は従来どおり個別取得します。必須項目が欠ける一覧項目と、キャッシュのない旧アーカイブは `get_issue` で補完します。キャッシュの形式は [アーカイブ形式](archive-format.md) に記載します。

共有ファイルのアーカイブ内ルートは `/` です。固定RuntimeはAPIパスへ `path` をそのまま連結するため、ルート一覧を `path: "/"` で呼ぶと `//` となり、Backlogから `illegal path`（HTTP 400）が返ります。archiveはAPI呼び出し時だけ `path: "./"` を渡し、URL正規化でルート一覧へ到達させます。2026-09-30のMIGTEST01確認ではこの呼び出しは成功し、ルート項目は0件でした。ローカルのディレクトリ名と保存形式は `/` のままです。

最終失敗時は操作名、対象 ID、HTTP ステータスが得られる場合の状態、再試行可否、実行した API 試行回数を記録し、上流の応答本文や認証情報は記録しません。

## 参照

- [miku-backlog-api](https://github.com/igapyon/miku-backlog-api)
- [v0.7.10 Release](https://github.com/igapyon/miku-backlog-api/releases/tag/v0.7.10)
