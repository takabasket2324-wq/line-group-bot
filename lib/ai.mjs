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

  const response = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system: fullSystemPrompt,
    messages: [
      ...historyMessages,
      { role: "user", content: userMessage },
    ],
  });

  return response.content[0].text;
}
