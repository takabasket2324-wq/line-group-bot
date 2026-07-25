#!/usr/bin/env node
// ============================================================================
//  test-ratelimit.mjs — 診断レートリミットの動作確認（API課金ゼロ・オフライン）
//
//  使い方： node tools/test-ratelimit.mjs
//
//  確認すること：
//   1. 同一ユーザーが1日の上限に達すると user_daily で拒否される
//   2. 全体の日次上限に達すると global_daily で拒否される
//   3. 日付が変わると日次カウントがリセットされる（月次は引き継ぐ）
//   4. 月次上限に達すると global_monthly で拒否される／月が変わるとリセット
//   5. カウントがJSONに永続化され、プロセス再起動後も引き継がれる
//  ※ 本物の data/diag-usage.json は触らない（一時ファイルに隔離）
// ============================================================================

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "diag-ratelimit-test-"));
const usageFile = join(dir, "diag-usage.json");

// テスト用に小さい上限で動かす（本番既定は 3 / 30 / 300）
const env = {
  ...process.env,
  DIAG_USAGE_FILE: usageFile,
  DIAG_USER_DAILY_LIMIT: "3",
  DIAG_GLOBAL_DAILY_LIMIT: "5",
  DIAG_GLOBAL_MONTHLY_LIMIT: "7",
};

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

// 別プロセスで実行＝「再起動しても引き継がれるか」も同時に検証できる
function run(script) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env, cwd: join(import.meta.dirname, ".."), encoding: "utf-8",
  });
  return JSON.parse(out.trim().split("\n").pop());
}

const LIB = "./lib/ratelimit.mjs";

// ---------------------------------------------------------------------------
console.log("■ 1. 同一ユーザー1日3回 → 4回目は user_daily で拒否");
let r = run(`
  import { consumeDiagQuota } from "${LIB}";
  const rs = [1,2,3,4].map(() => consumeDiagQuota("userA"));
  console.log(JSON.stringify(rs));
`);
check("1〜3回目は許可", r[0].ok && r[1].ok && r[2].ok);
check("4回目は user_daily で拒否", !r[3].ok && r[3].reason === "user_daily");

console.log("■ 2. 別ユーザーで全体の日次上限(5)へ → global_daily で拒否");
r = run(`
  import { consumeDiagQuota } from "${LIB}";
  const rs = [
    consumeDiagQuota("userB"), // 4件目
    consumeDiagQuota("userB"), // 5件目（日次上限ちょうど）
    consumeDiagQuota("userC"), // 6件目 → 全体日次オーバー
  ];
  console.log(JSON.stringify(rs));
`);
check("日次上限までは許可（再起動をまたいでカウント継続）", r[0].ok && r[1].ok);
check("上限超は global_daily で拒否（別ユーザーでも）", !r[2].ok && r[2].reason === "global_daily");

console.log("■ 3. 日付が変わると日次リセット・月次は継続");
r = run(`
  import { consumeDiagQuota, getDiagUsage } from "${LIB}";
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const a = consumeDiagQuota("userA", { now: tomorrow }); // 昨日3回使ったユーザーも復活
  const u = getDiagUsage({ now: tomorrow });
  console.log(JSON.stringify({ a, u }));
`);
check("翌日は同一ユーザーも再び許可", r.a.ok);
check("日次カウントがリセット(今日=1)", r.u.today === 1);
check("月次カウントは継続(6件)", r.u.this_month === 6);

console.log("■ 4. 月次上限(7) → global_monthly で拒否／月が変わるとリセット");
r = run(`
  import { consumeDiagQuota } from "${LIB}";
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const nextMonth = new Date(Date.now() + 40 * 24 * 3600 * 1000);
  const a = consumeDiagQuota("userD", { now: tomorrow }); // 7件目（月次上限ちょうど）
  const b = consumeDiagQuota("userE", { now: tomorrow }); // 8件目 → 月次オーバー
  const c = consumeDiagQuota("userE", { now: nextMonth }); // 翌月 → リセット
  console.log(JSON.stringify({ a, b, c }));
`);
check("月次上限までは許可", r.a.ok);
check("上限超は global_monthly で拒否", !r.b.ok && r.b.reason === "global_monthly");
check("月が変わるとリセットされ許可", r.c.ok);

console.log("■ 5. 永続化ファイル");
check("JSONファイルが作られている", existsSync(usageFile));
const saved = JSON.parse(readFileSync(usageFile, "utf-8"));
check("userIdごとの回数が保存されている", typeof saved.users === "object" && saved.dayTotal >= 1);

// 後片付け
rmSync(dir, { recursive: true, force: true });

console.log(`\n結果：${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
