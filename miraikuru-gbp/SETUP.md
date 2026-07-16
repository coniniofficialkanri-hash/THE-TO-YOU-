# 未ら来る｜GBP投稿自動化 セットアップ手順

熊本市下通りの和食居酒屋「未ら来る」向け。GAS + Claude API + Drive写真/GPT画像 で
Googleビジネスプロフィール（GBP）に**承認なし全自動**で投稿する。

---

## 構成

```
時間トリガー（INTERVAL_DAYS 日に1回・11時）
  → 季節・曜日からテーマ決定
  → Claude API で本文生成（約300字・季節感）
  → Drive写真を優先取得（なければ GPT画像生成）
  → GBP v4 localPosts へ投稿
  → （任意）スプレッドシートにログ
```

ファイル：`Code.gs` / `appsscript.json`

---

## ⚠️ 最大の関門：GBP API の利用申請（数日〜）

投稿に使う `mybusiness.googleapis.com/v4/...localPosts` は **Google の審査・許可が必要**。
ここが通らないと「投稿」だけ動きません（本文・画像生成は審査前でもテスト可）。

1. **Google Cloud プロジェクト**を用意（未ら来るのGBPを管理できるGoogleアカウントで）
2. 以下のAPIを有効化
   - `My Business Account Management API`（ID取得用・通常すぐ有効化可）
   - `My Business Business Information API`（ID取得用）
   - `Google My Business API`（v4 localPosts用・**要アクセス申請**）
3. **アクセス申請フォーム**を提出 → 承認を待つ
   👉 https://developers.google.com/my-business/content/prereqs
4. スクリプトを動かすGoogleアカウントが、未ら来るのGBPに **管理者/オーナー権限**を持つこと

---

## セットアップ手順

### 1. Apps Script プロジェクト作成
- https://script.google.com で新規プロジェクト
- `Code.gs` の中身を貼り付け
- 「プロジェクトの設定 > `appsscript.json` を表示」をONにして `appsscript.json` も反映
- **プロジェクトの設定 > Google Cloud Platform プロジェクト** を、上で作った Cloud プロジェクトに切替
  （番号を紐づけないと business.manage スコープの API が呼べません）

### 2. スクリプトプロパティを登録
プロジェクトの設定 > スクリプト プロパティ：

| キー | 値 | 必須 |
|------|-----|:---:|
| `CLAUDE_API_KEY` | Anthropic APIキー | ✅ |
| `OPENAI_API_KEY` | OpenAI APIキー（画像フォールバック） | 任意 |
| `DRIVE_FOLDER_ID` | 店舗写真フォルダのID | 任意 |
| `ACCOUNT_ID` | GBPアカウントID（手順3で取得） | ✅ |
| `LOCATION_ID` | GBPロケーションID（手順3で取得） | ✅ |
| `LOG_SHEET_ID` | 投稿ログ用シートID | 任意 |

### 3. アカウントID・ロケーションID取得
- エディタで関数 `setup_listIds` を実行（初回は権限承認ダイアログ→許可）
- 実行ログの `accounts/XXXX` の **XXXX** を `ACCOUNT_ID` に
- `locations/YYYY` の **YYYY** を `LOCATION_ID` に登録

### 4. 生成テスト（投稿はしない）
- `test_generateOnly` を実行 → ログに本文・画像URLが出ればOK
- GBP API 審査待ちでもここまでは動く

### 5. テスト投稿（1回）
- GBP API 承認後、`autoPost` を1回実行 → GBPに投稿されるか確認

### 6. 口コミ返信テスト（返信はしない）
- `test_replyGenerateOnly` を実行 → 直近レビューと生成した返信文がログに出ればOK

### 7. トリガー設定
- `setup_trigger` を実行 → `INTERVAL_DAYS` 日に1回・11時に自動投稿
- `setup_replyTrigger` を実行 → 毎日10時に未返信レビューをチェックして自動返信
- 解除は `setup_deleteTriggers`（投稿・返信の両方を削除）

---

## 設定の切替（Code.gs 冒頭）

```js
const INTERVAL_DAYS = 3;  // 3日に1回（確定） / 毎日にするなら 1
const POST_HOUR     = 11; // 投稿時刻
const CLAUDE_MODEL  = 'claude-sonnet-5';
```

※ 投稿頻度は **3日に1回** で確定。

---

## 口コミ返信自動化（実装済み）

- `autoReplyReviews` … 未返信レビューを取得 → 星評価・本文に応じて Claude が返信を生成 → 投稿
  - ★4〜5：感謝中心 / ★3：感謝＋改善姿勢 / ★1〜2：真摯に謝罪・低姿勢
  - 返信済みレビューは自動スキップ
- `setup_replyTrigger` … 毎日10時に自動チェック
- ログは `LOG_SHEET_ID` シートの「口コミ返信」タブに記録

## 未対応（次フェーズ）

- Instagram投稿文生成（提案項目）。

---

## 注意点

- Drive写真は投稿のたびに「リンクを知る全員が閲覧可」に自動設定される（GBPが取得するため）。
  公開したくない写真は別フォルダに。
- `sourceUrl` 方式は Drive の直リンクを使用。GBP側が取得できない場合は
  画像アップロードAPI方式への切替が必要（その場合は連絡ください）。
- 投稿本文にURL・電話番号は入れない設計（GBPの拒否・警告回避）。
