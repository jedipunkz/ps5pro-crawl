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
| `diagnose` | 通知せず、取得した HTML をアーティファクトに保存 | 判定が合わない店舗を直すとき |

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

任意で指定できるものが 4 つあります。

| キー | 用途 |
| --- | --- |
| `warmupUrl` | 商品ページの前にトップページを踏んで Cookie を得る。WAF のチャレンジ対策 |
| `settleMs` | ページ取得後の待ち時間 (ms)。JS チャレンジや遅延描画が重い店舗向け（既定 1500） |
| `waitForSelector` | この要素が出るまで待ってから判定する |
| `disableHttp2` | `ERR_HTTP2_PROTOCOL_ERROR` が出る店舗で HTTP/2 を無効にする |

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

GitHub Actions 上での実測結果です（2026-09-02）。

| 店舗 | 取得方式 | Actions での結果 | 原因 |
| --- | --- | --- | --- |
| ソニーストア | http | ✅ 判定できる | — |
| 楽天ブックス | http | ✅ 判定できる | — |
| エディオン | browser | ⚠️ 取得は成功・判定失敗 | セレクタ未特定。Cloudflare の JS チャレンジあり |
| ビックカメラ.com | browser | ❌ 取得失敗 | `ERR_HTTP2_PROTOCOL_ERROR` → HTTP/2 を無効化して様子見 |
| Joshin webショップ | browser | ❌ 取得失敗 | Akamai がデータセンター IP を遮断 |
| ゲオオンラインストア | browser | ❌ 取得失敗 | 同上 |
| ヨドバシ.com | browser | ❌ 取得失敗 | Actions の IP で 403 |
| ノジマオンライン | browser | ❌ 取得失敗 | 同上 |
| Amazon.co.jp | browser | ❌ ブロックページ | Actions の IP で遮断（本文 99 文字） |
| TSUTAYA | — | 🚫 無効 | **2025-10-31 にサービス終了**。公式ページのリンクが残存 |
| セブンネットショッピング | — | 🚫 無効 | 公式サイトのリンクが 404 |
| ヤマダウェブコム | — | 🚫 無効 | 公式サイトのリンクが 404 |

### なぜ多くの店舗で取得できないのか

**GitHub Actions の Runner が Azure のデータセンター IP を使っているため**です。
日本の大手 EC は転売対策として、この帯域を WAF で広く遮断しています。
実際に返ってきた遮断ページから、次の 2 つが確認できました。

- **Akamai** — `Access Denied ... Reference #18.xxxx` / `errors.edgesuite.net`（Joshin・ゲオ・ビックカメラ）
- **Cloudflare** — `Just a moment... Enable JavaScript and cookies to continue`（エディオン）

ブラウザのフィンガープリントや HTTP バージョンの問題ではなく **IP レピュテーション**なので、
User-Agent やヘッダを変えても通りません。実際、同じコードでも
データセンター以外の回線からは HTTP/2 でヨドバシ・ノジマとも取得できています。

### 遮断ページを在庫ありと誤読しないこと

遮断ページやチャレンジページは `blockedPatterns` で検出し、必ず `判定不能` にします。
WAF の文言は `<title>` や `<noscript>` にしか無いことがあるため、
**遮断判定だけは `<title>` と `<noscript>` を含む全文**に対して行っています。

実際に各 WAF から返された遮断ページを `test/fixtures/blocked/` に保存し、
「どの店舗の設定で読ませても在庫ありにならない」ことをテストしています。

### 取得できない店舗への対処

| 方法 | 効果 | コスト |
| --- | --- | --- |
| **セルフホストランナー**（自宅回線など） | 大きい。IP 遮断がそのまま解消する | 常時起動するマシンが要る |
| 公式 API に切り替える（楽天市場・Yahoo!ショッピング） | 確実。WAF を通らない | API キー取得。対象は各モールの出店店舗 |
| プロキシサービスを挟む | 効くが規約・費用の検討が必要 | 有料 |
| 諦めて動く店舗だけ監視する | 現状。ソニーストアと楽天ブックスは安定 | ゼロ |

**セルフホストランナーが最も筋の良い解**です。`.github/workflows/stock-check.yml` の
`runs-on: ubuntu-latest` を自前ランナーのラベルに変えるだけで、コードの変更は要りません。

### 判定が合わないときの直し方

ローカルから取得できない店舗でも、**Actions 自身に取得結果を持ち帰らせれば**実データで直せます。

1. Actions タブ → **Run workflow** → `実行内容` に **`diagnose`** を選んで実行
2. 実行が終わったら、ジョブ画面下部の **Artifacts** から `crawl-dump-<run_id>` をダウンロード
3. `<店舗id>.html`（生 HTML）、`<店舗id>.txt`（抽出テキスト）、`<店舗id>.note.txt`（判定結果）が入っている
4. 実際の在庫表記を確認し、`config/targets.json` の `selector` / `outOfStock` / `inStock` を修正

403 の店舗でも、遮断ページの本文がそのまま保存されるので原因を特定できます。

ローカルなら `node src/index.js --dry-run --dump-dir dump` で同じものが取れます。

## 運用上の注意

- **cron の間隔**: GitHub の `schedule` は混雑時に数分〜十数分遅延します。実行間隔は保証されません。
  人気商品の再販は数分で売り切れるため、このアプリは**確実に買うための手段ではなく、
  再販に気づくための手段**として使ってください。
- **アクセス頻度**: 並列数は既定 3、リトライは指数バックオフです。
  間隔を極端に短くすると相手サイトに負荷をかけ、ブロックされる可能性が高くなります。
- **終了コード**: 個別店舗の失敗ではジョブを失敗させません（403 は日常的なため）。
  **全店舗が判定不能**になったときのみ exit 1 になります。
