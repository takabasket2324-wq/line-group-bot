/**
 * Claude API で受講生のメッセージに対する回答を生成する
 * システムプロンプトはスプシから取得したものを受け取る
 */

import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { join, dirname } from "path";

const PROJECT_ROOT = join(dirname(import.meta.url.replace("file://", "")), "..");
dotenv.config({ path: join(PROJECT_ROOT, ".env") });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * 受講生のメッセージに対する回答を生成する
 * @param {string} userMessage - 受講生のメッセージ
 * @param {string} systemPrompt - スプシから取得したシステムプロンプト
 * @param {Array} knowledge - スプシから取得したQ&Aペア
 * @param {Array} recentMessages - 直近の会話履歴
 */
export async function generateReply(userMessage, systemPrompt, knowledge = [], recentMessages = []) {
  const knowledgeContext = knowledge.length > 0
    ? `\n\n## 参考: ナレッジベース\n${knowledge.slice(-30).map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n---\n")}`
    : "";

  const fullSystemPrompt = systemPrompt + knowledgeContext;

  // 会話履歴を messages 配列に変換（末尾の現在メッセージを除く）
  const historyMessages = [];
  const history = recentMessages.slice(0, -1);
  for (const msg of history) {
    const role = msg.role === "Bot" ? "assistant" : "user";
    if (historyMessages.length > 0 && historyMessages[historyMessages.length - 1].role === role) {
      // 同じロールが続く場合は結合
      historyMessages[historyMessages.length - 1].content += "\n" + msg.content;
    } else {
      historyMessages.push({ role, content: msg.content });
    }
  }

  const response = await anthropic.messages.create(
    {
      // 2026-11-09 claude-opus-4-8 → claude-opus-5-5 に変更（会議「APIクレジットの使い道」案1）
      model: "claude-opus-5-5",
      // Opus 5.5 は考えてから答える。考えた分も max_tokens に数えるので、返事が途中で切れないよう広めに取る
      max_tokens: 8000,
      // LINEの返事なので、考える量は少なめ（Opus 5.5 の初期値は medium。上げたい時はここを "medium" に）
      output_config: { effort: "low" },
      // 断られた時に、別のモデルで自動でやり直す（公式の server-side fallback）
      fallbacks: "default",
      system: fullSystemPrompt,
      messages: [
        ...historyMessages,
        { role: "user", content: userMessage },
      ],
    },
    { headers: { "anthropic-beta": "server-side-fallback-2026-07-01" } },
  );

  // 安全のための判定で断られた時（stop_reason が refusal・本文は空のことがある）
  if (response.stop_reason === "refusal") {
    return "すみません、このご質問にはここではお答えできませんでした。お手数ですが、言い方を変えてもう一度送ってください。";
  }

  // 返事の先頭に「考えた跡」の塊（thinking）が来ることがあるので、文の塊（text）だけをつなぐ
  const text = (response.content || [])
    .filter((b) => b && b.type === "text")
    .map((b) => b.text || "")
    .join("")
    .trim();
  return text || "すみません、うまく返事を作れませんでした。もう一度送ってください。";
}
