// ============================================================================
//  test-consult.mjs — 相談ハンドオフのローカルテスト（LINE API不要）
//
//  1) 連絡先待ち状態（mark/is/clear ＋ 24時間失効）
//  2) 社長通知文の生成（診断履歴あり／なし）
//  3) スプシ「診断リード」への実書き込み
//     - 診断未経験ユーザー → 新規行が作られる
//     - 同じユーザーの2回目 → その行のK〜M列が更新される
//
//  実行: node tools/test-consult.mjs
//  ※LINEへのpushは行わない（通知文はコンソールに出すだけ）
// ============================================================================

import {
  markAwaitingContact, isAwaitingContact, clearAwaitingContact,
  CONSULT_ASK_CONTACT, CONSULT_THANKS, buildAdminNotify,
} from "../lib/consult.mjs";
import { recordConsultContact } from "../lib/sheets.mjs";

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failed++;
};

// --- 1) 連絡先待ち状態 -------------------------------------------------------
console.log("=== 1) 連絡先待ち状態（インメモリ） ===");
const U = "TEST_USER_STATE";
check("初期状態は待ちではない", isAwaitingContact(U) === false);
markAwaitingContact(U);
check("markで待ちになる", isAwaitingContact(U) === true);
clearAwaitingContact(U);
check("clearで解除される", isAwaitingContact(U) === false);

// 24時間失効（Date.nowを一時的に進めて確認）
markAwaitingContact(U);
const realNow = Date.now;
Date.now = () => realNow() + 25 * 60 * 60 * 1000; // 25時間後
check("24時間経過で自動失効", isAwaitingContact(U) === false);
Date.now = realNow;

// --- 2) 通知文の生成 ---------------------------------------------------------
console.log("\n=== 2) 社長への通知文 ===");
const withStore = buildAdminNotify({
  displayName: "山田さん", storeName: "○○食堂", total: "63",
  contactText: "山田太郎 090-0000-0000",
});
console.log(withStore);
check("店名と総合%が入る", withStore.includes("○○食堂（総合63%）"));
check("連絡先が入る", withStore.includes("090-0000-0000"));

const noStore = buildAdminNotify({
  displayName: "佐藤さん", storeName: "", total: "",
  contactText: "メールで: sato@example.com",
});
check("診断未経験は『診断履歴なし』", noStore.includes("診断履歴なし"));

console.log("\n（参考）連絡先のお願い文:\n" + CONSULT_ASK_CONTACT);
console.log("\n（参考）受領のお礼文:\n" + CONSULT_THANKS);

// --- 3) スプシ実書き込み -----------------------------------------------------
console.log("\n=== 3) 診断リードへの実書き込み ===");
const TEST_UID = "TEST_CONSULT_T59";
const TEST_NAME = "【テスト行】ハック相談ハンドオフ確認（削除OK）";

// 3-1 診断未経験ユーザー → 新規行
const r1 = await recordConsultContact({
  userId: TEST_UID, displayName: TEST_NAME,
  contactText: "テスト連絡先1回目 000-0000-0000",
});
check("1回目：新規行が作られる（existing=false）", r1.existing === false);

// 3-2 同じユーザーの2回目 → 既存行のK〜M更新
const r2 = await recordConsultContact({
  userId: TEST_UID, displayName: TEST_NAME,
  contactText: "テスト連絡先2回目（上書き確認） 111-1111-1111",
});
check("2回目：既存行が更新される（existing=true）", r2.existing === true);

console.log(`\n${failed === 0 ? "🎉 全テスト成功" : `⚠️ ${failed}件失敗`}`);
console.log(`※スプシ「診断リード」に ${TEST_NAME} の行が残っています。確認後、削除OKです。`);
process.exit(failed === 0 ? 0 : 1);
