# Park Park Lunch — Developer Guide

> ユーザー向け説明は [README.md](./README.md) を参照。

## 技術スタック

| レイヤ | 採用技術 |
|---|---|
| 言語 / フレームワーク | Vanilla JS (ESModules) / Node.js 20+ |
| データ | JSON ファイル, Overpass API |
| 外部 API | Overpass API, Google Maps JavaScript API |
| デプロイ | GitHub Pages (静的), Node.js サーバ (ローカル) |

## セットアップ

```bash
git clone https://github.com/165cm/park-park-lunch.git
cd park-park-lunch
# 依存パッケージなし（Node.js 組み込みモジュールのみ）
GOOGLE_MAPS_API_KEY=your_browser_key npm start
```

ローカル確認では、APIキーの HTTP リファラーに `http://localhost:4173/*` を追加してください。

## 環境変数

| 変数 | 説明 | 必須 |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | HTTP リファラー制限付きブラウザキー | △ (なしは地図にエラー表示) |
| `USE_LIVE_OVERPASS` | `0` にすると Overpass 呼び出し停止 | - |

## スクリプト

| コマンド | 役割 |
|---|---|
| `npm start` | Node.js API サーバで起動 (`http://localhost:4173`) |
| `npm run start:static` | 静的ファイルのみサーブ |
| `npm test` | テスト実行 |

## ディレクトリ構成

```
public/          # フロントエンド (HTML / CSS / JS)
src/
├ core/          # data.mjs, geo.mjs, scoring.mjs
└ providers/     # overpass.mjs
data/            # 初期 JSON データ（空）
test/            # ユニットテスト
server.mjs       # Node.js API サーバ
```

## デプロイ手順

- ホスティング: GitHub Pages（静的）
- トリガー: `.github/workflows/pages.yml` — `main` への push で自動デプロイ
- 公開 URL: `https://165cm.github.io/park-park-lunch/`
- Repository secret に `GOOGLE_MAPS_API_KEY` を追加し、APIキーの HTTP リファラーに `https://165cm.github.io/park-park-lunch/*` を許可する

### ライブ検索を止める場合

```bash
USE_LIVE_OVERPASS=0 GOOGLE_MAPS_API_KEY=your_browser_key npm start
```

候補は空になります。`data/*.json` に実店舗・駐車場データを投入して使ってください。

## データソースの本番化

`data/*.json` は空の初期データです。本番化では以下へ置換してください。

- **飲食店**: 自社調査・商用利用可能 API、または店舗許諾データ
- **駐車場**: 商用利用可能な駐車場 API または許諾済みデータ
- **時間制限駐車区間**: 警視庁/JARTIC 等の利用条件を満たすデータ
- **Google Places**: Field Mask で ID/名称/座標など必要最小限に制限し高額 SKU を回避

## Compliance Notes

本アプリは駐車可否を保証しません。UI とAPIレスポンスで常に以下を表示します:

> 現地標識確認必須。本アプリは駐車許可を保証しません。車を離れる場合は推奨された駐車施設を利用してください。

App Store / Google Play へ進む前に、プライバシーポリシー・位置情報利用目的の明示・WebView 審査基準・Apple/Google 課金ポリシーを別途確認してください。

## AI 開発メモ

- このリポジトリは Claude Code で開発
- リポジトリ固有の作法は [.github/AGENTS.md](./.github/AGENTS.md)
- 中央マニュアル: https://github.com/165cm/portfolio/tree/main/docs/standards

## ライセンス

README と同じ ([MIT](./LICENSE))
