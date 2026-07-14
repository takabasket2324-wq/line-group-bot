/**
 * Google Sheets 認証・3シートの読み書きヘルパー
 * - システムプロンプト: A1セルから全文読み込み（5分キャッシュ）
 * - ナレッジ: Q&Aペア読み込み（5分キャッシュ）
 * - 会話履歴: 読み書き（毎回リアルタイム）
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { google } from "googleapis";
import dotenv from "dotenv";

const PROJECT_ROOT = join(dirname(import.meta.url.replace("file://", "")), "..");
dotenv.config({ path: join(PROJECT_ROOT, ".env") });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TOKENS_PATH =
  process.env.GOOGLE_TOKENS_PATH || join(PROJECT_ROOT, "credentials", "tokens.json");

// キャッシュ（5分間）
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = {
  systemPrompt: { value: null, fetchedAt: 0 },
  knowledge: { value: null, fetchedAt: 0 },
};

let _sheets;
async function getSheets() {
  if (_sheets) return _sheets;

  if (!SPREADSHEET_ID) {
    throw new Error("SPREADSHEET_ID が .env に設定されていません");
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が .env に設定されていません");
  }

  // 環境変数 GOOGLE_TOKENS_JSON があればそちらを優先、なければファイルから読む
  let tokens;
  if (process.env.GOOGLE_TOKENS_JSON) {
    tokens = JSON.parse(process.env.GOOGLE_TOKENS_JSON);
  } else if (existsSync(TOKENS_PATH)) {
    tokens = JSON.parse(readFileSync(TOKENS_PATH, "utf-8"));
  } else {
    throw new Error(`トークンが見つかりません。GOOGLE_TOKENS_JSON 環境変数を設定するか、${TOKENS_PATH} にファイルを配置してください`);
  }

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials(tokens);
  _sheets = google.sheets({ version: "v4", auth: client });
  return _sheets;
}

/**
 * システムプロンプトを取得（A1セルから全文、5分キャッシュ）
 */
export async function fetchSystemPrompt() {
  const now = Date.now();
  if (cache.systemPrompt.value && now - cache.systemPrompt.fetchedAt < CACHE_TTL_MS) {
    return cache.systemPrompt.value;
  }

  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'システムプロンプト'!A1",
  });

  const prompt = res.data.values?.[0]?.[0] || "";
  cache.systemPrompt = { value: prompt, fetchedAt: now };
  return prompt;
}

/**
 * ナレッジ（Q&Aペア）を取得（5分キャッシュ）
 */
export async function fetchKnowledge() {
  const now = Date.now();
  if (cache.knowledge.value && now - cache.knowledge.fetchedAt < CACHE_TTL_MS) {
    return cache.knowledge.value;
  }

  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'ナレッジ'!A2:C",
  });

  const rows = res.data.values || [];
  const qaPairs = rows
    .filter((row) => row[1] && row[2])
    .map((row) => ({ category: row[0] || "", question: row[1], answer: row[2] }));

  cache.knowledge = { value: qaPairs, fetchedAt: now };
  return qaPairs;
}

// groupId → シート名のマッピングキャッシュ
const groupSheetMap = new Map();

/**
 * グループ専用の会話履歴シートが存在するか確認し、なければ自動作成する
 * シート名はグループLINEの名前を使う
 */
async function ensureHistorySheet(groupId, groupName) {
  const sheetName = groupName || groupId;

  if (groupSheetMap.has(groupId)) return groupSheetMap.get(groupId);

  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets.properties.title",
  });

  const existing = meta.data.sheets.map((s) => s.properties.title);

  // 既にこのグループ用のシートがあるか確認（名前一致）
  if (existing.includes(sheetName)) {
    groupSheetMap.set(groupId, sheetName);
    return sheetName;
  }

  // シートを新規作成してヘッダーを書き込む
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!A1:C1`,
    valueInputOption: "RAW",
    requestBody: { values: [["日時", "発言者", "メッセージ"]] },
  });

  groupSheetMap.set(groupId, sheetName);
  console.log(`[sheets] 新しい会話履歴シートを作成: ${sheetName}`);
  return sheetName;
}

/**
 * 会話履歴を取得（グループ専用シートから直近N件）
 */
export async function fetchHistory(groupId, groupName, limit = 10) {
  const sheetName = await ensureHistorySheet(groupId, groupName);

  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!A2:C`,
  });

  const rows = res.data.values || [];
  const messages = rows.map((row) => ({ role: row[1], content: row[2] }));

  return messages.slice(-limit);
}

/**
 * 会話履歴にメッセージを追記する（グループ専用シート）
 */
export async function appendHistory(groupId, groupName, userId, displayName, message) {
  const sheetName = await ensureHistorySheet(groupId, groupName);

  const sheets = await getSheets();
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!A:C`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[now, displayName, message]],
    },
  });
}

// ---------------------------------------------------------------------------
// 診断リード名簿（無料GBP診断が実行されるたび1行追記）
// ---------------------------------------------------------------------------

const LEADS_SHEET = "診断リード";
const LEADS_HEADER = [
  "日時", "LINE表示名", "userId", "診断した店名",
  "総合最適化度%", "関連性%", "距離%", "知名度%",
  "提示した伸びしろ", "place_id",
];

let _leadsSheetReady = false;

/** 「診断リード」シートが無ければヘッダー付きで自動作成 */
async function ensureLeadsSheet() {
  if (_leadsSheetReady) return LEADS_SHEET;

  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets.properties.title",
  });
  const existing = meta.data.sheets.map((s) => s.properties.title);

  if (!existing.includes(LEADS_SHEET)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: LEADS_SHEET } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${LEADS_SHEET}'!A1:J1`,
      valueInputOption: "RAW",
      requestBody: { values: [LEADS_HEADER] },
    });
    console.log(`[sheets] 診断リードシートを作成: ${LEADS_SHEET}`);
  }

  _leadsSheetReady = true;
  return LEADS_SHEET;
}

/**
 * 診断リードを1行追記する
 * @param {{ displayName, userId, storeName, total, relevancePct, distancePct,
 *           prominencePct, gaps: string[], placeId }} lead
 */
export async function appendDiagnosisLead(lead) {
  await ensureLeadsSheet();

  const sheets = await getSheets();
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${LEADS_SHEET}'!A:J`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        now,
        lead.displayName ?? "",
        lead.userId ?? "",
        lead.storeName ?? "",
        lead.total ?? "",
        lead.relevancePct ?? "",
        lead.distancePct ?? "",
        lead.prominencePct ?? "",
        (lead.gaps || []).join(" ／ "),
        lead.placeId ?? "",
      ]],
    },
  });
}
