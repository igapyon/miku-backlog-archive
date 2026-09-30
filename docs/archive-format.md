# アーカイブ形式 v1

この文書は、実装済みのアーカイブ作業領域と収集データの v1 形式を定義します。静的 HTML の生成は、以後この保存データだけを入力として行います。

```text
<archive-root>/
  manifest.json
  assets/
    issues/<issue-id>/<attachment-id>-<safe-name>
    wikis/<wiki-id>/<attachment-id>-<safe-name>
    shared/<shared-file-id>-<safe-name>
  data/
    project.json
    issues/
      index.json
      <issue-id>.json
    wikis/
      index.json
      <wiki-id>.json
    files/
      index.json
    assets/
      index.json
  site/
    index.html
    issues/index.html
    issues/<issue-id>.html
    wikis/index.html
    wikis/<wiki-id>.html
    files/index.html
    collection-status.html
    assets/style.css
  state/
    progress.json
```

- `manifest.json` はアーカイブの同一性と、取得元を保持する不変に近い記録です。
- `state/progress.json` は取得の進捗・失敗を保持します。収集処理はこのファイルを更新して中断後に再開します。
- `data/` は正規化した JSON、`assets/` は添付・共有ファイルなどのバイナリ、`site/` は生成済み静的 HTML を置く予約領域です。
- `data/issues/` には課題一覧と、課題本体・コメント・参加者・関連課題を、`data/wikis/` には現在版 Wiki の一覧と本体を置きます。
- `data/files/index.json` は共有ファイルのディレクトリ構成とファイル情報を保持します。`data/assets/index.json` は各ダウンロード済みファイルの ID、元の名前、サイズ、`assets/` から始まるローカル相対パスを対応づけます。
- `assets/` 内の名前は ID を先頭に付け、区切り文字、制御文字、危険な相対パス、OS で使えない文字を安全な名前へ置換します。表示用の元の名前は JSON 側に保持します。元の名前をローカルパスとして使用しません。
- `site/` は `render` が、完了済みアーカイブの `data/` と `assets/` だけを使って生成します。ページを開いた時に Backlog や CDN へ自動接続しません。本文中の通常の外部リンクは、利用者がクリックした時だけ遷移します。現在の生成器は最小の HTML と CSS を出力し、許可した記法だけを安全に HTML 化します。保存済み添付への限定的な画像・添付参照、取得済み課題キー、見出し・リスト・引用・コードフェンスを対象とし、外部画像は自動読込しません。共有ファイルは `data/files/index.json` のフォルダ階層をページ内ツリーとして表示します。
- `site/collection-status.html` は `report` が manifest と `state/progress.json` だけから生成する収集状況ページです。完了前のアーカイブでも生成でき、現在 `failed` のタスクの操作、許可済みの対象 ID、HTTP 状態、再試行可否、API 試行回数を表示します。過去の失敗履歴や許可外の進捗フィールドは表示しません。

初期化時点では、プロジェクトキーは分かっていても数値 ID はまだ未解決です。そのため `source.project.id` は `null` です。収集の開始前に `miku-backlog-api` から解決した ID を記録し、再開時は domain と ID を照合します。

## manifest.json

`schemaVersion` は `miku-backlog-archive/manifest/v1` です。初期化した manifest は次の形です。

```json
{
  "schemaVersion": "miku-backlog-archive/manifest/v1",
  "archive": {
    "id": "UUID",
    "createdAt": "2026-09-07T00:00:00.000Z",
    "toolVersion": "0.1.0"
  },
  "source": {
    "domain": "example.backlog.com",
    "project": {
      "key": "DEMO",
      "id": null
    }
  },
  "collection": {
    "status": "initialized",
    "startedAt": null,
    "completedAt": null,
    "counts": null
  }
}
```

ドメインはスキーム、パス、ポート、認証情報を含まないホスト名だけを保存します。API キーなどの認証情報はこの形式のどのファイルにも保存しません。

完了時には `collection.counts` に `issues`、`wikis`、`sharedFiles`、`assets` の総数を記録します。これは再開時に今回新しく取得した件数ではなく、完成したアーカイブに保存されている総数です。

## progress.json

`schemaVersion` は `miku-backlog-archive/progress/v1` です。`archiveId` は必ず manifest の `archive.id` と一致しなければなりません。検証コマンドはこの不一致を検出して停止します。これは異なる取得結果を誤って混在させないための最初の防御です。

```json
{
  "schemaVersion": "miku-backlog-archive/progress/v1",
  "archiveId": "manifest の archive.id",
  "updatedAt": "2026-09-07T00:00:00.000Z",
  "phase": "initialized",
  "tasks": {},
  "failures": []
}
```

`tasks` は取得単位ごとの状態を持ちます。現在は `project`、`issue-list`、`issue:<id>`、`wiki-list`、`wiki:<id>`、`issue-attachment:<issue-id>:<attachment-id>`、`wiki-attachment:<wiki-id>:<attachment-id>`、`shared-directory:<encoded-path>`、`shared-file:<id>` を使います。状態は `running`、`completed`、`failed` のいずれかです。`failed` のタスクは、失敗した操作・安全な対象 ID・HTTP 状態（得られる場合）・再試行可否・API 試行回数を `failures` にも記録し、次回の `collect` で再取得します。

共有ファイルはルート `/` から一つのディレクトリずつ列挙し、見つかった子ディレクトリを同じ方式で辿ります。各ディレクトリのページング位置もタスクに保存するため、中断後は確定済みの一覧とファイル本体を使い、未完了の一覧・ダウンロードだけを再開します。

課題一覧も、各ページを JSON と進捗の順に確定保存し、`issue-list.nextOffset` から再開します。ページをまたいで同じ課題 ID が返った場合は ID ごとに一件へ統合し、保存する一覧は ID 昇順に固定します。収集中に Backlog 側の一覧が変化する可能性は残るため、これは単一時点の完全なスナップショットを保証するものではありません。

## 書き込みの約束

JSON の確定保存は、同じディレクトリの一時ファイルに全内容を書き込んでから rename します。したがって途中で中断しても、既存の確定ファイルを部分的な JSON で置き換えません。一時ファイルは失敗時に削除を試みます。

ファイル本体の保存は `writeWebStreamAtomically` を使います。`miku-backlog-api` のダウンロード用 `ReadableStream` を全量メモリに保持せず、一時ファイルからの rename で確定します。ダウンロードが完了するまでは進捗上「完了」と記録しません。
