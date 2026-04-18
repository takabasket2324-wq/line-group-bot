#!/usr/bin/env node

/**
 * Google OAuth 認証フロー
 * ブラウザで Google 認証を行い、トークンを credentials/tokens.json に保存する
 *
 * Usage: node auth-google.mjs
 */

import { createServer } from "http";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { google } from "googleapis";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });

const CREDENTIALS_DIR = join(__dirname, "credentials");
const TOKENS_PATH = process.env.GOOGLE_TOKENS_PATH || join(CREDENTIALS_DIR, "tokens.json");
const REDIRECT_PORT = 3001;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("Error: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が .env に設定されていません");
    process.exit(1);
  }
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

function saveTokens(tokens) {
  mkdirSync(dirname(TOKENS_PATH), { recursive: true });
  const stored = {
    access_token: tokens.access_token || "",
    refresh_token: tokens.refresh_token || "",
    expiry_date: tokens.expiry_date || 0,
    token_type: tokens.token_type || "Bearer",
    scope: tokens.scope || SCOPES.join(" "),
  };
  writeFileSync(TOKENS_PATH, JSON.stringify(stored, null, 2), "utf-8");
  return stored;
}

function waitForCallback(client) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "", `http://localhost:${REDIRECT_PORT}`);
        if (url.pathname !== "/oauth2callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400);
          res.end(`Authentication failed: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400);
          res.end("No authorization code received");
          server.close();
          reject(new Error("No authorization code received"));
          return;
        }

        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);
        const stored = saveTokens(tokens);

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h1>認証成功</h1><p>このタブを閉じて OK です。</p></body></html>");

        server.close();
        resolve(stored);
      } catch (err) {
        res.writeHead(500);
        res.end("Internal error");
        server.close();
        reject(err);
      }
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`OAuth コールバック待機中: ${REDIRECT_URI}`);
    });

    setTimeout(() => {
      server.close();
      reject(new Error("OAuth 認証がタイムアウトしました（5分）"));
    }, 5 * 60 * 1000);
  });
}

async function main() {
  const client = getOAuthClient();
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("Google OAuth 認証を開始します。");
  console.log(`スコープ: Sheets + Drive`);
  console.log(`トークン保存先: ${TOKENS_PATH}`);
  console.log("");
  console.log(`認証URL:`);
  console.log(authUrl);
  console.log("");

  try {
    const { default: open } = await import("open");
    await open(authUrl);
    console.log("ブラウザを開きました。開けない場合は上記URLを手動で開いてください。");
  } catch {
    console.log("ブラウザ自動起動に失敗しました。上記URLを手動で開いてください。");
  }

  await waitForCallback(client);
  console.log(`認証が完了しました。トークンを保存しました: ${TOKENS_PATH}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
