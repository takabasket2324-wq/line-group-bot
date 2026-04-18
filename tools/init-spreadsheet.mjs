/**
 * テンプレートスプレッドシートをコピーして、ユーザー専用のスプシを作成する
 * Usage: node tools/init-spreadsheet.mjs
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { google } from "googleapis";
import dotenv from "dotenv";

const PROJECT_ROOT = join(dirname(import.meta.url.replace("file://", "")), "..");
dotenv.config({ path: join(PROJECT_ROOT, ".env") });

const TEMPLATE_ID = "17qz19MuF52JvZW19dHkOnLHSh18AopHNhecE_3LSd1o";
const TOKENS_PATH = process.env.GOOGLE_TOKENS_PATH || join(PROJECT_ROOT, "credentials", "tokens.json");

async function main() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が .env に設定されていません");
    process.exit(1);
  }
  if (!existsSync(TOKENS_PATH)) {
    console.error(`トークンファイルが見つかりません: ${TOKENS_PATH}`);
    console.error("先に node auth-google.mjs を実行してください");
    process.exit(1);
  }

  const tokens = JSON.parse(readFileSync(TOKENS_PATH, "utf-8"));
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials(tokens);
  const drive = google.drive({ version: "v3", auth });

  console.log("テンプレートからスプレッドシートをコピー中...");

  const res = await drive.files.copy({
    fileId: TEMPLATE_ID,
    requestBody: { name: "line-group-bot 管理" },
  });

  const spreadsheetId = res.data.id;
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  // --id フラグがあれば .env に SPREADSHEET_ID を保存
  if (process.argv.includes("--id")) {
    const envPath = join(PROJECT_ROOT, ".env");
    let envContent = readFileSync(envPath, "utf-8");
    if (envContent.includes("SPREADSHEET_ID=")) {
      envContent = envContent.replace(/SPREADSHEET_ID=.*/, `SPREADSHEET_ID=${spreadsheetId}`);
    } else {
      envContent += `\nSPREADSHEET_ID=${spreadsheetId}\n`;
    }
    writeFileSync(envPath, envContent);
    console.log(`.env に SPREADSHEET_ID を保存しました`);
  }

  console.log(`\n作成完了！`);
  console.log(`URL: ${url}`);
  console.log(`SPREADSHEET_ID=${spreadsheetId}`);
  console.log(`\nこのIDをRender.comの環境変数にも追加してください。`);
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
