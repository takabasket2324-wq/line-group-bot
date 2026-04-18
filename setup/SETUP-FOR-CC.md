# line-group-bot セットアップ手順書

AI はこのファイルを見ながら次の順で進行する。
ユーザーは AI の案内に従えばよい。

## 前提

- 認証設定は `.env` に置く
- Google OAuth のトークン保存先は `credentials/tokens.json`

## AI が最初に確認すること

1. `node_modules` が存在すること
2. `.env` が存在すること
3. `.env` に全必須項目が設定されていること
4. `credentials/tokens.json` が存在すること
5. `.env` に `SPREADSHEET_ID` が設定されていること

全て揃っていれば「セットアップ済みです」と伝えてスキップ。
不足があるものだけ、以下の該当ステップを実行する。

## 進行フロー

### 0. Node.js の確認

まず `node -v` を実行して Node.js がインストールされているか確認する。

- バージョンが表示されれば OK → ステップ1へ
- `command not found` の場合 → 以下を案内:

```text
このツールを使うには Node.js が必要です。
まだインストールされていないようなので、インストールしましょう。

1. https://nodejs.org を開く
2. 左側の「LTS」と書かれたボタンをクリックしてダウンロード

【Mac の場合】
ダウンロードした .pkg ファイルをダブルクリック →
「続ける」→「続ける」→「同意する」→「インストール」と進む →
パスワードを求められたら、Macのログインパスワードを入力 →
「インストールが完了しました」と表示されたら完了

【Windows の場合】
ダウンロードした .msi ファイルをダブルクリック →
「Next」→「I accept the terms...」にチェック →「Next」→「Next」→「Next」→「Install」と進む →
「ユーザーアカウント制御」のダイアログが出たら「はい」をクリック →
「Finish」をクリックして完了

インストールが終わったら「できた」と教えてください。
```

> インストール後、ユーザーに Claude Code を再起動してもらう必要がある場合がある。
> 再起動後に `node -v` で確認する。

### 1. 依存関係のインストール

- `node_modules` がなければ `npm install` を実行する
- エラーが出た場合は Node.js のインストールが正しくできているか確認する

### 2. LINE Messaging API の設定

#### ステップA: LINE Developers でチャンネルを作成

```text
まず、LINE Botのチャンネルを作ります。

1. https://developers.line.biz/console/ を開く
2. 既存のプロバイダーを選ぶか、新しいプロバイダーを作成
3. 「チャンネル作成」→「Messaging API」を選択
4. チャンネル名は好きな名前でOK（例: 「サポートBot」）
5. 必要事項を入力して作成

できたら「できた」と教えてください。
```

#### ステップB: チャンネルの認証情報を取得

```text
次に、チャンネルの認証情報を取得します。

1. 今作ったチャンネルの「Messaging API設定」タブを開く
2. 一番下にある「チャンネルアクセストークン（長期）」の「発行」をクリックしてコピー
3. 次に「チャンネル基本設定」タブを開く
4. 「チャンネルシークレット」をコピー

2つともこのチャットに貼り付けてください。
```

#### ステップC: グループトーク参加を許可 + 応答メッセージをオフ

```text
次に、2つの設定を変更します。

1.「Messaging API設定」タブ →「グループトーク・複数人トークへの参加を許可する」を有効にする
2.「Messaging API設定」タブ →「LINE公式アカウント機能」→「応答メッセージ」の「編集」をクリック
  → LINE Official Account Manager が開くので「応答メッセージ」をオフにする

できたら「できた」と教えてください。
```

### 3. Anthropic Claude API キーの取得

```text
次に、AI（Claude）のAPIキーを取得します。

1. https://console.anthropic.com/ を開く
2. アカウントを作成またはログイン
3. 「API Keys」→「Create Key」でキーを作成
4. 表示されたキー（sk-ant-...で始まる文字列）をコピー

コピーしたらこのチャットに貼り付けてください。
```

### 4. Google Cloud の設定

#### ステップA: GCPプロジェクトを作成する

```text
Google Cloud Console でプロジェクトを作ります。

1. https://console.cloud.google.com/ を開く
2. 画面上部のプロジェクト選択 → 「新しいプロジェクト」をクリック
3. プロジェクト名は「line-group-bot」などでOK
4. 「作成」をクリック
5. 作成後、画面上部で今作ったプロジェクトが選択されていることを確認

できたら「できた」と教えてください。
```

#### ステップB: APIを有効にする

```text
次に、必要なAPIを有効にします。
3つあるので順番にやっていきます。

1. 画面上部の検索バーに「Google Sheets API」と入力 →「有効にする」をクリック
2. 同じように「Google Drive API」を検索 →「有効にする」

2つ全部できたら「できた」と教えてください。
```

#### ステップC: OAuth同意画面を設定する

```text
次に、OAuthの設定をします。

1. 画面上部の検索バーに「Google Auth Platform」と入力してクリック
   （または https://console.cloud.google.com/auth/overview を直接開く）
2. 「開始」または「始める」ボタンが表示されたらクリック
3. 以下を入力:
   - アプリ名: 「line-group-bot」
   - ユーザーサポートメール: 自分のGmailアドレスを選択
4. 対象（ユーザータイプ）は「外部」を選択
5. 連絡先のメールアドレス: 自分のGmailアドレスを入力
6. 同意のチェックボックスにチェックを入れて「作成」をクリック

できたら「できた」と教えてください。
```

#### ステップC-2: テストユーザーを登録する

```text
次に、自分のGoogleアカウントをテストユーザーとして登録します。

1. Google Auth Platform の左メニューから「対象」をクリック
   （または https://console.cloud.google.com/auth/audience を直接開く）
2. 「テストユーザー」セクションの「+ Add users」をクリック
3. 自分のGmailアドレスを入力
4. 「保存」をクリック

できたら「できた」と教えてください。
```

#### ステップD: OAuthクライアントを作成する

```text
次に、クライアントIDとシークレットを発行します。

1. Google Auth Platform の概要ページで「OAuthクライアントを作成」をクリック
   （または左メニューの「クライアント」→ 上部の「+ OAuthクライアントを作成」）
2. アプリケーションの種類: 「デスクトップ アプリ」を選択
3. 名前: 「line-group-bot-local」などでOK
4. 「作成」をクリック
5. ダイアログに「クライアント ID」が表示されるのでコピー
6. 次に、クライアント一覧から今作ったクライアント名をクリック
7. 詳細画面の右下にある「クライアント シークレット」をコピー

⚠️ クライアントシークレットは後から再表示できません。
   必ずこのタイミングでコピーしてください。

クライアントIDとクライアントシークレットの両方を、
このチャットにそのまま貼り付けてください。
```

### 5. .env の自動生成

ここまでに収集した情報で `.env` を自動生成する。

```env
LINE_CHANNEL_ACCESS_TOKEN=（ステップ2Bで取得）
LINE_CHANNEL_SECRET=（ステップ2Bで取得）
ANTHROPIC_API_KEY=（ステップ3で取得）
GOOGLE_CLIENT_ID=（ステップ4Dで取得）
GOOGLE_CLIENT_SECRET=（ステップ4Dで取得）
SPREADSHEET_ID=（ステップ7で設定）
ADMIN_USER_ID=（ステップ8で設定）
PORT=3000
```

> **ユーザーにファイルを直接編集させない。**
> チャットに値を貼り付けてもらい、エージェントが `.env` を生成・更新する。

### 6. Google 認証

`credentials/tokens.json` がなければ:

1. `node auth-google.mjs` を実行
2. ブラウザが開いたら、ユーザーに Google 認証を完了してもらう
3. `credentials/tokens.json` ができたことを確認する

```text
今からGoogleの認証を行います。
ブラウザが自動で開くので、Googleにログインして「許可」をクリックしてください。

完了したら「できた」と教えてください。
```

> ⚠️ 「アクセスがブロックされました」エラーが出た場合:
> ステップC-2でテストユーザーの登録を再確認してもらう。

### 7. スプレッドシートの作成

```text
次に、Bot が使うスプレッドシートを作成します。
テンプレートから自動でコピーされます。
```

1. `node tools/init-spreadsheet.mjs --id` を実行
2. 作成されたスプレッドシートのURLをユーザーに見せる
3. `.env` に `SPREADSHEET_ID` が自動保存される

### 8. デプロイ（Render.com）

```text
最後に、Botをインターネット上に公開します。
Render.com という無料のサービスを使います。

1. https://render.com でアカウントを作成（GitHubアカウントで登録が簡単）
2. 「New」→「Web Service」をクリック
3. 「Build and deploy from a Git repository」を選択
```

GitHubにリポジトリがある場合はそれを接続。
ない場合はGitHub リポジトリの作成をサポートする。

設定値:
- Build Command: `npm install`
- Start Command: `npm start`
- Plan: Free

環境変数は `.env` の内容を全てコピーする。
加えて `GOOGLE_TOKENS_JSON` に `credentials/tokens.json` の内容をJSON文字列として設定する。

### 9. Webhook URLの設定

デプロイ完了後:

```text
Render.com のURL（https://xxx.onrender.com）をコピーして、
LINE Developers Console → Messaging API設定 → Webhook URL に以下を入力してください:

https://xxx.onrender.com/webhook

「更新」→「Webhookの利用」をオンにしてください。
「検証」ボタンを押して「成功」と表示されればOKです。

できたら「できた」と教えてください。
```

### 10. ADMIN_USER_ID の設定

```text
最後に、あなたのLINE ユーザーIDを設定します。
これを設定すると、あなたのメッセージにはBotが反応しなくなります。

1. LINEアプリで、あなた + 公式LINEアカウント のグループを作る
2. グループで何かメッセージを送る
3. Render.com の「Logs」タブで user=Uxxxx... の部分をコピー

コピーしたらこのチャットに貼り付けてください。
```

`.env` と Render.com の環境変数の両方に `ADMIN_USER_ID` を設定する。

### 11. 完了

```text
セットアップが完了しました！

グループLINEでメッセージを送ってBotが返答するか試してみてください。
```

## 完了条件

- `.env` が存在し、全必須項目が設定されている
- `credentials/tokens.json` が存在する
- スプレッドシートが作成され、`SPREADSHEET_ID` が設定されている
- Render.com にデプロイされ、Webhook が接続されている
- LINE グループで Bot が応答する

## よくあるエラーと対応

| エラーメッセージ | 原因 | 対応 |
|---------------|------|------|
| `GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です` | `.env` がないか値が空 | ステップ4の手順を案内 |
| `トークンファイルが見つかりません` | Google 認証未完了 | ステップ6の認証フローを案内 |
| `アクセスがブロックされました` | テストユーザー未登録 | ステップ4 C-2を案内 |
| `Invalid signature` | LINE チャンネルシークレットが違う | ステップ2を再確認 |
| `SPREADSHEET_ID が未設定` | スプシ未作成 | ステップ7を案内 |
