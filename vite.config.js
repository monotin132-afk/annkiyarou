# 数学カード（すごい暗記帳）

写真から数学の問題カードを作って、フリップカード式に復習できるアプリです。
データはブラウザの IndexedDB に保存されます（このブラウザ専用、他のデバイスとは自動では同期しません）。

## 動作確認（このパソコンで試す）

```
npm install
npm run dev
```

表示されたURL（通常 http://localhost:5173）をブラウザで開いてください。

## Webに公開する（無料・最短ルート：Vercel）

1. このフォルダ一式を GitHub のリポジトリにアップロードする
   （GitHubのアカウントが必要です。アカウントがなければ https://github.com で作成）
2. https://vercel.com にアクセスし、GitHubアカウントでログインする
3. 「Add New Project」→ 先ほどのリポジトリを選択
4. Framework Preset は自動で "Vite" と認識されるはずなので、そのまま「Deploy」を押す
5. 数十秒〜数分でビルドが終わり、`https://（プロジェクト名）.vercel.app` のようなURLが発行される

以後、コードを更新してGitHubにpushするたびに自動で再デプロイされます。

## Netlifyを使う場合

1. https://app.netlify.com にアクセスしGitHubでログイン
2. 「Add new site」→「Import an existing project」→ リポジトリを選択
3. Build command: `npm run build` / Publish directory: `dist` を指定（自動検出されることが多い）
4. 「Deploy」を押す

## 注意点（重要）

- データは「そのブラウザ・その端末専用」です。スマホとパソコンで別々のデータになります。
- ブラウザのキャッシュ・閲覧データを消去すると、保存したカードも消えます。
- 大事なデータはアプリ内の「データの引っ越し」機能でこまめにJSONファイルとして書き出しておくことをおすすめします。
- 複数デバイスでの自動同期がほしい場合は、別途データベース（Supabase等）とログイン機能を追加する必要があり、追加の開発が必要です。
