# 課題データの保存方針

初期版では、指定プロジェクトのすべての課題について、閲覧とローカルリンクの再生成に必要な情報を保存します。Backlog API が返すレスポンス全体をそのまま保管するのではなく、この文書で定める項目へ正規化します。これにより、閲覧に不要な認証・個人情報をアーカイブへ含めません。課題本体・コメント・参加者・関連課題は `data/issues/<issue-id>.json` にまとめ、課題一覧は `data/issues/index.json` に保存します。

Backlog の API では、[課題情報](https://developer.nulab.com/ja/docs/backlog/api/2/get-issue/)、[コメント](https://developer.nulab.com/ja/docs/backlog/api/2/get-comment-list/)、[添付ファイル](https://developer.nulab.com/ja/docs/backlog/api/2/get-list-of-issue-attachments/)、[参加者](https://developer.nulab.com/ja/docs/backlog/api/2/get-issue-participant-list/)、[共有ファイル](https://developer.nulab.com/ja/docs/backlog/api/2/get-list-of-linked-shared-files/)、[関連課題](https://developer.nulab.com/ja/docs/backlog/api/2/get-list-of-related-issues/) を個別に取得できます。

## 共通の人物情報

課題、コメント、添付ファイル、共有ファイルに現れる人物は、次の情報だけを保存します。

| 保存する項目 | 用途 |
| --- | --- |
| `id` | API 上の人物を識別する |
| `userId` | Backlog のユーザー ID を表示する |
| `name` | 表示名を表示する |

`mailAddress`、`lastLoginTime`、`nulabAccount`、`roleType`、`lang` は初期版で保存しません。取得した API レスポンスや実行ログにも、これらの値を残さないようにします。

## 課題本体

各課題について、次の項目を保存します。`id` を内部の主キー、`issueKey` を人が参照する識別子として扱います。

| 区分 | 保存する項目 |
| --- | --- |
| 識別・配置 | `id`、`projectId`、`issueKey`、`keyId` |
| 内容 | `summary`、`description` |
| 状態 | `issueType`、`status`、`priority`、`resolution` |
| 担当・分類 | `assignee`、`category`、`versions`、`milestone` |
| 計画・実績 | `startDate`、`dueDate`、`estimatedHours`、`actualHours` |
| 階層 | `parentIssueId` |
| 作成・更新 | `createdUser`、`created`、`updatedUser`、`updated` |
| 拡張項目 | `customFields`。値の型を失わない JSON 値と、属性 ID・名称・種別を保存する |

`issueType`、`status`、`priority`、`resolution`、`category`、`versions`、`milestone` は、表示名だけでなく API の ID と表示順・色など、レスポンスに含まれる表示に必要な情報を保存します。`childIssueSummary` は課題集合から生成時に算出するため、取得データの必須保存項目にはしません。

## コメントと変更記録

各コメントは `id`、`issueId`、`projectId`、`content`、`changeLog`、`createdUser`、`created`、`updated` を保存します。本文コメントと、コメントに付随する課題変更の記録を表示対象に含めます。

スターと通知は個人向けの状態であり、初期版の保存対象にしません。コメントに記載された画像・添付参照は、本文中の画像参照をローカル化する規則に従って別途対応づけます。

## 添付・共有ファイル・関係

- 課題添付ファイルは、ID、元のファイル名、サイズ、作成者、作成日時とファイル本体を保存します。課題本文・コメントから参照される画像も、この対応づけを利用します。
- 課題にリンクされた共有ファイルは、課題側では共有ファイル ID を保存します。ファイルのパス、名称、サイズ、作成・更新情報、本体はプロジェクト全体の共有ファイル保存処理で一意に保管します。
- 親子関係は `parentIssueId` から生成します。関連課題は、関連の種類と相手課題の ID・課題キー・件名を保存します。相手が対象プロジェクトのアーカイブに含まれない場合は、ローカルリンクにせず対象外であることを表示します。
- 課題の参加者は、共通の人物情報の配列として保存します。

## 初期版で保存しないもの

- API が返す完全な生レスポンス
- メールアドレス、最終ログイン時刻、Nulab アカウント ID など閲覧に不要な個人情報
- スター、通知、閲覧状態など個人ごとの状態
- コメントの `changeLog` 以外の課題更新履歴を完全に再現すること

課題履歴の表示範囲は [docs/history-scope.md](history-scope.md) で定めます。カスタム属性の定義情報をどの単位で保存するかは、保存形式の設計でさらに具体化します。
