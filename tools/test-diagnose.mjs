#!/usr/bin/env node
// ============================================================================
//  test-diagnose.mjs — 無料GBP診断のローカルテスト（LINE不要）
//
//  使い方：
//    node tools/test-diagnose.mjs                     # モックのみ（API課金ゼロ）
//    GOOGLE_PLACES_API_KEY=xxx node tools/test-diagnose.mjs "店名"  # 実API 1店
//
//  ⚠️ 実API呼び出しは Places 課金が発生するため、テストは実在店1〜2件まで。
// ============================================================================

import { scoreGbp, MOCK_TONSOKU } from "../lib/gbp.mjs";
import { buildSummary, runDiagnosis } from "../lib/diagnose.mjs";
// ratelimit.mjs は保存先を DIAG_USAGE_FILE で切り替えてから動的 import する（下記）

// --- 1) レートリミット単体テスト（課金ゼロ） ---
// 詳細（日次/月次上限・日付リセット・永続化）は tools/test-ratelimit.mjs で確認する。
// ここでは煙テストのみ。※本番カウント（data/diag-usage.json）を汚さないよう一時ファイルへ。
if (!process.env.DIAG_USAGE_FILE) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.DIAG_USAGE_FILE = join(mkdtempSync(join(tmpdir(), "diag-test-")), "usage.json");
}
const { consumeDiagQuota } = await import("../lib/ratelimit.mjs");
console.log("=== レートリミット（同一ユーザー1日3回） ===");
const results = [1, 2, 3, 4].map(() => consumeDiagQuota("test-user"));
const marks = results.map((r) => (r.ok ? "ok" : r.reason));
console.log(`1〜4回目: ${marks.join(", ")}（期待: ok, ok, ok, user_daily）`);
if (JSON.stringify(marks) !== JSON.stringify(["ok", "ok", "ok", "user_daily"])) {
  console.error("❌ レートリミットが期待どおりではありません");
  process.exit(1);
}
console.log("✅ OK\n");

// --- 2) モックで要約生成（課金ゼロ・決定論） ---
console.log("=== モック（豚足のかどや・実測データ）で要約生成 ===");
const mockScore = scoreGbp(MOCK_TONSOKU.place, MOCK_TONSOKU.manual);
console.log(buildSummary(MOCK_TONSOKU.place, mockScore));
console.log();

// --- 3) 実API（引数で店名指定・キーがあるときだけ） ---
const query = process.argv.slice(2).join(" ").trim();
if (query && process.env.GOOGLE_PLACES_API_KEY) {
  console.log(`=== 実API診断: 「${query}」 ===`);
  const { place, score, summary } = await runDiagnosis(query);
  console.log(`（総合 約${score.total}% ${score.signal} ／ place_id=${place.placeId}）\n`);
  console.log(summary);
} else if (query) {
  console.log("（GOOGLE_PLACES_API_KEY 未設定のため実APIテストはスキップ）");
} else {
  console.log("（店名引数なし＝実APIテストはスキップ。モックのみで確認完了）");
}
