// ============================================================================
//  test-referral.mjs — 流入元計測のローカルテスト（LINE API不要・課金ゼロ）
//
//  1) 回答の解釈（数字・全角・キーワード・非回答の弁別）
//  2) 回答待ち状態（mark/is/clear ＋ 72時間失効 ＋ ファイル永続化）
//  3) 記録と集計（匿名化・再回答の上書き・累計/直近7日）
//  4) 通常フロー無干渉（診断・相談・雑談は回答と誤認しないこと）
//
//  実行: node tools/test-referral.mjs
//  ※データは一時ファイル（data/referral.test.json）に書き、最後に削除する
// ============================================================================

import { unlinkSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_FILE = join(__dirname, "..", "data", "referral.test.json");
process.env.REFERRAL_FILE = TEST_FILE;
if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);

// env設定後に読み込む（保存先を差し替えるため動的import）
const {
  REFERRAL_QUESTION, REFERRAL_THANKS,
  markAwaitingReferral, isAwaitingReferral, clearAwaitingReferral,
  parseReferralAnswer, recordReferralAnswer, getReferralStats,
} = await import("../lib/referral.mjs");

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failed++;
};

// --- 1) 回答の解釈 -----------------------------------------------------------
console.log("=== 1) 回答の解釈 ===");
check("「1」→ X", parseReferralAnswer("1") === "X");
check("「2」→ note", parseReferralAnswer("2") === "note");
check("「3」→ 交流会", parseReferralAnswer("3") === "交流会");
check("「４」（全角）→ 紹介", parseReferralAnswer("４") === "紹介");
check("「5。」（句点つき）→ 店頭", parseReferralAnswer("5。") === "店頭");
check("「6です」→ その他", parseReferralAnswer("6です") === "その他");
check("「3番」→ 交流会", parseReferralAnswer("3番") === "交流会");
check("「X」→ X", parseReferralAnswer("X") === "X");
check("「Twitterで見ました」→ X", parseReferralAnswer("Twitterで見ました") === "X");
check("「noteです」→ note", parseReferralAnswer("noteです") === "note");
check("「交流会で」→ 交流会", parseReferralAnswer("交流会で") === "交流会");
check("「知人の紹介」→ 紹介", parseReferralAnswer("知人の紹介") === "紹介");
check("「お店で見た」→ 店頭", parseReferralAnswer("お店で見た") === "店頭");
check("「その他」→ その他", parseReferralAnswer("その他") === "その他");

// --- 4) 通常フロー無干渉（回答と誤認しないこと） ------------------------------
console.log("\n=== 4) 非回答の弁別（通常フロー無干渉） ===");
check("「こんにちは」は回答扱いしない", parseReferralAnswer("こんにちは") === null);
check("「診断 ○○食堂 難波」は回答扱いしない", parseReferralAnswer("診断 ○○食堂 難波") === null);
check("「相談したい」は回答扱いしない", parseReferralAnswer("相談したい") === null);
check("「7」（範囲外）は回答扱いしない", parseReferralAnswer("7") === null);
check("「0」は回答扱いしない", parseReferralAnswer("0") === null);
check("長文にXを含んでも回答扱いしない",
  parseReferralAnswer("Xの運用も自動化できたりしますか？教えてください") === null);
check("長文にnoteを含んでも回答扱いしない",
  parseReferralAnswer("noteの記事を読んで質問があるのですが料金はいくらですか") === null);
check("空文字は回答扱いしない", parseReferralAnswer("") === null);

// --- 2) 回答待ち状態 ---------------------------------------------------------
console.log("\n=== 2) 回答待ち状態（followシミュレート） ===");
const U1 = "TEST_USER_FOLLOW_1";
check("初期状態は待ちではない", isAwaitingReferral(U1) === false);
markAwaitingReferral(U1); // ← follow イベント相当
check("follow後は回答待ちになる", isAwaitingReferral(U1) === true);

// ファイル永続化（Render再起動・スピンダウン対策）の確認
const saved = JSON.parse(readFileSync(TEST_FILE, "utf-8"));
check("待ち状態がファイルに永続化される", Object.keys(saved.awaiting).length === 1);
check("ファイル内のuserIdは匿名化（生IDが無い）",
  !JSON.stringify(saved).includes(U1));

// 72時間失効
const realNow = Date.now;
Date.now = () => realNow() + 73 * 60 * 60 * 1000; // 73時間後
check("72時間経過で自動失効", isAwaitingReferral(U1) === false);
Date.now = realNow;

markAwaitingReferral(U1);
clearAwaitingReferral(U1);
check("clearで解除される", isAwaitingReferral(U1) === false);

// --- 3) 記録と集計 -----------------------------------------------------------
console.log("\n=== 3) 記録と集計 ===");
markAwaitingReferral(U1);
const r1 = recordReferralAnswer(U1, "交流会"); // 「3」を受領した想定
check("初回回答は新規記録（updated=false）", r1.updated === false);
check("回答すると待ち解除される", isAwaitingReferral(U1) === false);

const r2 = recordReferralAnswer(U1, "X"); // 同一ユーザーの答え直し
check("再回答は上書き（updated=true・二重カウントなし）", r2.updated === true);

const U2 = "TEST_USER_FOLLOW_2";
recordReferralAnswer(U2, "交流会");
// 8日前の古い回答（直近7日から外れることの確認）
recordReferralAnswer("TEST_USER_OLD", "note", new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));

const stats = getReferralStats();
console.log("集計:", JSON.stringify(stats));
check("回答者数=3（上書きは増えない）", stats.answers === 3);
check("累計: 交流会=1・X=1・note=1",
  stats.total["交流会"] === 1 && stats.total.X === 1 && stats.total.note === 1);
check("直近7日: 交流会=1・X=1", stats.last7days["交流会"] === 1 && stats.last7days.X === 1);
check("直近7日: 8日前のnoteは含まれない", stats.last7days.note === 0);
check("全選択肢のキーが0埋めで出る", stats.total["店頭"] === 0 && stats.total["その他"] === 0);

// 保存ファイルにも生IDが無いこと（匿名化の最終確認）
const finalFile = readFileSync(TEST_FILE, "utf-8");
check("記録ファイルに生userIdが1件も無い",
  !finalFile.includes(U1) && !finalFile.includes(U2) && !finalFile.includes("TEST_USER_OLD"));

console.log("\n（参考）友だち追加時に届くアンケート文:\n" + REFERRAL_QUESTION);
console.log("\n（参考）回答へのお礼文:\n" + REFERRAL_THANKS);

unlinkSync(TEST_FILE); // 後始末
console.log(`\n${failed === 0 ? "🎉 全テスト成功" : `⚠️ ${failed}件失敗`}`);
process.exit(failed === 0 ? 0 : 1);
