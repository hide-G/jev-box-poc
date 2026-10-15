# jev Box PoC — 画像内オブジェクトの座標検出デモ

TypeSafe AI「System One」モデル **jev** の **Box（バウンディングボックス）** を試す検証用アプリです。
任意の画像に対して「何を探すか」を自由入力で指定すると、その対象の座標を取得し、画像上に矩形で描画します。

- 画像をアップロード
- プロンプト（instructions）を**自由入力**（例: `23` / `the number in the image`）
- **翻訳ボタン**でプロンプトを日本語⇔英語に変換（Amazon Bedrock / Nova）
- **jev に送信** → 座標を**数値表示**し、画像上に**緑の矩形**を描画
- **リセット**で画像・プロンプト・結果をクリア

> jev は日本語プロンプトも受け付けますが、日本語精度は英語と同等とは限りません。
> 翻訳ボタンで英語化してから送ると精度を比較しやすくなります。

ローカル（`node server.mjs`）と AWS（S3 + CloudFront + Lambda + DynamoDB）の両方で動くように作っています。

## 利用上限と来訪者カウンタ

外部公開を想定し、API コストの総量を抑えるため**日次上限**を設けています。

- jev への送信は **1 日 100 回まで**（東京時間 0 時に自動リセット）。
- 送信成功のたびにカウンタが進み、UI に「**今日 N 人目 / 累計 M 人目**」を表示します。
- 上限に達した日は送信ボタンが無効になり、`本日 100/100（上限到達）` を表示します。
- 翻訳にも別枠で **1 日 100 回**の上限を設けています（内部のコスト制御用で、来訪者カウンタには寄与しません）。
- 短時間に集中アクセスがあると一時的に「アクセスが集中しています」を返します（IP 単位のレート制限）。

日次リセットは「東京日キー（YYYY-MM-DD）が変わる」ことで自然に実現しており、専用のリセット処理は不要です。

## 構成

```
jev-box-poc/
├─ server.mjs            # ローカル中継サーバー（薄い HTTP アダプタ）
├─ src/                  # 環境非依存の共有ロジック（ローカル / Lambda 共通）
│   ├─ config.mjs        #   設定の集約
│   ├─ validate.mjs      #   入力バリデーション
│   ├─ secrets.mjs       #   Secrets Manager から API キー取得
│   ├─ jev.mjs           #   jev Box API 呼び出し
│   ├─ translate.mjs     #   Bedrock(Nova) 翻訳
│   ├─ tokyo-day.mjs     #   東京日キー
│   ├─ counter.mjs       #   IP レートリミッタ
│   ├─ store-file.mjs    #   カウンタ永続化（ローカル: counter.json）
│   ├─ store-dynamo.mjs  #   カウンタ永続化（AWS: DynamoDB）
│   └─ handlers.mjs      #   /api/box, /api/translate の本体ロジック
├─ lambda/index.mjs      # Lambda Function URL エントリ（AWS 用アダプタ）
├─ infra/                # CDK（TypeScript）一式
├─ package.json
├─ .env.example          # 接続情報のテンプレート（.env にコピーして使う）
└─ public/
    ├─ index.html        # UI
    ├─ app.js            # 画像リサイズ・翻訳・送信・座標描画
    └─ config.js         # ランタイム設定（apiBase）。ローカルは相対、AWS は Function URL
```

### 設計方針

ビジネスロジックは環境非依存の純モジュール（`src/`）に集約し、ローカルの `server.mjs` と
AWS の `lambda/index.mjs` が**同じコードを呼ぶ**構成です。永続化（カウンタ）だけを
ファイル（`store-file.mjs`）と DynamoDB（`store-dynamo.mjs`）で差し替えています。

> ローカルのファイルストアは**単一プロセス起動**を前提にしています（複数プロセスでの共有は非対応・PoC 制約）。

## 仕組み（jev 仕様に沿った設計）

- **Box プリミティブ**: 「画像内のどこに何があるか」を返す質問タイプ。1 質問 = 1 ボックス。
  - リクエスト: `{ type: "box", instructions: "探すものの説明" }` ＋ 画像を `assets` で渡す
  - レスポンス: `{ box: { top, bottom, left, right }, confidence }`。各辺は **0〜1 の割合**（左上原点）
  - ピクセル座標 = 各辺 × 画像の幅/高さ
- **Jev 1.14 が必要**（モデル `jev-1.14.0`）。画像利用には `TypeSafe-Danger-Zone-Images: true` ヘッダーが必須
- **API キーはブラウザに置かない**。中継（サーバー / Lambda）が AWS Secrets Manager から取得して jev を呼ぶ

## 前提

- Node.js 20 以上（確認環境: v24）
- AWS CLI 設定済みで、以下にアクセスできること
  - Secrets Manager: jev の API キーを格納した Secret（`SECRET_ID` で指定）
  - Amazon Bedrock: 翻訳に使う Nova モデル（`BEDROCK_MODEL` で指定）

## ローカル実行

接続情報はコードに書かず、`.env` で渡します。`.env` は `.gitignore` 済みで、リポジトリには含めません。

```powershell
copy .env.example .env   # 作成後、自分の環境の値を記入する
npm install              # 初回のみ
npm start                # = node server.mjs
npm test                 # = node --test（ユニットテスト）
```

ブラウザで <http://localhost:8787> を開く。

`.env` の例:

```
AWS_PROFILE=your-aws-profile
AWS_REGION=ap-northeast-1
SECRET_ID=your/api-key-secret
BEDROCK_MODEL=amazon.nova-lite-v1:0
```

### 設定（環境変数で上書き可能）

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `8787` | 待ち受けポート |
| `AWS_PROFILE` | （未設定 / 既定プロファイル） | 使用する AWS プロファイル |
| `AWS_REGION` | `ap-northeast-1` | リージョン |
| `SECRET_ID` | （未設定・**必須**） | jev キーを格納した Secrets Manager の Secret 名。未設定だと起動時にエラー |
| `JEV_MODEL` | `jev-1.14.0` | Box 対応モデル |
| `JEV_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` | jev エンドポイント |
| `BEDROCK_MODEL` | `amazon.nova-lite-v1:0` | 翻訳に使う Bedrock モデル |
| `DAILY_LIMIT` | `100` | jev 送信の 1 日あたり上限 |
| `TRANSLATE_DAILY_LIMIT` | `100` | 翻訳の 1 日あたり上限 |

> API キーなどの接続情報は環境変数と Secrets Manager で管理し、リポジトリには含めないでください。

## AWS へのデプロイ（CDK）

S3（静的ホスティング）+ CloudFront + Lambda Function URL + DynamoDB（カウンタ永続化）で構成します。

```powershell
cd infra
npm install
npx cdk bootstrap --profile <your-profile>                 # 初回のみ
npx cdk deploy --profile <your-profile> -c secretId=<secret-name>
```

- `secretId` には jev キーを格納した Secrets Manager の Secret 名を**デプロイ時の引数**で渡します
  （リポジトリには実名を含めません）。
- デプロイ出力（CfnOutput）に CloudFront の公開 URL（`SiteUrl`）、Lambda の `FunctionUrl`、
  `CounterTableName` が表示されます。

### config.js による両対応の仕組み

`public/config.js` はローカル用に `apiBase: ''`（相対＝同一オリジン）をコミットしています。
AWS デプロイ時は CDK（`BucketDeployment` の `Source.data` 後勝ち上書き）が、Function URL 入りの
`config.js` を S3 に**上書き生成**します（ローカルファイルは書き換えません）。
実デプロイ後は、S3 上の `config.js` が Function URL 入りに置換されていることを確認してください。

## 使い方

1. 画像（PNG / JPEG）をドラッグ&ドロップ、またはクリックで選択
   - jev の制限（各辺 256〜1568px）に合わせて**自動リサイズ**します
2. プロンプトを自由入力（例: `画像内の数字 23`）
   - 例チップをクリックすると入力欄に反映されます
   - 必要なら **🌐 翻訳（日⇔英）** ボタンで英語化（または日本語化）。結果は入力欄に反映されます
3. **jev に送信**（または Ctrl+Enter）
4. 結果:
   - 画像上に**緑の矩形**＋ラベル（プロンプト先頭 + confidence）
   - 右下に**割合(0〜1)・ピクセル座標・矩形サイズ・confidence・レイテンシ**を数値表示
   - 「jev との通信ログ」で送受信 JSON を確認可能
5. **リセット**でクリア

## Box 利用上の注意（jev 仕様）

- **1 回につき 1 つの対象**の座標を返します。別の対象を調べるときは**プロンプトを変えて再送信**してください。
- Box には「見つからない」という回答がありません。対象が無くても必ず矩形を返すため、
  **confidence が低いときは結果を鵜呑みにしない**でください（しきい値は画像に合わせて調整）。
- 小さな対象を大きな画像から探すときは confidence が下がりやすいです。対象を具体的に名指しする、
  または対象付近を拡大した画像で試すと精度が上がります。

## セキュリティ

- API キーは Secrets Manager にのみ存在し、ブラウザや通信ログには出しません。
- 中継（サーバー / Lambda）はログに画像の base64 全体を出さず、サイズと形式のみ記録します。
