# Park Park Lunch

東京23区の業務ドライバー向けに、昼食候補と駐車候補を安全側に表示するWeb/PWA MVPです。

## What This MVP Does

- `GET /api/lunch-spots?lat&lng&radiusM&vehicleType&time` で候補を返します。
- 初見でも分かるように、検索結果を「停めやすい候補」と「駐車未確認」に分けます。
- 「停めやすい候補」には、車から受け取れる可能性、パーキングメーター近く、近くに駐車場がある店舗を表示します。
- 駐車場所が見つからない店舗は「駐車未確認」として分離します。
- 速度が10km/h以上として取得された場合、画面操作をロックします。
- 位置情報はforegroundでのみ使い、サーバーに移動履歴は保存しません。

## Run

```bash
npm start
```

Open `http://localhost:4173`.

## Google Maps

Google Maps JavaScript API を使う場合は、HTTPリファラー制限をかけたAPIキーを環境変数で渡します。

```bash
GOOGLE_MAPS_API_KEY=your_browser_key npm start
```

このMVPはGoogle Maps限定表示です。キーがない場合、またはGoogle Cloud側の認証設定が不足している場合は、地図領域にエラーを表示します。

ローカル確認では、APIキーのHTTPリファラーに `http://localhost:4173/*` を追加してください。地図表示だけをGoogle Mapsにする場合、10人が平日だけ使うMVP規模では通常は月10,000 map loadsの無料枠内に収まります。

## Test

```bash
npm test
```

## Data

`data/*.json` は空の初期データです。固定の候補データは含めていません。本番化では以下へ置換してください。

- ライブ検索: 初期状態ではOverpass APIから周辺の飲食店、コンビニ、弁当/惣菜、ベーカリー、スーパー系店舗と駐車場を取得します。
- 実店舗データ: 自社調査、店舗許諾データ、または商用利用可能なAPI。
- 時間制限駐車区間: 警視庁/JARTIC等の利用条件を満たすデータ。
- 駐車場: 商用利用可能な駐車場APIまたは許諾済みデータ。
- Google Places: 高額SKUを避け、Field MaskでID/名称/座標など必要最小限に制限してください。

ライブ検索を止める場合:

```bash
USE_LIVE_OVERPASS=0 GOOGLE_MAPS_API_KEY=your_browser_key npm start
```

この場合、候補は空になります。実店舗・駐車場データを `data/*.json` に投入して使ってください。

## GitHub Pages

GitHub Pagesは静的ホスティングなので、公開版ではブラウザからOverpass APIを直接呼びます。

Repository secretに `GOOGLE_MAPS_API_KEY` を追加してください。APIキーのHTTPリファラーには次を許可します。

```text
https://165cm.github.io/park-park-lunch/*
```

## Compliance Notes

本MVPは駐車可否を保証しません。UIとAPIレスポンスでは、常に次の表示を出します。

> 現地標識確認必須。本アプリは駐車許可を保証しません。車を離れる場合は推奨された駐車施設を利用してください。

App Store / Google Play へ進む前に、少なくとも以下を追加確認してください。

- プライバシーポリシー、問い合わせ先、データ削除導線。
- 位置情報の利用目的とforeground利用の明示。
- Google Maps Platformの利用規約、APIキー制限、請求アラート。
- WebView包装だけでなく、十分なアプリ固有機能があること。
- B2B月額課金をアプリ内で売る場合のApple/Google課金ポリシー。
