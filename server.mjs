/**
 * LINE グループチャット Bot サーバー
 * 受講生のメッセージを受信し、Claude API で回答を生成してグループに返信する
 * データ管理はすべてスプレッドシートで行う
 */

import express from "express";
import { messagingApi, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import { join, dirname } from "path";
import { generateReply } from "./lib/ai.mjs";
import { fetchSystemPrompt, fetchKnowledge, fetchHistory, appendHistory } from "./lib/sheets.mjs";

const PROJECT_ROOT = dirname(import.meta.url.replace("file://", ""));
dotenv.config({ path: join(PROJECT_ROOT, ".env") });

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const app = express();

app.get("/", (req, res) => {
  res.json({ status: "ok", bot: "line-group-bot" });
});

app.post("/webhook", middleware(config), async (req, res) => {
  res.status(200).json({ status: "ok" });

  const events = req.body.events || [];
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error("[handleEvent error]", err.message);
    }
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const isGroup = event.source.type === "group";
  const isDirect = event.source.type === "user";
  if (!isGroup && !isDirect) return; // ルーム(複数人トーク)は対象外

  const userId = event.source.userId;
  const text = event.message.text;
  const mention = event.message.mention;

  // スプシの履歴シートを分ける単位: グループなら groupId、個別チャットなら userId
  const threadId = isGroup ? event.source.groupId : userId;

  console.log(`[message] ${isGroup ? "group" : "direct"}=${threadId} user=${userId} text="${text.slice(0, 50)}"`);

  if (userId === process.env.ADMIN_USER_ID) {
    console.log("[skip] 管理者のメッセージ");
    return;
  }

  if (isGroup && mention && mention.mentionees) {
    const mentionedAdmin = mention.mentionees.some(
      (m) => m.userId === process.env.ADMIN_USER_ID
    );
    if (mentionedAdmin) {
      console.log("[skip] 管理者宛のメンション");
      return;
    }
  }

  // 「応答生成中...」をすぐに返す
  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: "応答生成中..." }],
  });

  // スレッド名（履歴シート名）とユーザー名を取得
  let threadName, displayName;
  if (isGroup) {
    const [groupSummary, memberProfile] = await Promise.all([
      client.getGroupSummary(threadId).catch(() => null),
      client.getGroupMemberProfile(threadId, userId).catch(() => null),
    ]);
    threadName = groupSummary?.groupName || threadId;
    displayName = memberProfile?.displayName || userId;
  } else {
    const profile = await client.getProfile(userId).catch(() => null);
    displayName = profile?.displayName || userId;
    threadName = `個別-${displayName}`;
  }

  // お客さまのメッセージをスプシに記録
  await appendHistory(threadId, threadName, userId, displayName, text);

  // スプシから3つのデータを並列取得
  const [systemPrompt, knowledge, history] = await Promise.all([
    fetchSystemPrompt(),
    fetchKnowledge(),
    fetchHistory(threadId, threadName, 10),
  ]);

  // Claude API で回答生成
  const reply = await generateReply(text, systemPrompt, knowledge, history);

  // Bot の回答をスプシに記録
  await appendHistory(threadId, threadName, "Bot", "Bot", reply);

  // 本回答を push message で送信（グループでも個別チャットでも to は groupId/userId でOK）
  await client.pushMessage({
    to: threadId,
    messages: [{ type: "text", text: reply }],
  });

  console.log(`[reply] ${reply.slice(0, 80)}...`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`line-group-bot running on port ${PORT}`);
  console.log(`SPREADSHEET_ID: ${process.env.SPREADSHEET_ID || "(未設定)"}`);
  console.log(`ADMIN_USER_ID: ${process.env.ADMIN_USER_ID || "(未設定 — 全メッセージに反応します)"}`);
});
