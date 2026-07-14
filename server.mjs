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
import { fetchSystemPrompt, fetchKnowledge, fetchHistory, appendHistory, appendDiagnosisLead } from "./lib/sheets.mjs";
import { runDiagnosis } from "./lib/diagnose.mjs";
import { consumeDiagQuota, DIAG_DAILY_LIMIT } from "./lib/ratelimit.mjs";

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

// Render無料プランのコールドスタート対策用（GitHub Actions cron が定期ping）
app.get("/health", (req, res) => {
  res.json({ status: "ok", bot: "line-group-bot", diag: true,
    places_key: !!process.env.GOOGLE_PLACES_API_KEY });
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

// ---------------------------------------------------------------------------
// 無料GBP診断（1:1トーク用）
// ---------------------------------------------------------------------------

// 友だち追加時のあいさつ（無料GBP診断への誘導）
const FOLLOW_GREETING = [
  "友だち追加ありがとうございます！",
  "上田AI工房です⚙️",
  "",
  "🎁 ただいま「Googleビジネスプロフィール無料診断」を実施中です。",
  "お店がGoogleマップ・Google検索でどれだけ力を発揮できているか、29項目でチェックして結果をお返しします。",
  "",
  "使い方はかんたん。",
  "お店の名前を「診断 ○○店」のように送ってください。",
  "エリア名も添えると見つかりやすいです（例：診断 ○○食堂 難波）",
  "",
  "※本診断は最適化度の点検で、検索順位を保証するものではありません。",
].join("\n");

// 「診断」だけ送られたときの案内
const DIAG_GUIDE = [
  "無料GBP診断ですね！",
  "お店の名前を「診断 ○○店」の形で送ってください。",
  "エリア名も添えると見つかりやすいです（例：診断 ○○食堂 難波）",
].join("\n");

async function handleFollow(event) {
  console.log(`[follow] user=${event.source.userId}`);
  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: FOLLOW_GREETING }],
  });
}

// 「診断 ○○店」→ Places取得＋29項目採点→要約を返信
async function handleDiagnose(event, userId, text) {
  const storeName = text.trim().replace(/^診断/, "").trim();

  // 店名なし＝使い方の案内だけ（レート消費しない）
  if (!storeName) {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: DIAG_GUIDE }],
    });
    return;
  }

  // 簡易レートリミット（1ユーザー1日3回・Places課金/API消費の暴走防止）
  if (!consumeDiagQuota(userId)) {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text:
        `無料診断は1日${DIAG_DAILY_LIMIT}回までとさせていただいています🙏\n` +
        "明日また試していただくか、詳しい診断をご希望でしたらこのままご返信ください。" }],
    });
    return;
  }

  // すぐに受付返信（診断はPlaces API 2コールで数秒かかる）
  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: `「${storeName}」を診断中です…🔎\n少々お待ちください（30秒ほど）` }],
  });

  let resultText;
  let diagResult = null; // 成功時のみ入る（リード名簿用）
  try {
    diagResult = await runDiagnosis(storeName);
    resultText = diagResult.summary;
  } catch (err) {
    console.error("[diagnose error]", err.message);
    resultText = err.message.includes("見つかりませんでした")
      ? `「${storeName}」が見つかりませんでした🙏\nエリア名を添えて、もう一度送ってみてください（例：診断 ${storeName} 難波）`
      : "診断中にエラーが発生しました🙏 時間をおいてもう一度お試しください。";
  }

  await client.pushMessage({ to: userId, messages: [{ type: "text", text: resultText }] });
  console.log(`[diagnose reply] user=${userId} store="${storeName}"`);

  // リード記録としてスプシにも残す（失敗しても診断は成功扱い）
  const profile = await client.getProfile(userId).catch(() => null);
  const displayName = profile?.displayName || userId;
  try {
    await appendHistory(userId, `個別-${displayName}`, userId, displayName, `診断 ${storeName}`);
    await appendHistory(userId, `個別-${displayName}`, "Bot", "Bot", resultText);
  } catch (err) {
    console.error("[diagnose history error]", err.message);
  }

  // 診断リード名簿へ1行追記（診断成功時のみ。失敗しても診断は成功扱い）
  if (diagResult) {
    try {
      const { place, score, gaps } = diagResult;
      const pct = (axis) => Math.round((score.axes[axis]?.ratio ?? 0) * 100);
      await appendDiagnosisLead({
        displayName,
        userId,
        storeName,
        total: score.total,
        relevancePct: pct("relevance"),
        distancePct: pct("distance"),
        prominencePct: pct("prominence"),
        gaps,
        placeId: place.placeId,
      });
      console.log(`[diagnose lead] user=${userId} store="${storeName}" total=${score.total}%`);
    } catch (err) {
      console.error("[diagnose lead error]", err.message);
    }
  }
}

async function handleEvent(event) {
  // 友だち追加あいさつ
  if (event.type === "follow") return handleFollow(event);

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

  // 無料GBP診断（1:1トークのみ）。管理者スキップより前＝社長自身も実機テストできる
  if (isDirect && /^診断/.test(text.trim())) {
    return handleDiagnose(event, userId, text);
  }

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
  console.log(`GOOGLE_PLACES_API_KEY: ${process.env.GOOGLE_PLACES_API_KEY ? "設定済み（無料GBP診断 有効）" : "(未設定 — 無料GBP診断は動きません)"}`);
});
