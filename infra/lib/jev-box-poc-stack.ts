// ============================================================
// lib/jev-box-poc-stack.ts - jev Box PoC の AWS スタック
// ------------------------------------------------------------
// 構成:
//   DynamoDB      カウンタ永続化（pk 単一パーティションキー・TTL）
//   Lambda        /api/box・/api/translate（Function URL・NodejsFunction）
//   S3 + CloudFront  フロント(public/)の静的配信（OAC 経由）
//   BucketDeployment  public/ 配置 + Function URL 入り config.js 上書き生成
//
// 方針:
//   - account/region は Stack.of(this) トークンで扱い値をハードコードしない
//   - secret 名はデプロイ時にコンテキスト（-c secretId=...）で注入。既定は
//     プレースホルダ（実名はコミットしない）
//   - IAM は最小権限（対象 secret / 対象モデル / 当該テーブルのみ）
//   - CORS は Lambda 側で付与（Function URL 側 CORS は使わない）
// ============================================================

import * as path from "path";
import {
  Stack,
  StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";

// infra/lib からリポジトリルートを解決する（lambda/ と public/ の位置）
const REPO_ROOT = path.join(__dirname, "..", "..");

export class JevBoxPocStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---- デプロイ時に注入するパラメータ（コンテキスト） ----
    // secret 名の実名はコミットしないため、既定はプレースホルダ。
    // 実デプロイ: cdk deploy -c secretId=<実際の secret 名>
    const secretId =
      (this.node.tryGetContext("secretId") as string) ||
      "your/api-key-secret";
    // Bedrock 翻訳モデル（既定: Nova Lite）
    const bedrockModel =
      (this.node.tryGetContext("bedrockModel") as string) ||
      "amazon.nova-lite-v1:0";

    // ========================================================
    // DynamoDB テーブル（カウンタ）
    // ========================================================
    const table = new dynamodb.Table(this, "CounterTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expireAt",
      removalPolicy: RemovalPolicy.DESTROY, // PoC。本番なら RETAIN
    });

    // ========================================================
    // Lambda（Function URL・NodejsFunction で esbuild バンドル）
    // ========================================================
    const fn = new NodejsFunction(this, "ApiFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(REPO_ROOT, "lambda", "index.mjs"),
      handler: "handler",
      timeout: Duration.seconds(30),
      memorySize: 512,
      bundling: {
        format: OutputFormat.ESM,
        // AWS SDK v3 は Lambda ランタイム同梱なのでバンドルから除外する
        externalModules: ["@aws-sdk/*"],
      },
      environment: {
        COUNTER_TABLE: table.tableName,
        SECRET_ID: secretId,
        BEDROCK_MODEL: bedrockModel,
        JEV_ENDPOINT: "https://api.typesafe.ai/v1/systemone",
        JEV_MODEL: "jev-1.14.0",
        DAILY_LIMIT: "100",
        TRANSLATE_DAILY_LIMIT: "100",
        // ALLOWED_ORIGIN は CloudFront ドメイン確定後に下で addEnvironment する
      },
    });

    // ---- IAM 最小権限 ----
    // DynamoDB: 当該テーブルのみ read/write
    table.grantReadWriteData(fn);

    // Secrets Manager: 対象 secret 1 本のみ（6 文字サフィックス -* に対応）
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${secretId}-*`,
        ],
      })
    );

    // Bedrock: 対象モデル ARN のみ（foundation-model 直接指定）
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/${bedrockModel}`,
        ],
      })
    );

    // ---- Function URL（認証なし・公開 PoC。CORS は Lambda コードで付与） ----
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // ========================================================
    // S3（フロント配信元・非公開。CloudFront OAC 経由でのみ読取）
    // ========================================================
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY, // PoC
      autoDeleteObjects: true, // PoC
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // ========================================================
    // CloudFront（S3 を OAC オリジンに。/api/* はプロキシしない）
    // ========================================================
    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin:
          origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    // ---- CloudFront ドメインを CORS 許可オリジンとして Lambda に注入 ----
    // Lambda は Distribution を参照するだけ（Distribution は Lambda を参照しない）
    // ため循環依存は生じない。
    const allowedOrigin = `https://${distribution.distributionDomainName}`;
    fn.addEnvironment("ALLOWED_ORIGIN", allowedOrigin);

    // ========================================================
    // フロントのデプロイ（public/ 配置 + Function URL 入り config.js 上書き）
    // ========================================================
    // Function URL は末尾スラッシュ付きなので除去して apiBase に埋める
    // （app.js 側でも末尾スラッシュを除去するが二重に備える）
    const apiBase = fnUrl.url.endsWith("/")
      ? fnUrl.url.slice(0, -1)
      : fnUrl.url;

    new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [
        // public/ の素材を配置
        s3deploy.Source.asset(path.join(REPO_ROOT, "public")),
        // Function URL を埋め込んだ config.js を後置して後勝ちで上書きする
        s3deploy.Source.data(
          "config.js",
          `window.__JEV_POC_CONFIG__ = { apiBase: ${JSON.stringify(apiBase)} };`
        ),
      ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"], // デプロイ毎に CloudFront キャッシュを無効化
    });

    // ========================================================
    // 出力
    // ========================================================
    new CfnOutput(this, "SiteUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "公開 URL（CloudFront）",
    });
    new CfnOutput(this, "FunctionUrl", {
      value: fnUrl.url,
      description: "API の Function URL",
    });
    new CfnOutput(this, "CounterTableName", {
      value: table.tableName,
      description: "DynamoDB カウンタテーブル名",
    });
  }
}
