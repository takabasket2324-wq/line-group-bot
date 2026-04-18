# line-group-bot — LINE グループチャット Q&A Bot

公式LINEアカウントをグループチャットに参加させ、ユーザーの質問に Claude API で自動回答するBot。
管理者 + ユーザー + Bot の3人グループで運用する。

## コマンド一覧

```bash
npm install                          # 依存関係インストール
npm start                            # サーバー起動（本番）
npm run dev                          # サーバー起動（開発・ファイル変更で自動再起動）
node auth-google.mjs                 # Google OAuth 認証
node tools/init-spreadsheet.mjs --id # スプシをテンプレートからコピー（IDを.envに保存）
```

## プロジェクト構成

```
line-group-bot/
├── CLAUDE.md                ← このファイル
├── README.md                ← ユーザー向け説明書
├── package.json
├── server.mjs               ← メインサーバー（Express + LINE Webhook）
├── auth-google.mjs          ← Google OAuth 認証フロー
├── lib/
│   ├── ai.mjs              ← Claude API 回答生成
│   └── sheets.mjs          ← Google Sheets 読み書き
├── tools/
│   └── init-spreadsheet.mjs ← テンプレートからスプシをコピー
├── setup/
│   └── SETUP-FOR-CC.md     ← セットアップ手順書（AI用）
├── credentials/
│   └── tokens.json          ← Google OAuth トークン（gitignore）
├── .env                     ← 環境変数（gitignore）
├── .env.example             ← 環境変数テンプレート
└── .gitignore
```

## 共通ルール

- ユーザーはプログラミング未経験者の場合がある。1ステップずつ案内する
- ユーザーにファイルを直接編集させない。必要な値はチャットで受け取り、エージェントが設定する
- エラーが起きたら、何が起きたか・次に何をすればいいかを平易に伝える

---

## トリガー

| ユーザーの発話 | 発動するスキル |
|--------------|-------------|
| 「セットアップして」「始める」「開始」 | セットアップスキル |

---

## セットアップスキル

### 最初にやること

**必ず `setup/SETUP-FOR-CC.md` を読む。** このファイルを唯一の正本として扱う。

### 進め方

1. `setup/SETUP-FOR-CC.md` を読む
2. 足りないものを1つずつ確認する
3. ユーザーがやる操作は、その都度短く案内する
4. 全て完了するまで進める

### 重要ルール

- 認証設定は `.env` のみを使う
- 初回は一気に説明せず、次の1アクションだけを伝える
- ユーザーにファイルを直接編集させない

### 完了の定義

- `.env` が存在し、全必須項目が入っている
- `credentials/tokens.json` が存在する
- `SPREADSHEET_ID` が設定されている
- Render.com にデプロイされ、Webhook が接続されている
- LINE グループで Bot が応答する

---

## スプレッドシート構成

1つのスプレッドシート「line-group-bot 管理」に以下のシート:

### 固定シート: `システムプロンプト`
- A1セルにシステムプロンプト全文を格納
- Bot の性格・回答ルール・トーンを定義
- スプシ上で直接編集すれば、コード変更なしで Bot の振る舞いを調整できる
- 5分間キャッシュ

### 固定シート: `ナレッジ`
- A列: カテゴリ、B列: 質問、C列: 回答
- Bot が回答時に参照するQ&A集
- 手動で追加・編集する運用
- 5分間キャッシュ

### グループ別シート（自動作成）
- グループごとに自動でシートが作成される（シート名 = LINEグループ名）
- A列: 日時、B列: 発言者、C列: メッセージ
- 全メッセージ（ユーザー + Bot）を時系列で記録
- 回答生成時に直近10件を参照

---

## アーキテクチャ

```
ユーザーがグループLINEにメッセージ送信
    ↓
LINE Platform → Webhook → server.mjs
    ↓
handleEvent():
  1. テキストメッセージ + グループチャットのみ処理
  2. 管理者のメッセージはスキップ
  3. 管理者宛メンションが含まれるメッセージもスキップ
  4. 「応答生成中...」を即返信（replyToken）
  5. メッセージをスプシに記録
  6. スプシから並列取得: システムプロンプト + ナレッジ + 会話履歴
  7. Claude API で回答生成
  8. Bot の回答をスプシに記録
  9. 本回答を push message でグループに送信
```

## Bot の動作ルール

| 状況 | Bot の動作 |
|------|----------|
| ユーザーがメッセージを送る | 自動回答する |
| 管理者がメッセージを送る | 無視する |
| ユーザーが管理者宛にメンション | 無視する（管理者に任せる） |
| テキスト以外（画像・スタンプ等） | 無視する |
| 1対1トーク | 無視する（グループのみ） |

## 環境変数

```
LINE_CHANNEL_ACCESS_TOKEN    # LINE Messaging API チャンネルアクセストークン
LINE_CHANNEL_SECRET          # LINE Messaging API チャンネルシークレット
ANTHROPIC_API_KEY            # Claude API キー
GOOGLE_CLIENT_ID             # Google OAuth クライアントID
GOOGLE_CLIENT_SECRET         # Google OAuth クライアントシークレット
SPREADSHEET_ID               # 管理スプレッドシートID
ADMIN_USER_ID                # 管理者の LINE ユーザーID（スキップ対象）
PORT                         # サーバーポート（デフォルト: 3000）
```

## よくあるエラーと対処法

| エラー | 原因 | 対応 |
|--------|------|------|
| `Invalid signature` | チャンネルシークレットが違う | .env の LINE_CHANNEL_SECRET を確認 |
| `SPREADSHEET_ID が未設定` | .env にスプシIDがない | `node tools/init-spreadsheet.mjs --id` を実行 |
| `トークンが見つかりません` | Google認証未設定 | `node auth-google.mjs` を実行 |
