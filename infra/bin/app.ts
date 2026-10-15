#!/usr/bin/env node
// ============================================================
// bin/app.ts - CDK アプリのエントリ
// ------------------------------------------------------------
// account / region はハードコードせず、CLI 環境（CDK_DEFAULT_ACCOUNT /
// CDK_DEFAULT_REGION）から解決する。`cdk deploy --profile <プロファイル>`
// 実行時にプロファイル設定由来の値が入る。
// ============================================================

import * as cdk from "aws-cdk-lib";
import { JevBoxPocStack } from "../lib/jev-box-poc-stack";

const app = new cdk.App();

new JevBoxPocStack(app, "JevBoxPocStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description:
    "jev Box PoC: S3 + CloudFront + Lambda Function URL + DynamoDB",
});
