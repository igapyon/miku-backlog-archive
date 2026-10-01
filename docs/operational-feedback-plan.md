# 実運用で見つかった閲覧・収集診断の改善計画

作成日: 2026-10-01。以下は実装作業の仕様・完了条件を保持した記録です。2026-10-01にP1〜P4を実装し、P2とP3/P4の回帰テストおよびP6の文書整合を実施しました。利用者から実ブラウザーでの閲覧報告があり、P5のHTTP fixture確認も完了しています。閲覧方式・環境・個別項目の結果記録とfile拒否の切り分けは残っています。結果は [閲覧確認記録](viewing-verification.md) を参照してください。

## 指摘の判断と対応範囲

利用者から報告された4項目はすべて妥当と判断します。ただし、確認された事実と原因の推測を分けて対応します。

| 指摘 | 現時点の判断 | この計画での対応 |
| --- | --- | --- |
| `file://` でCSSが適用されず、ページ移動で `ERR_ACCESS_DENIED` | 実ブラウザーの確認と手順の記録が不足。拒否の原因は未特定 | P1で案内を修正し、P2・P5で再現可能なfixtureと確認記録を用意する |
| `site/` をHTTPルートにすると保存資産が404 | 現行構造の相対リンクと配信ルートの不一致。保存ファイルの欠落とは区別できる | アーカイブ全体をルートにする手順とP2のHTTP回帰テストを追加する |
| CLIに操作名だけが出て原因を絞れない | archive側で利用可能な構造化情報を表示していない | P3・P4で安全な診断、未完了タスクの要約、再開・レポート手順を追加する |
| 収集・renderと保存件数の確認は成功 | 報告の対象に限った成功実績。Backlogの全情報との完全一致は未確認 | 成功実績と閲覧・CLI診断の残課題を分けて記録し、P6で案内をそろえる |

### 報告された環境と結果

以下は利用者の報告であり、この計画の作成時に再実行した結果ではありません。

- 確認日: 2026-10-01。macOS／Chromeの詳細バージョンは未記録。
- archive v0.7.1、miku-backlog-api Runtime v0.8.0、Node.js v26.5.0。
- 課題18件、コメント184件、Wiki4件、共有ファイル1件、保存資産11件。
- 課題詳細18ページ、コメント184件、Wiki詳細4ページのHTMLを確認。収集状態 `completed`、現在の失敗タスク0件。
- 初期の失敗履歴は進捗に残存。共有Excelは配信ルート修正後にHTTP 200・18,235バイト。
- 単一プロジェクトの確認であり、既知の機能対象外を含む。別のローカルアーカイブの件数と混ぜない。

### 採用する仕様

1. `assets/`、`data/`、`state/`、`site/` の現行配置を使う。保存形式v1と旧アーカイブの読み込みを維持する。
2. ローカル閲覧は `file://` とループバックHTTPの手順を案内する。`file://` の動作保証は、記録した環境と確認項目の範囲に限定する。
3. HTTPの配信ルートはアーカイブ全体、入口は `/site/index.html` とする。シンボリックリンクをrenderの標準出力に加えない。
4. 診断はRuntimeが渡した安全な構造化情報から生成する。HTTP状態がない場合は「未取得・原因未特定」と表示する。
5. Backlogとの通信は既存Runtime経由のREAD操作を使う。診断改善のために接続確認APIを追加で呼ばない。

`site/` 単体をコピー・配信できる機能は追加設計が必要です。この計画の既定対応は現行配置での閲覧です。独立配布を求められた場合は、明示的な別出力先へのエクスポート、資産の実コピー、全リンクの書き換え、容量・更新・旧アーカイブ互換性を先に定義します。資産の二重保存やシンボリックリンクを自動追加するだけでは独立配布の完了としません。

## 実装順と担当ファイル

| 順序 | 作業 | 主な変更先 | 依存 |
| --- | --- | --- | --- |
| P1 | 閲覧手順と確認済み範囲の案内 | `README.md`、`docs/archive-format.md`、新規 `docs/viewing.md` | なし |
| P2 | 共通fixtureとHTTP参照の回帰テスト | `test/render.test.mjs`、新規 `test/helpers/viewing-fixture.mjs`、新規 `test/helpers/static-server.mjs`、新規 `test/http-viewing.test.mjs`、新規 `scripts/create-viewing-fixture.mjs`、`package.json` | P1の配信仕様 |
| P3 | 診断の正規化と原因候補の共通処理 | 新規 `src/archive/diagnostics.mjs`、新規 `test/diagnostics.test.mjs`、`package.json` | なし |
| P4 | collector・CLI・レポートに診断を反映 | `src/archive/collector.mjs`、`src/cli.mjs`、`src/archive/report.mjs`、対応する既存テスト、`docs/backlog-api-integration.md`、`docs/archive-format.md` | P3 |
| P5 | 実ブラウザー確認とfile拒否の切り分け | `docs/viewing.md`、新規 `docs/viewing-verification.md`、必要時にrender/CSSと対応テスト | P1・P2。収集診断の実確認はP4 |
| P6 | 全体確認と資料の整合 | `README.md`、`TODO.md`、上記の資料 | P1〜P5 |

Lunaは各段階の完了条件を満たしてから次へ進みます。ブラウザーやRuntime側の情報が不足する項目は、その項目だけを未完了として残し、独立した段階を進めます。

## P1

**閲覧手順を現行の出力構造に合わせる。**

1. 新規 `docs/viewing.md` に、アーカイブ全体の配置図と、HTML用 `site/assets/style.css` と添付用 `<archive>/assets/` の違いを記載する。
2. `file://` の手順を記載する。アーカイブ全体を同じ構造で保存し、`site/index.html` をブラウザーで開く。HTMLだけ、または `site/` だけをコピーすると添付を含む閲覧一式にならないことを明示する。
3. ローカルHTTPの手順を記載する。Python 3.7以降が導入済みの場合の例を以下に固定する。起動はリポジトリルートから、停止はサーバー側端末で `Ctrl+C`。8000番が使用中なら両方のポート番号を変更する。

   ```sh
   python3 -m http.server 8000 --bind 127.0.0.1 --directory ./my-archive
   ```

   ブラウザーで `http://127.0.0.1:8000/site/index.html` を開く。`./my-archive/site` を `--directory` に指定する例は推奨手順にしない。[Python公式の配信ディレクトリ・bindの説明](https://docs.python.org/3/library/http.server.html#command-line-interface) を参照する。

4. このHTTP手順は自分の端末での閲覧用と記載する。アーカイブ全体を配信すると `data/`・`state/`・manifestも配信範囲に入る。生成HTMLもBacklogのアクセス制御を継承しないため、共有・公開の手順として流用せず、公開用途は別に配信範囲とアクセス制御を設計する。
5. 「CSSが適用されない」「`ERR_ACCESS_DENIED`」「添付が404」の対処を分ける。404では配信ルート、ブラウザーで解決されたURL、資産の実ファイルを確認する。拒否ではP5の確認記録を案内する。
6. `README.md` の「生成ページとリンク」「開発状況」「デザイン方針」を見直し、ファイルの存在検査と実ブラウザーの成功を区別する。未記録の環境まで「Webサーバー不要」「どのブラウザーでも利用可能」と保証しない。閲覧手順へのリンクをCLI使用例の後にも置く。
7. `docs/archive-format.md` に現行構造のHTTPルートと `site/` 単体配布の境界を追記し、詳細は `docs/viewing.md` へリンクする。

**完了条件:** READMEだけを読んでも正しい入口と配信ルートが分かる。Pythonの導入前提、ループバックのbind、停止方法、`file://` の確認範囲が明確である。

## P2

**実ファイルの参照検査に加え、案内したHTTPルートでCSS・HTML・資産を取得する。**

### fixtureの共通化

1. `test/render.test.mjs` の `preparedArchive(t)` にあるアーカイブ作成部分を `test/helpers/viewing-fixture.mjs` の `createViewingFixture(output)` に移す。初期化とJSON・資産の作成までを担当し、renderは呼び出し側が行う。既存の一時ディレクトリ作成と `t.after` の削除処理はテスト側に残す。
2. 課題・コメント・Wiki・共有ファイル、本文画像、添付リンク、課題／Wikiリンク、コメントアンカー、親子課題、未解決画像を含める。既存テストで確認している項目を削らない。
3. 現在のPNG名の資産にはテキストを保存しているため、画像表示確認用には実際にデコードできる小さなPNGを保存する。既存のバイト列比較・サイズに関する期待値も対応させる。課題添付・Wiki添付の両方に有効な画像を用意する。
4. 資産の `localPath` に、日本語、空白、`#`、`%`、`&` を含む名前を追加し、IDにより区別された同名添付も維持する。元のファイル名とローカル資産名の両方を確認する。
5. 新規 `scripts/create-viewing-fixture.mjs` は `--output <空のディレクトリ>` を必須にし、同じfixtureを作成して `renderArchive` を呼ぶ。既存出力は上書きしない。APIキー・Runtime・Backlog接続を必要としない開発用スクリプトとする。

実装後の手動確認用コマンド:

```sh
node scripts/create-viewing-fixture.mjs --output ./workplace/viewing-fixture
python3 -m http.server 8000 --bind 127.0.0.1 --directory ./workplace/viewing-fixture
```

### HTTP回帰テスト

1. `test/helpers/static-server.mjs` にテスト専用の小さな静的サーバーを作る。Node標準の `node:http` と `node:fs/promises` を使い、`127.0.0.1` のポート0で待ち受ける。配信ルートを引数で明示し、URLパスを一回デコードしてルート内の実ファイルに解決する。ルート外参照・不正なエンコードを拒否する。
2. HTML、CSS、PNGには適切なContent-Typeを返し、バイナリを変換せず送る。不在は404。fixtureにはシンボリックリンクを作らず、配信にリンク追跡を必要としない。`t.after` で接続とサーバーを閉じ、失敗時にもプロセスを残さない。
3. 新規 `test/http-viewing.test.mjs` でfixtureをrenderし、アーカイブ全体をルートにする。`/site/index.html` から始め、生成された各HTMLのローカル `href`／`src` を `new URL(reference, pageUrl)` で解決し、HTTP 200を確認する。
4. `&amp;` 等のHTML属性エスケープを復元してからURLを解決する。外部 `http(s)`／`mailto` は取得せず、ローカル参照は同じorigin内であることを確認する。断片だけのリンクは同一ページとアンカーを確認し、HTMLのコメントアンカーも確認する。
5. CSSはHTTP 200と `text/css`、画像・添付・共有ファイルはHTTP 200と保存済みバイト列の一致を確認する。Content-Lengthがある場合は実バイト数との一致も確認する。特殊文字名を含め、保存済みの資産を最低1件ずつ各種別で取得する。
6. 比較用に `site/` だけをルートにしたサーバーも起動する。ホームとCSSは200だが、生成HTMLの共有ファイル参照は404になることを確認する。これは現行仕様の境界を示すテストであり、製品が正しく配信できたという判定には用いない。
7. `assetHref`（`src/archive/render.mjs`）と `src/ui/page.mjs` のリンク生成は、上記の正しいルートで失敗する場合に絞って修正する。共有ファイルだけの修正で課題／Wiki添付を取り残さない。既存の `file://` 参照検査も継続する。
8. `package.json` の `test` に新規テストを追加する。開発スクリプト・新規ソースは `check` の構文検査にも追加する。

**完了条件:** アーカイブ全体をルートにした全ローカル参照のHTTPテストが成功し、画像・共有ファイルのバイト列も一致する。`site/` だけの配信で起きる404を再現できる。この自動確認だけで実ブラウザーの表示確認を完了扱いにしない。

## P3

**診断に使える情報を小さな共通モジュールで正規化する。**

新規 `src/archive/diagnostics.mjs` は通信やファイル書き込みを行わない純粋な処理とし、collector・CLI・レポートから共用する。

1. 診断の基本形を `{ operation, target, code, httpStatus?, requestAttempts?, retryable? }` とする。値を検証し、許可した項目だけで新しいオブジェクトを作る。
2. `operation` は `REQUIRED_RUNTIME_OPERATIONS` にある操作または `local` に限定し、未知値は `unknown` とする。
3. `target` の項目と出力順は `projectId`、`projectKey`、`issueId`、`issueKey`、`wikiId`、`attachmentId`、`sharedFileId`、`offset`、`minId` に固定する。IDと `minId` は1以上の安全な整数、offsetは0以上の安全な整数とする。現在使用する `projectId` の配列は全要素を検証する。表示用の `projectKey` は最大128文字の `/^[A-Za-z0-9_]+$/u`、`issueKey` は最大160文字の `/^[A-Za-z0-9_]+-[1-9][0-9]*$/u` に限定し、ほかの文字列を診断から除外する。これは診断の表示制限であり、収集入力や保存済み本文の受け付け条件を変更するものではない。
4. `code` の初期許可集合は `UPSTREAM_ERROR`、`RUNTIME_ERROR`、`LOCAL_ERROR`、`NOT_FOUND`、`CONFIGURATION_ERROR`、`INVALID_INPUT`、`INVALID_FIELDS`、`INVALID_ARGUMENT`、`UNKNOWN_OPERATION`、`ORGANIZATION_ERROR` とする。未知値・不正値は `UNKNOWN_ERROR` に置き換える。Runtimeの追加コードを採用する場合は固定値を確認して許可集合とテストを追加する。正規表現だけで任意の文字列を通さない。
5. `httpStatus` は100〜599の整数だけ受け付ける。欠落・不正値は「未取得」。`requestAttempts` は1以上の安全な整数、`retryable` はbooleanだけ受け付け、不明なら「不明」とする。
6. 原因候補の案内は以下の固定文から生成する。Runtimeの `diagnostics.message`、例外の `message`／`stack`／`cause`、リクエストURL、ヘッダー、レスポンス本文を診断にコピーしない。

| 得られた情報 | 案内する確認先 |
| --- | --- |
| HTTP 401 | 認証失敗の可能性。実行時のAPIキー設定・有効性を確認する |
| HTTP 403 | アクセス拒否。プロジェクトの閲覧権限やアクセス制限を確認する |
| HTTP 404 | 対象不在、参照先の不一致、または閲覧できない対象の可能性。対象ID・キー・権限を確認する |
| HTTP 408 | 要求のタイムアウト。接続状態を確認する |
| HTTP 429 | 利用枠の制限。保存済みの待機・再開情報を確認する |
| HTTP 500〜599 | サーバー／中継側のエラーの可能性。時間を置いた再実行を検討する |
| HTTPなし＋`CONFIGURATION_ERROR` | Runtime設定を確認する。キーそのものは出力しない |
| HTTPなし＋`INVALID_INPUT`／`INVALID_FIELDS`／`INVALID_ARGUMENT` | 操作の入力仕様とarchiveからRuntimeへ渡す引数を確認する |
| HTTPなし＋`UNKNOWN_OPERATION` | 固定Runtimeの互換性と操作名を確認する |
| HTTPなし＋`ORGANIZATION_ERROR` | Runtimeの結果処理で失敗したことを示し、対象操作とRuntimeの仕様を確認する。接続原因は断定しない |
| HTTPなし＋`UPSTREAM_ERROR`／`RUNTIME_ERROR` | HTTP状態未取得・原因未特定。ネットワーク許可、ドメイン、DNS、プロキシ、TLSなどを確認候補に挙げる |
| `LOCAL_ERROR` | ローカル保存・処理の失敗として確認する。接続失敗とは断定しない |
| 上記に当てはまらない情報 | 原因未特定。操作・コード・収集状況レポートを確認する |

複数の条件がある場合は、取得済みHTTP状態の案内を優先する。HTTPの表示と原因の断定を分ける。

7. 新規 `test/diagnostics.test.mjs` に、各分類・未知コード・HTTP欠落・型違反・改行や制御文字を含む対象・許可外項目の除外を追加する。偽のAPIキーを診断message、code、URL、headers、causeに入れても返り値・整形結果に出ないことを確認する。
8. `package.json` の `test` と `check` に追加する。

**完了条件:** 同じ構造化情報からcollector・CLI・レポート用の診断を生成できる。未知原因を接続障害に決めつけず、認証情報を含む任意のRuntime文字列を表示しない。

## P4

**その場で終了するエラーと、後からまとめて終了するエラーの両方をCLIへ伝える。**

### collector

1. `callOnce` と `openDownloadOnce` が作る `OperationFailure`、`failTask` が保存するfailureにP3の正規化を適用する。保存する構造化コードも許可集合で制限し、Runtimeの生メッセージは保持しない。
2. `retryRequest` では、`OperationFailure` に対する `requestAttempts = attempt` を、再試行可否の判定でthrowする前に設定する。再試行しなかった場合も試行回数1を記録する。現在の再試行条件・最大回数・429待機動作はこの作業では変えない。
3. `ArchiveCollectionError` に任意の `collectionDiagnostics` を追加する。形式は `{ failedTaskCount, failures }`。`failures` は現在 `state === 'failed'` のタスクの正規化済み診断で、固定したキー順で並べる。CLI出力で使う配列は最大5件、件数は全失敗タスク数を使う。並べ替えはUTF-16の文字列比較とする。
4. `collectArchive` の外側catchでmanifestとprogressを `incomplete` として保存した後、この要約をエラーに付けてthrowする。既知の `ArchiveCollectionError` と429停止の構造化情報を保ち、予期しない例外は固定文の `ArchiveCollectionError` に変換する。
5. `hasFailedTasks(progress)` の終了経路にも同じ要約を付ける。`progress.failures` の過去履歴ではなく、現在失敗しているタスクを使う。課題や添付の失敗が途中で捕捉されても、CLIへ最大5件の詳細を渡せるようにする。
6. ダウンロード開始時の失敗にも、通常のAPIと同じ正規化を使う。転送途中の失敗は既存のアクセスイベント反映と一時ファイル処理を維持する。イベントにないHTTP状態や接続原因を補って作らない。
7. `progress/v1` の既存フィールドを使い、必須項目は増やさない。旧progressでHTTP・試行回数がない場合も表示する。表示時に正規化し、過去履歴を一括で書き換えない。

### CLIとレポート

1. `src/cli.mjs` のcollect失敗で、固定の要約、操作、許可済み対象、コード、HTTP、API試行回数、原因候補をstderrに表示する。stdoutに成功文を出さず、終了コードは現在の1を維持する。既存の待機メッセージも維持する。
2. 最大5件まで表示し、超過は「ほかN件」。アーカイブの失敗詳細を確認する `report` と、設定・接続を直した後に同じアーカイブで `collect` を再実行する手順を表示する。パスやキーを入れたコマンドを自動で組み立てず、固定のプレースホルダー付き例を使う。
3. 表示例を `docs/backlog-api-integration.md` に追加する。HTTPなしの例も載せ、以下のような内容にする。文章の句読点より、項目と秘密非表示の契約をテストする。

   ```text
   miku-backlog-archive: Collection is incomplete (failed tasks: 1).
   operation=get_project, target={"projectKey":"DEMO"}, code=UPSTREAM_ERROR, HTTP=未取得, API試行回数=3
   HTTP状態を取得できず、原因は未特定です。ネットワーク許可・接続設定を確認してください。
   確認: node src/cli.mjs report --archive <directory>
   再開: node --env-file=.env src/cli.mjs collect --archive <directory> --runtime <file>
   ```

4. `src/archive/report.mjs` の現在の失敗タスク表にもP3の正規化と同じ原因候補を反映する。旧データでHTTP・試行回数が欠落している場合に「未取得」「不明」を表示する。過去の失敗履歴を現在の失敗として数えない。
5. `main` のテストでcollectを差し替えるため、必要なら第3引数にテスト用の依存注入を追加する。省略時は既存の `collectArchive` を必ず使う。CLIオプションや環境変数でRuntime検証を迂回できる機能にはしない。

### 必須の回帰ケース

| テスト | ケース・確認項目 |
| --- | --- |
| `test/collector.test.mjs` | `get_project` のHTTPなし失敗、401・403・404・429・503、通常の課題取得失敗、添付の開始失敗。現在の失敗詳細・試行回数・incomplete保存・既存再試行動作を確認 |
| `test/collector.test.mjs` | 6件以上の失敗で総件数と最大5件の要約、失敗後に再開成功したタスクの除外、履歴だけ残るcompletedを確認 |
| `test/cli.test.mjs` | 直接throwと最後の未完了throw、HTTPあり／なし、上限表示、stderrの詳細・report／再開案内、stdoutに成功文なし、終了コード1を確認 |
| `test/report.test.mjs` | 原因候補、旧progressの欠落値、現在の失敗0件・過去履歴あり、単独reportのナビゲーション互換を確認 |
| 上記3テスト | 偽のキーをRuntimeのmessage・URL・ヘッダー・未知code・例外causeに仕込み、stdout・stderr・保存JSON・生成HTMLに漏れないことを確認 |

再試行を伴うcollectorテストは既存の `wait`／時計注入を使い、実際に60秒待たない。必要ならfixture Runtimeがdiagnostic messageやアクセスイベントを渡せるよう拡張するが、CLIと同じ権限検査の期待値を維持する。

**完了条件:** 利用者がCLIだけでも既知のHTTP状態に応じて次の確認先を選べる。HTTPがない場合は原因未特定と分かる。課題・添付の複数失敗も要約され、再開とレポートへ進める。既存のレート制限・READ制限・保存形式を維持する。

## P5

**実ブラウザーでfileとHTTPを別々に確認し、拒否の原因を切り分ける。**

1. P2のfixtureを作り、同じアーカイブで `file://.../site/index.html` と `http://127.0.0.1:8000/site/index.html` を確認する。まずmacOS／Chrome、同じmacOS上のSafariも利用できれば確認する。
2. 新規 `docs/viewing-verification.md` に、確認日、archive・Runtime・Nodeの版、OSの正確な版、ブラウザーの正確な版、保存場所の種類、起動方法、入口、HTTP配信ルート／サーバー版、ネットワーク条件、JavaScript条件を記録する。Runtimeを使わないfixture確認は「未使用」と記載する。
3. 以下を各環境・閲覧方式で `成功／失敗／未実施` と記録する。ファイルの存在やHTTP 200だけでは画像表示の成功にしない。

   | 確認項目 | 確認内容 |
   | --- | --- |
   | CSS | 計算済みスタイルを確認し、共通CSSが実際に適用される |
   | ページ移動 | ホーム→課題一覧→詳細、親子課題、Wiki一覧→詳細、ファイル、収集状況 |
   | 本文・リンク | 日本語・特殊文字、Wiki題名リンク、コメントアンカー、同名添付、未解決参照の表示 |
   | 画像 | 課題／Wiki本文と添付プレビューが表示され、必要ならスクロールで遅延読込を確認 |
   | ダウンロード | 課題／Wiki添付と共有ファイルを開く・保存し、元ファイルとバイト数／ハッシュが一致 |
   | オフライン | 外部ネットワークを切った状態で上記が動作し、HTTP方式ではループバックを維持する |
   | JavaScript無効 | 同じ基本閲覧が成立する。試験後は元の設定へ戻す |

4. 既存の取得済みアーカイブでも再取得せずrenderして確認する。fixtureの実行結果、保存済み実データの結果、利用者から提供された18課題の報告を別々に記録する。
5. `ERR_ACCESS_DENIED` が再現したら、DevToolsに表示された正確なURL、エラー、CSSの読込結果を記録する。URLが実ファイルを指すか、拒否対象がホーム・CSS・移動先のどれかを確認する。記録に認証情報や不要な本文を含めない。
6. 同じ内容を新しいローカルの検証用ディレクトリにコピーして比較し、同じブラウザーでfile対HTTP、同じ場所で別ブラウザー、Finderから開く方法対ブラウザーのファイルを開く方法を一条件ずつ比較する。既存アーカイブを移動・改変しない。
7. ブラウザー／OS／管理ポリシーが拒否原因だと断定するには、条件を変更した時の再現性と根拠を記録する。Chromiumの [ACCESS_DENIEDの定義](https://chromium.googlesource.com/chromium/src/+/main/net/base/net_error_list.h) だけでは拒否した設定まで特定できない。原因不明なら不明のまま残す。
8. 実在する必要なアクセス許可が特定された場合は、許可の対象と起動方法を文書化する。ブラウザーの保護機能の全面無効化やディレクトリへの一括権限変更を標準手順にしない。製品の参照パスが原因なら対応テストを追加し、修正後に同じ環境で再確認する。

**完了条件:** 記録した各方式のCSS・移動・画像・添付を実ブラウザーで確認できる。fileが拒否された環境は失敗として記録し、同じ環境のHTTP閲覧を代替手順として確認する。READMEが保証する範囲と実績を一致させる。fileでの成功実績が得られない限り、既存のfile受け入れ項目は未完了として残す。

ブラウザー操作環境が使えない場合は、P1〜P4を実施した上でP5を未完了として残す。CSS・画像・ダウンロードの確認をURLの存在検査で代用しない。

## P6

**検証結果を集め、README・TODO・制約の記述をそろえる。**

1. `npm run check` と `npm test` を実行する。新規の診断・HTTPテストが `package.json` の実行対象に含まれていることを確認する。
2. CLI成功時、collect失敗時、単独report、旧アーカイブrenderの結果を確認する。CLI診断の改善と、保存件数・完全性の保証を混同しない。
3. `docs/viewing-verification.md` に自動確認と実ブラウザー確認を分けて記録する。収集 `completed` は管理対象タスクの成功であり、Backlog上の全情報との一致や同時点スナップショットの保証ではないことを資料に反映する。
4. READMEから閲覧手順・環境記録・安全な収集診断の例へリンクする。今回の問題の整理は「閲覧・配信手順の確認不足」と「CLI診断不足」の両方を含める。
5. TODOの重複するブラウザー確認を本計画へ集約する。完了したチェックは未完了一覧から取り除き、結果と制約はdocsに残す。未確認のコメント画像、ページング回帰、アクセシビリティを今回の成功だけで完了扱いにしない。
6. `git diff --check`、対象ファイルの差分、`git status --short` を確認する。既存の0.7.2へのバージョン変更を保全する。バージョン変更・commit・pushは、実装指示とは別の既存SCM手順で行う。

**全体の完了条件:** 正しいローカルHTTP手順で参照先が取得でき、ブラウザーの確認範囲が記録され、安全な収集診断と再開案内が動作し、資料が実際の確認範囲を超えて保証していない。

## 2026-10-01の自己レビューと修正

P1〜P4の実装とP6の確認を完了しました。保存済みアーカイブ2件のCLI再renderが成功し、構文チェックと全73テストが通っています。完了項目はTODOから除き、P5の条件別確認・記録だけを残しました。

自己レビューで次の問題を見つけて修正しました。

- fixtureのPNGはIDATの長さが誤っており、HTTP 200とバイト列比較だけでは検出できていませんでした。長さを修正し、PNGの全チャンクCRCと展開した画素を確認する回帰テストを追加しました。以前の不正な長さを再現したデータを拒否することも確認しています。
- HTTP 400など個別案内のない応答で、コードが `UPSTREAM_ERROR`／`RUNTIME_ERROR` の場合に「HTTP状態未取得」と誤表示していました。HTTPがある場合の汎用案内を追加しました。
- failureの正規化で履歴の `task` が失われていました。collectorが生成したタスク識別子を保存履歴に保ち、失敗後に再開しても履歴から対応先を分かるようにしました。CLIとHTMLでのラベル表示は引き続き正規化します。
- 正規化後の `shared-directory` を再度表示処理へ通すとタスク名が消えていました。ラベルを繰り返し正規化しても維持し、安全な整数範囲外のタスクIDは除外します。
- レポートのHTTP・API試行回数・再試行可否の欠落表示が `—` でした。計画どおり「未取得」「不明」を表示するよう修正しました。

Runtimeの自由文・URL等を保存しない処理、既存のレート制御と再開条件は維持しています。利用者の実ブラウザー閲覧報告とCodex側のBrowser初期化失敗を別々に記録し、全条件のブラウザー確認が完了したとはしていません。

## Runtime側の追加情報が必要になる境界

archive側で表示できるのは、現在のRuntimeが渡すコード・アクセスイベントのHTTP状態と、archive側の試行・進捗情報です。HTTP状態なしの `UPSTREAM_ERROR` だけから、DNS失敗、TLS失敗、接続拒否、通信許可の拒否を厳密に識別することはできません。

厳密な区別が必要なら、miku-backlog-api側に「認証情報を含まない固定列挙の接続原因」をrunOperationとopenDownloadの両方で返す契約を提案します。必要なテストはHTTP前の接続失敗、HTTPエラー、転送途中の失敗、URLにキーを含む例外の非露出です。upstreamの契約・Release・SHA-256を確認してから、archiveの許可集合とテストに対応を追加します。

この依存が未解決でもP3・P4の安全な基本診断は実装できます。Runtimeの生メッセージをそのまま表示する回避策は採用しません。

## 参照と作成時の根拠

- 利用者が提供した2026-10-01の実運用報告。環境や件数は上記の報告範囲に限定。
- `src/archive/render.mjs` の `assetHref`、`src/ui/page.mjs` のCSS・ナビゲーション参照、`test/render.test.mjs` のfile参照検査を確認。
- `src/archive/collector.mjs` の `OperationFailure`、`callOnce`、`openDownloadOnce`、`failTask`、`retryRequest`、最終未完了処理、`src/cli.mjs` のcatchを確認。
- [相対参照のURL解決（MDN）](https://developer.mozilla.org/en-US/docs/Web/API/URL_API/Resolving_relative_references)。`../` は配信URLを基準に解決されるため、現行HTMLの資産参照はHTTPルートに依存する。
- [Pythonのhttp.server](https://docs.python.org/3/library/http.server.html)。配信ディレクトリとループバックbindの手順の根拠。

計画作成時の共有設計確認: 既存のmiku-soft Node/CLI設計に沿い、診断の正規化をcore、表示をCLI／HTMLに置く。今回は指摘への対応計画を対象とし、Runtime更新・CI・配布形式の変更などは別の作業として扱う。
