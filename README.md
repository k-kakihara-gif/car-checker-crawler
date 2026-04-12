# car-checker-crawler

カーセンサーの全ページを巡回して価格を収集するクローラーです。
GitHub Actionsで毎日自動実行されます。

## 動作の仕組み

- 毎日日本時間 午前2時に自動実行
- 前回の続きページから再開
- 1ページ4秒待機（サーバー負荷対策）
- 最大5時間30分実行して自動停止
- 17,570ページを約59日で1周

## GitHubのSecretsに設定が必要

Settings → Secrets → Actions に以下を追加：

| 名前 | 値 |
|---|---|
| SUPABASE_URL | SupabaseのProject URL |
| SUPABASE_KEY | Supabaseの秘密の鍵 |
