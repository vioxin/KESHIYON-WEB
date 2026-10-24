# KESHIYON — GitHub Pages + オンライン対戦 + Google Sheets

KESHIYONブラウザ版に、Render上のWebSocketサーバーを使ったオンライン対戦を追加した一式です。画面はGitHub Pagesの静的ウェブで配信し、サーバーはルーム管理・着手検証・勝敗判定・Googleスプレッドシート保存を担当します。

## できること

- PC・スマホのブラウザ同士でオンライン対戦
- 6文字のルームコードで部屋を作成／参加
- 「オンラインマッチ」で待機中のプレイヤー同士を自動マッチング
- サーバー側で手番と合法手を判定し、盤面とスコアをリアルタイム同期
- 終局後に両者が再戦を申し込むと、同じルームで新しい試合を開始
- 勝敗が付いたオンライン対局だけをGoogleスプレッドシートへ保存（引き分けと途中終了は除外）
- 既存のローカル対戦・ブラウザ内AI・外部API AIを維持
- スマートフォン向けレスポンシブUI

## ファイル構成

- `index.html`, `style.css`, `app.js`, `game.js`, `ai.js`, `ai-worker.js` — GitHub Pagesの画面
- `server/index.js` — Renderで動かすNode.js + WebSocketサーバー
- `package.json` — Renderで依存関係をインストールする設定
- `render.yaml` — Render Blueprint用設定（手動でWeb Serviceを作っても構いません）
- `google-apps-script/Code.gs` — 対局結果を検証して既存のGoogleスプレッドシートに保存するコード
- `google-apps-script/KeepAlive.gs` — Render Freeへ5分おきにHTTPアクセスする任意のGASトリガー

---

## 1. Googleスプレッドシートを設定

既存の対戦記録用スプレッドシートをそのまま使えます。

1. スプレッドシートを開き、**拡張機能 → Apps Script** に進みます。
2. `Code.gs` を、このパッケージの `google-apps-script/Code.gs` で置き換えます。過去の記録シートは削除しなくて大丈夫です。
3. 必要であれば `setupSheet` を実行します。
4. **デプロイ → デプロイを管理 → 編集** から新しいバージョンをデプロイします（または新しいデプロイとしてウェブアプリを公開します）。実行ユーザーは自分、アクセスできるユーザーは全員にします。
5. WebアプリURL（`https://script.google.com/macros/s/.../exec`）を控えてください。

このApps Scriptは、受け取った着手を最初から再生し、合法手・終局・得点を検証してから勝敗が確定した対局を追記します。`○側の設定` と `×側の設定` はオンライン対局の場合 `online` として記録します。引き分けと途中終了は保存しません。スプレッドシート自体は非公開のままにしてください。

### ローカル対戦／AI対戦の記録も続ける

`app.js` の先頭近くにある次の行へ、上で控えたURLを設定します。

```js
const SHEETS_ENDPOINT = 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec';
```

これで、これまでどおり勝敗が確定したローカル対局・AI対局の記録要求も送信されます。未設定ならローカル対局の保存は無効ですが、オンライン対局はRenderの環境変数から独立して保存できます。

---

## 2. GitHub Pagesへ公開

1. このZIPを解凍し、内容をGitHubリポジトリのルートにアップロードします（ファイル名が同じ場合は上書き）。
2. リポジトリの **Settings → Pages** を開き、`main` ブランチの `/(root)` を公開元にします。
3. GitHub PagesのURLを開き、オンライン対戦欄が表示されることを確認します。

GitHub Pagesはフロントエンドのみをホストします。`server/` や `package.json` はGitHub Pages上では実行されませんが、同じリポジトリをRenderのソースとしても使います。Renderの秘密情報は環境変数で登録し、リポジトリに書かないでください。

---

## 3. Renderにオンライン対戦サーバーをデプロイ

1. Renderへログインして **New → Web Service** を選び、KESHIYONのGitHubリポジトリを接続します。
2. Root Directoryは空欄（リポジトリ直下）、RuntimeはNodeを選びます。
3. Build Commandを `npm install`、Start Commandを `npm start` にします。
4. Instance Typeは **Free** を選びます。
5. Environment Variablesに次を設定します。

| Key | Value |
|---|---|
| `SHEETS_ENDPOINT` | 手順1で控えたApps Script WebアプリURL |
| `ALLOWED_ORIGINS` | `https://USERNAME.github.io`（任意。GitHub Pagesのホスト名のみ。パスは付けない） |

GitHub Pagesのユーザー／組織名が `USERNAME` でない場合は実際のホスト名に差し替えます。独自ドメインを使っている場合はそのオリジンを指定します。`ALLOWED_ORIGINS` を空欄にするとOrigin制限は無効になります。設定を変更したらRenderを再デプロイします。

デプロイ完了後、RenderのサービスURL（例：`https://keshiyon-online.onrender.com`）を控えます。オンライン対戦画面の **RenderサーバーURL** にベースURLを入力し、接続を押します。入力値はそのブラウザに保存されます。

### 接続テスト

- `https://YOUR-SERVICE.onrender.com/healthz` を開くと、`{"ok":true,...}` の状態JSONが返ります。
- ブラウザで「サーバーに接続」→「部屋を作成」を押して6文字のコードが出ることを確認します。
- 別の端末／ブラウザで同じRender URLへ接続し、コードで参加します。
- または、2つのブラウザで「オンラインマッチ」を押すと、待機中の2人が自動的に対戦へ進みます。
- 勝敗が付くまでプレイし、スプレッドシートの `対戦記録` シートに1行追加されたことを確認します。引き分け・中断は記録されません。

---

## 4. 任意：GASからRenderを5分おきに起こす

Render Freeは15分間受信トラフィックがないとスリープします。GASから `/healthz` を定期的に呼び出すことで、アイドルスリープを避けやすくできます。ただし、RenderやGoogle側の停止・再起動・トリガー遅延まで防げるものではありません。

1. **同じApps Scriptプロジェクト**に新しいスクリプトファイル `KeepAlive.gs` を作ります。
2. このZIPの `google-apps-script/KeepAlive.gs` の内容を貼り付けます。
3. `RENDER_HEALTH_URL` を実際の `https://YOUR-SERVICE.onrender.com/healthz` に変えます。
4. 関数一覧から `setupRenderKeepAlive` を一度実行し、必要な認証を許可します。
5. Apps Scriptのトリガー一覧で `keepRenderAwake` が5分間隔で登録されたことを確認します。

このトリガーは同じGoogle Apps Scriptプロジェクトの中で実行してください。Googleはトリガー時刻の厳密な到着を保証していないため、常時稼働を保証する仕組みではありません。

---

## 無料プラン・制限と注意点

- GitHub Pages、Render Free、Google Apps Scriptの無料利用枠を使う構成です。無料枠やサービス条件は変更されることがあります。
- Render Freeは月750インスタンス時間がワークスペース単位で上限です。31日間の時間数（744時間）だけを見ると1サービス連続稼働の計算上は範囲内ですが、他サービスの利用や停止・再起動などにより常時稼働は保証されません。
- GASトリガーの時間は多少ずれることがあり、無料サーバーの24時間365日稼働保証ではありません。Renderが再起動すると、その時点のルーム、待ち行列、進行中の対局は失われます。完成済みの記録はスプレッドシートに残ります。
- マッチング対象は、同じRenderインスタンスの待機中ユーザーです。この構成では複数インスタンスへのスケールアウトを前提としていません。
- 対戦ルームはサーバーメモリ上だけに存在し、再起動後の対局復旧や切断からの再接続には対応していません。切断した場合は新しいルームを作成してください。
- ルームコードは6文字です。サイトは匿名ゲスト制で、アカウント認証や完全な不正対策はありません。サーバー側で手番・合法手を検証しますが、公開サービスへの妨害行為を完全には防げません。
- Renderに `SHEETS_ENDPOINT` が設定されていない場合、オンライン対戦自体はできますが、オンライン対局のスプレッドシート保存は失敗します。
- オンライン対局はサーバー側から保存するため、ブラウザごとの重複送信はしません。保存成功／失敗のステータスは両プレイヤーへ通知されます。

## 使用技術

- Frontend: HTML, CSS, JavaScript modules
- Online server: Node.js 20+, `ws` WebSocket library
- Hosting: GitHub Pages + Render Free
- Match records: Google Apps Script + Google Sheets
