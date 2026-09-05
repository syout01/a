# 展示会リード フォロー管理ツール

展示会でバーコード（来場者バッジ）を読み取って得たリストを、**取り込む → 自動でセグメント振り分け → 担当に配る → 順番にフォローして記録する → 成果を見る → スプレッドシートに書き出す** まで 1 画面で回すための小さな CRM です。

- サーバー: Node.js 22 以上（Express + `node:sqlite`。ネイティブビルド不要）
- 画面: ビルド不要の HTML / JavaScript（サーバーが同梱配信）
- 書き出し: Excel (.xlsx) / CSV (Excel 用 BOM 付き UTF-8) / Google スプレッドシート（任意設定）

## 使い方

```bash
npm install
npm run seed      # サンプル展示会 + 20 行の来場者CSV を投入（任意）
npm start         # http://localhost:3000
```

社内 LAN の 1 台で `npm start` しておき、各担当者はブラウザで開いてヘッダーの「自分」で名前を選ぶだけです（ログインはありません）。

### 画面の流れ

| タブ | やること |
| --- | --- |
| ① 取り込み | 展示会を作成し、主催者 CSV をドラッグ＆ドロップ。UTF-8 / Shift_JIS 自動判別。列名は見出しから自動推測し、手で直せます（姓・名が別列なら結合）。対応付けしなかった列も「その他の項目」として残ります。「判定プレビュー」で書き込まずにセグメント件数だけ確認できます。 |
| ② 振り分けルール | 「役職に部長を含む → A：即架電」のようなルールを画面で編集。優先度の小さい順に評価し、最初に一致したセグメントになります。条件は 含む／一致／正規表現／数値以上以下／空 などで、`extra.列名` で未対応列も使えます。「再判定」で既存リードにも適用（手動で変更した分は既定で保護）。 |
| ③ 担当割当 | セグメント × 担当のマトリクスを見ながら、選んだ担当者へラウンドロビンで平準化配分。除外セグメントは配りません。一覧でチェックして一括で担当・セグメント変更も可能。 |
| ④ フォロー | 「今日やるリスト」（自分の担当で未完了、かつ次回コールが未設定 or 今日まで）を上から処理。1 件ごとにステータス・次回コール日時・メモを入れて「記録して次へ」。再コール日を入れると、その日までリストから消え、期限を過ぎると「期限切れ」で拾えます。過去の展示会で接触した人は自動で注記されます。 |
| ⑤ ダッシュボード | 総件数・架電済・通電率・アポ・残件・再コール期限切れ、セグメント別／担当者別／ステータス別／日別の進捗。 |
| ⑥ 書き出し | Excel（リード一覧・サマリー・セグメント×担当・フォロー履歴の 4 シート）、CSV、Google スプレッドシートへ直接書き込み。 |
| 設定 | 担当者、セグメント（追加・色・除外フラグ）、展示会の編集・削除。 |

### 重複の扱い

- 同じ展示会内: メールアドレスが同じ、またはメールがなければ「会社名 + 氏名」を正規化（法人格・空白・全角半角のゆれを吸収）して同じなら **重複としてスキップ**。
- 別の展示会: 取り込みはしつつ **「過去接触あり」** としてフォロー画面に前回の状況を表示。

### ステータスと指標

| ステータス | 架電済 | 通電 | 完了 |
| --- | :-: | :-: | :-: |
| 未着手 | | | |
| 架電中（不在・再コール） | ○ | | |
| 通電（継続フォロー） | ○ | ○ | |
| 資料送付 | ○ | ○ | |
| アポ獲得 | ○ | ○ | ○ |
| 見込みなし | ○ | ○ | ○ |
| 対象外 | | | ○ |

通電率 = 通電 ÷ 架電済、アポ率 = アポ獲得 ÷ 通電。

## Google スプレッドシートへ直接書き出す（任意）

1. Google Cloud でサービスアカウントを作成し、JSON キーをダウンロード。Google Sheets API を有効化。
2. `.env` を作成（`.env.example` 参照）し、`GOOGLE_APPLICATION_CREDENTIALS=./service-account.json` のようにパスを指定（または `GOOGLE_SERVICE_ACCOUNT_JSON` に JSON をそのまま）。
3. サーバー再起動後、「⑥ 書き出し」に表示されるサービスアカウントのメールアドレスへ、書き出し先スプレッドシートを **編集者** で共有。
4. スプレッドシートの URL を貼って「書き出す」。`リード一覧` / `サマリー` / `フォロー履歴` タブを作成または上書きします（他のタブには触りません）。

未設定の間は Excel / CSV をダウンロードして、スプレッドシートの「ファイル → インポート」で取り込んでください。

## 設定項目（環境変数）

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `PORT` | 3000 | 待ち受けポート |
| `DB_PATH` | `data/app.db` | SQLite ファイル。バックアップはこのファイルをコピーするだけ |
| `GOOGLE_APPLICATION_CREDENTIALS` | なし | サービスアカウント JSON のパス |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | なし | サービスアカウント JSON の中身 |

## 開発

```bash
npm run dev    # ファイル変更で自動再起動
npm test       # ルール判定・重複判定・CSV パーサ・API の結合テスト
```

主なファイル:

```
server/index.js            Express アプリ
server/lib/db.js           スキーマ・初期セグメント/ルール
server/lib/segment.js      ルール判定エンジン・ラウンドロビン
server/lib/dedupe.js       重複キーの正規化
server/lib/export.js       Excel / CSV / シート用データ生成
server/lib/gsheets.js      Google Sheets API（サービスアカウント）
server/routes/*.js         API
public/                    画面（index.html / app.js / styles.css / csv.js）
samples/expo_sample.csv    主催者 CSV のサンプル
```

### API（抜粋）

- `POST /api/exhibitions/:id/import` `{ leads, mapping, dry_run? }` 取り込み（重複・過去接触・セグメント判定）
- `POST /api/exhibitions/:id/reclassify` `{ overwrite_locked? }` ルール再判定
- `POST /api/exhibitions/:id/assign` `{ member_ids, segment_codes?, mode }` ラウンドロビン割当
- `GET  /api/leads?exhibition_id&assignee_id&segment&status&due=today|overdue&q` 一覧
- `POST /api/leads/:id/activities` `{ status, note, next_call_at, member_id }` フォロー記録
- `GET  /api/exhibitions/:id/summary` ダッシュボード用集計
- `GET  /api/exhibitions/:id/export.xlsx` / `export.csv`、`POST .../export/gsheets { spreadsheet }`

## 既知の割り切り

- 認証はありません。社内ネットワーク内での利用を想定しています。
- 「自分」の選択はブラウザごと（localStorage）です。
