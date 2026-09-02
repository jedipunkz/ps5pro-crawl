# ps5pro-crawl

PlayStation 5 Pro の**公式サイトに掲載されている取扱店**の在庫を GitHub Actions で定期的にクロールし、
在庫を検知したら Discord に通知します。

対象店舗は [PlayStation 公式の購入ページ](https://www.playstation.com/ja-jp/ps5/buy-now/ps5-pro/) の
「販売店を選択」モーダルに掲載されている 12 社から取得しています。

## セットアップ

### 1. Discord Webhook を用意する

Discord のチャンネル設定 → **連携サービス** → **ウェブフック** → **新しいウェブフック** で作成し、
**ウェブフック URL をコピー**します。

### 2. リポジトリに登録する

GitHub リポジトリの **Settings → Secrets and variables → Actions** で以下を設定します。

| 種別 | 名前 | 必須 | 内容 |
| --- | --- | --- | --- |
| Secret | `DISCORD_WEBHOOK_URL` | ✅ | 手順 1 で取得した Webhook URL |
| Variable | `DISCORD_MENTION` | | 在庫検知時のメンション。例: `<@&123456789012345678>` / `@here` |
| Variable | `NOTIFY_ON_SOLD_OUT` | | `false` で「在庫あり → 在庫なし」通知を止める（既定は通知する） |
| Variable | `NOTIFY_ON_ERROR` | | `true` で連続取得失敗も通知する（セレクタ切れの検知用） |
| Variable | `ERROR_THRESHOLD` | | 連続失敗の通知しきい値（既定 `3`） |

Webhook URL は Secret に入れてください。URL を知っている人は誰でもそのチャンネルに投稿できます。

### 3. 有効化

`.github/workflows/stock-check.yml` が 10 分間隔で動きます。

### 4. 通知が届くか確かめる

在庫が復活するまで待たなくても、Webhook の設定だけ先に確認できます。

**Actions** タブ → 左の **「PS5 Pro 在庫チェック」** → 右上の **「Run workflow」** →
`実行内容` で **`test-notify`** を選んで実行してください。
Discord に疎通テストのメッセージが届けば設定完了です。

## 手動実行（workflow_dispatch）

Actions タブの **「Run workflow」** から、`実行内容` を選んで実行できます。

| 実行内容 | 動作 | 使いどころ |
| --- | --- | --- |
| `normal` | 定期実行と同じ。状態が変化していれば通知 | すぐ結果を知りたいとき |
| `dry-run` | 通知せず結果だけ出す | 判定文言を調整したとき |
| `force-notify` | 前回状態を無視。在庫ありならその場で必ず通知 | 通知経路の確認 |
| `test-notify` | 在庫を見ず Discord に疎通テストだけ送る | Webhook 設定直後 |

補助的な入力が 2 つあります。

- **`only`** — `sony-store,rakuten-books` のように店舗を絞ります（id は `config/targets.json` 参照）。
- **`http_only`** — Chromium が要る店舗を除外します。ブラウザのインストールを飛ばすぶん起動が速くなります。

判定結果は実行ログではなく **Actions のジョブサマリ**に表で出ます。全店舗の状態と判定根拠が一覧できるので、
文言を調整するときはここを見てください。

`force-notify` と `test-notify` では**状態を保存しません**。手動実行の副作用で
次の定期実行の判定が狂わないようにするためです。

ローカルから同じことをする場合は `--no-state` / `--test-notify` を使います。

## ローカルでの実行

```bash
npm ci
npx playwright install --with-deps chromium   # browser モードの店舗を見る場合のみ

npm run http                                  # Chromium 不要な店舗だけを通知なしで確認
npm run dry                                   # 全店舗を通知なしで確認
node src/index.js --only sony-store --dry-run # 店舗を絞って確認
node src/index.js --test-notify               # Discord への疎通テストだけ送る
node src/index.js --help                      # オプション一覧
npm test                                      # 在庫判定ロジックのテスト
```

通知まで試す場合は `DISCORD_WEBHOOK_URL` を環境変数に入れて `npm run check` を実行します。

## 仕組み

```
config/targets.json  店舗ごとの URL・取得方式・在庫判定文言
        │
src/fetcher.js       http (fetch) / browser (Playwright) でページを取得
        │
src/detect.js        selector でテキストを絞り、在庫なし → 在庫あり の順に文言照合
        │
src/transitions.js   前回状態と突き合わせ、変化したものだけを抽出
        │
src/discord.js       Webhook に Embed で通知
```

### 状態の持ち回り

前回の在庫状態は `.state/state.json` に保存し、Actions では `actions/cache` で持ち回します。
**通知は状態が変化したときだけ**送るので、在庫なしが続く間は無通知です。

キャッシュは 7 日で失効します。失効しても壊れませんが、その回だけ在庫状態を再通知することがあります。

### エラーを在庫変化として扱わない

取得失敗（403 など）や判定不能のとき、`lastKnownStatus` に**最後に確定した状態**を保持します。
これがないと、403 を挟んで復帰するたびに「在庫あり」を再通知してしまいます。

## 在庫判定の設定

`config/targets.json` の 1 店舗ぶんは次の形です。

```jsonc
{
  "id": "sony-store",
  "name": "ソニーストア",
  "url": "https://pur.store.sony.jp/ps5/products/ps5/CFI-7000B01_product/",
  "mode": "http",                                  // http | browser
  "selector": ".s5-sonystoreBlock__buyAtStore, .s5-shippingLabel",  // 判定範囲を絞る CSS セレクタ
  "outOfStock": ["入荷待ち", "販売終了"],           // 先に評価される（正規表現）
  "inStock": ["在庫あり", "カートに入れる"],
  "verified": true,                                // 実ページで検証済みか
  "enabled": true
}
```

判定は次の順です。**在庫なしを先に見る**のは、在庫切れページにも「カートに入れる」等の文言が
残っていることが多く、逆順だと誤通知になるためです。

1. ボット判定ページの文言に一致 → `判定不能`
2. ページ本文が `minTextLength` 未満 → `判定不能`
3. `selector` が 1 件も一致しない → `判定不能`（サイト改修の検知）
4. `outOfStock` に一致 → `在庫なし`
5. `inStock` に一致 → `在庫あり`
6. どれにも一致しない → `判定不能`

`判定不能` と `取得失敗` では通知しません。誤通知より取りこぼしを選ぶ設計です。

## 対象店舗と現状

2026-09-02 時点で実際にアクセスして確認した結果です。

| 店舗 | 取得方式 | 判定文言の検証 | 備考 |
| --- | --- | --- | --- |
| ソニーストア | http | ✅ 検証済み | `入荷待ち` を確認 |
| 楽天ブックス | http | ✅ 検証済み | `ご注文できない商品` を確認 |
| ヨドバシ.com | browser | ✅ 検証済み | `販売を終了しました` を確認 |
| ノジマオンライン | browser | ✅ 検証済み | `販売終了` を確認 |
| Amazon.co.jp | browser | ⚠️ 未検証 | 在庫欄が非同期描画 |
| ビックカメラ.com | browser | ⚠️ 未検証 | 403 のため実ページ未確認 |
| Joshin webショップ | browser | ⚠️ 未検証 | 同上 |
| エディオン | browser | ⚠️ 未検証 | 同上 |
| ゲオオンラインストア | browser | ⚠️ 未検証 | 同上 |
| TSUTAYA | browser | ⚠️ 未検証 | 同上 |
| セブンネットショッピング | browser | ❌ 無効 | 公式サイトのリンクが 404 |
| ヤマダウェブコム | browser | ❌ 無効 | 公式サイトのリンクが 404 |

### `mode` の使い分け

- **`http`** — Node の `fetch`。速く、Chromium も不要。
- **`browser`** — Playwright の Chromium。次のどちらかに当てはまる店舗で必要です。
  - **HTTP/1.1 だと弾かれる**: ノジマは HTTP/1.1 で `403`、HTTP/2 で `200` を返すことを確認しました。
    Node の `fetch` は HTTP/1.1 のみなので、HTTP/2 を話す Chromium が必要です。
  - **在庫欄が JavaScript で後から描画される**: Amazon が該当します。

### ⚠️ 未検証の店舗について

「未検証」の 6 店舗は、データセンター IP からのアクセスが 403 で弾かれるため、
**在庫ありのページを実際に見て判定文言を確認できていません**。設定してある文言は一般的なものです。

GitHub Actions の Runner も Azure のデータセンター IP なので、同様に弾かれる可能性があります。
まずは `NOTIFY_ON_ERROR=true` を設定して数日動かし、Actions のサマリで各店舗の判定結果を確認したうえで、
`outOfStock` / `inStock` の文言を実際の表示に合わせて調整してください。

**確実に動くのはソニーストアと楽天ブックス**（実ページで検証済み・`http` モード）です。

### 商品リンクの陳腐化について

公式ページのリンクは古いままのことがあります。実際に 7net とヤマダは 404、
ヨドバシとノジマは「販売終了」表記の SKU を指していました。
リンク切れは `判定不能` / `取得失敗` として記録され、`NOTIFY_ON_ERROR=true` なら通知されます。
新しい商品 URL が分かったら `config/targets.json` を更新してください。

## 運用上の注意

- **cron の間隔**: GitHub の `schedule` は混雑時に数分〜十数分遅延します。実行間隔は保証されません。
  人気商品の再販は数分で売り切れるため、このアプリは**確実に買うための手段ではなく、
  再販に気づくための手段**として使ってください。
- **アクセス頻度**: 並列数は既定 3、リトライは指数バックオフです。
  間隔を極端に短くすると相手サイトに負荷をかけ、ブロックされる可能性が高くなります。
- **終了コード**: 個別店舗の失敗ではジョブを失敗させません（403 は日常的なため）。
  **全店舗が判定不能**になったときのみ exit 1 になります。
