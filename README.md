# KESHIYON — Browser Edition

Python/PyQt6版「消し四目並べ」を、HTML・CSS・JavaScriptだけで動く静的ウェブアプリへ移植した版です。

## 実行方法

### GitHub Pages

1. このフォルダ内の `index.html`、`style.css`、`game.js`、`ai.js`、`ai-worker.js` をGitHubリポジトリの公開するフォルダへ配置します。
2. GitHubリポジトリの **Settings → Pages** を開き、公開元ブランチとフォルダ（通常は `main` / `/ (root)`）を指定します。
3. 公開されたPagesのURLをブラウザで開きます。

ビルド、Python、Node.js、サーバーサイド処理は不要です。GitHub Pagesでファイルを静的配信するだけで動きます。

### PCでローカル確認

ES ModulesとWeb Workerを使うため、`index.html` をファイルから直接開くのではなく、簡易HTTPサーバーで開くのがおすすめです。PythonがあるPCなら、このフォルダで次を実行します。

```bash
python -m http.server 8000
```

その後 `http://localhost:8000` を開きます。これはローカル確認のためだけの方法で、公開時には必要ありません。

## 対応機能

- 人間同士の対局
- ブラウザ内で動くローカルAI（反復深化・αβ枝刈り）
- AI思考時間と評価重みの調整
- 元コードに合わせた5列×最大6行の盤面、重力、四目判定、ロック／削除モード、盤面拡張、得点、終了判定
- 外部API AIへのリクエスト（接続先がブラウザからの通信を許可している場合）
- 対局ログ、レスポンシブ表示

## ブラウザ版での制約

- 外部APIモードは、APIの稼働状況とCORS設定に依存します。ブラウザからのクロスオリジン通信が拒否される場合、静的サイト側だけではその制限を回避できません。
- 元の `C++ AI` は `engine.exe` を起動する仕組みだったため、そのままではブラウザで実行できません。
- 元の `AlphaZero (HF Local)` はPyTorchとモデルファイルをPythonから読み込む方式だったため、この静的版には含めていません。ブラウザで動かすには別途モデル／推論実装の移植が必要です。
- ローカルAIは元コードの評価関数・探索方式をJavaScriptに移植したものです。ブラウザ内で利用できますが、C++ AI／AlphaZeroと同一の棋力や探索結果を保証するものではありません。

## ファイル

- `index.html` — 画面構造
- `style.css` — ダークテーマとレスポンシブ表示
- `game.js` — ゲーム状態・ルール
- `ai.js` — ブラウザ用ローカルAI
- `ai-worker.js` — AI探索をバックグラウンドで実行するWeb Worker
