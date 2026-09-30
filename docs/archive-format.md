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
    issue-details/<issue-id>.json
```

- `manifest.json` はアーカイブの同一性と、取得元を保持する不変に近い記録です。
- `state/progress.json` は取得の進捗・失敗を保持します。収集処理はこのファイルを更新して中断後に再開します。
- `state/issue-details/` は課題一覧または個別取得から正規化した課題本体を一件ずつ原子的に保存する補助キャッシュです。アーカイブID・プロジェクトIDが一致し、一覧項目の必須情報が揃う場合に限り `get_issue` の代わりに使います。旧アーカイブでキャッシュがない場合は個別取得します。
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
    "toolVersion": "0.6.0"
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

`tasks` は取得単位ごとの状態を持ちます。現在は `project`、`issue-list`、`issue:<id>`、`wiki-list`、`wiki:<id>`、`wiki-attachment-list:<wiki-id>`、`issue-attachment:<issue-id>:<attachment-id>`、`wiki-attachment:<wiki-id>:<attachment-id>`、`shared-directory:<encoded-path>`、`shared-file:<id>` を使います。`wiki-attachment-list:<wiki-id>` は、Wiki 本文に添付一覧の不足参照があるかを確認した結果も記録し、旧アーカイブの再開時にも未実施なら補完処理を行います。状態は `running`、`completed`、`failed` のいずれかです。`failed` のタスクは、失敗した操作・安全な対象 ID・HTTP 状態（得られる場合）・再試行可否・API 試行回数を `failures` にも記録し、次回の `collect` で再取得します。

`rateLimit` は任意項目で、`read` と `search` ごとの `limit`、`remaining`、`resetAt`、`nextAllowedAt`、`blockedUntil`、`blockedReason` を記録します。`blockedReason` は `rate-limit`（429）または `quota`（成功応答で残数1以下）です。不正な値は検証で拒否し、旧progressに項目がなくても読み込めます。429で3回目の試行に失敗した場合は収集全体を止めますが、次回実行時に最初のAPIより前に `blockedUntil` まで待機します。`waiting` は待機中だけの任意項目で、枠・理由（`rate-limit`、`quota`、`pacing`、`retry`）・開始日時・再開予定日時・待機時間を持ちます。待機後に消し、429失敗後に残す期限は `rateLimit` 側で保持します。

課題本体キャッシュ `state/issue-details/<issue-id>.json` は `schemaVersion: miku-backlog-archive/issue-detail-cache/v1`、`archiveId`、`projectId`、`savedAt`、`source`（`issue-list` または `issue-detail`）、`reusable`、正規化済みの `issue` を持ちます。生レスポンスを含めません。読み込み時はスキーマ、アーカイブ／プロジェクト／課題IDを照合し、不一致や破損は収集を停止します。

共有ファイルはルート `/` から一つのディレクトリずつ列挙し、見つかった子ディレクトリを同じ方式で辿ります。各ディレクトリのページング位置もタスクに保存するため、中断後は確定済みの一覧とファイル本体を使い、未完了の一覧・ダウンロードだけを再開します。

課題一覧も、各ページを JSON と進捗の順に確定保存し、`issue-list.nextOffset` から再開します。ページをまたいで同じ課題 ID が返った場合は ID ごとに一件へ統合し、保存する一覧は ID 昇順に固定します。収集中に Backlog 側の一覧が変化する可能性は残るため、これは単一時点の完全なスナップショットを保証するものではありません。

## 取得時点と再開の制約

収集は複数の API を順次呼び出すため、Backlog の一つの時点を固定したトランザクションではありません。特に課題一覧と共有ファイル一覧は offset によるページングです。取得中に対象一覧へ項目が追加・削除されるとページ境界が動き、重複や取りこぼしが起きる可能性があります。既知の ID 重複は統合しますが、取りこぼしを検出・補完する仕組みはなく、すべての課題・コメント・Wiki・ファイルが同じ時点の状態であることも保証しません。

中断後の再開は進捗に記録したタスク単位です。完了済みの課題などは再利用し、課題一覧と共有ファイル一覧は保存済みページ位置から続けます。一方、コメント一覧は `get_issue_comments` の `minId` を使って一回の課題取得中にページングしますが、ページ位置と途中までのコメントを `progress.json` に保存しません。ある課題のコメント取得中に中断または失敗した場合、その課題の `issue:<id>` タスクを再実行し、コメント一覧を最初のページから取得し直します。課題本体キャッシュが利用できる場合、本体の再取得は避けられますが、完了済みページを含むコメント API 呼び出しは繰り返されます。

完了済みのアーカイブへ後から差分を反映する機能はありません。取得内容を更新する場合は、別の空の出力先へ新しい全件収集を行います。

レート制限スケジューラが調整するのは、この archive プロセス内の API 呼び出しだけです。同じ Backlog の利用枠を使う別アプリや別プロセスとは状態を共有せず、同時利用による枠の消費を予測・調整できません。そのため、429 の発生を完全に防ぐ保証はありません。429 を受けた場合は待機・再試行し、上限に達したら再開可能な状態で収集を停止します。

## 書き込みの約束

JSON の確定保存は、同じディレクトリの一時ファイルに全内容を書き込んでから rename します。したがって途中で中断しても、既存の確定ファイルを部分的な JSON で置き換えません。一時ファイルは失敗時に削除を試みます。

ファイル本体の保存は `writeWebStreamAtomically` を使います。`miku-backlog-api` のダウンロード用 `ReadableStream` を全量メモリに保持せず、一時ファイルからの rename で確定します。ダウンロードが完了するまでは進捗上「完了」と記録しません。

ダウンロードの再開単位はファイル全体です。ストリームがエラーを返した場合は一時ファイルを削除し、未完了タスクとして残して、次回の `collect` でファイルの先頭から再ダウンロードします。プロセスの強制終了では一時ファイルが残る可能性がありますが、確定先への rename 前なので完成済み資産とは扱いません。HTTP Range などによるバイト位置からの継続には対応しません。完了済みファイルは再取得しません。
