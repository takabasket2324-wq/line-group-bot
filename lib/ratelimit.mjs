// ============================================================================
//  ratelimit.mjs — 無料GBP診断のレートリミット（Places課金の暴走防止・v2）
//
//  3段構えの安全弁（すべて環境変数で変更可）：
//   1. 同一ユーザー   … 1日 DIAG_USER_DAILY_LIMIT 回まで（既定3）
//   2. 全体の日次上限 … 全ユーザー合計 1日 DIAG_GLOBAL_DAILY_LIMIT 回まで（既定30）
//   3. 全体の月次上限 … 全ユーザー合計 月 DIAG_GLOBAL_MONTHLY_LIMIT 回まで（既定300）
//
//  カウントは data/diag-usage.json に永続化（プロセス再起動で消えない）。
//  日付・月はJST（Asia/Tokyo）基準。日付が変わると日次、月が変わると月次がリセット。
//
//  ⚠️ Render無料プランはディスクがエフェメラル＝再デプロイ/インスタンス入替でファイルは消える。
//     それでも「消えたら0から数え直す」だけで安全側（上限が緩む方向にはズレるが、
//     日次30・月次300の天井があるため課金の暴走は起きない）。
//     完全な永続化が必要になったらスプシ（診断リードと同じSheets）方式に強化する。
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const DIAG_USER_DAILY_LIMIT = num(process.env.DIAG_USER_DAILY_LIMIT, 3);
export const DIAG_GLOBAL_DAILY_LIMIT = num(process.env.DIAG_GLOBAL_DAILY_LIMIT, 30);
export const DIAG_GLOBAL_MONTHLY_LIMIT = num(process.env.DIAG_GLOBAL_MONTHLY_LIMIT, 300);

// 旧コードとの互換（server.mjs の案内文などで参照）
export const DIAG_DAILY_LIMIT = DIAG_USER_DAILY_LIMIT;

// 保存先（テスト時は DIAG_USAGE_FILE で差し替え可能）
const USAGE_FILE =
  process.env.DIAG_USAGE_FILE || join(__dirname, "..", "data", "diag-usage.json");

// JSTの "YYYY-MM-DD"（sv-SE ロケールは ISO 形式で出るのを利用）
function jstDay(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now);
}

// ---------------------------------------------------------------------------
// 状態の読み書き（壊れていたら安全側＝0から数え直す）
// ---------------------------------------------------------------------------

function emptyState(day) {
  return { day, month: day.slice(0, 7), dayTotal: 0, monthTotal: 0, users: {} };
}

function loadState() {
  try {
    const s = JSON.parse(readFileSync(USAGE_FILE, "utf-8"));
    if (typeof s?.day === "string" && typeof s?.users === "object") {
      return {
        day: s.day,
        month: typeof s.month === "string" ? s.month : s.day.slice(0, 7),
        dayTotal: num(s.dayTotal, 0) ?? 0,
        monthTotal: num(s.monthTotal, 0) ?? 0,
        users: s.users || {},
      };
    }
  } catch { /* 初回 or 壊れファイル → 新規 */ }
  return emptyState(jstDay());
}

function saveState(state) {
  try {
    mkdirSync(dirname(USAGE_FILE), { recursive: true });
    const tmp = USAGE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, USAGE_FILE); // 書きかけファイルで壊れないようアトミックに
  } catch (err) {
    // 保存に失敗しても診断自体は止めない（メモリ上のカウントは生きている）
    console.error("[ratelimit] 使用回数の保存に失敗:", err.message);
  }
}

let state = loadState();

// 日付・月が変わっていたらリセット
function rollover(now = new Date()) {
  const day = jstDay(now);
  if (day === state.day) return;
  const month = day.slice(0, 7);
  const monthTotal = month === state.month ? state.monthTotal : 0;
  state = { ...emptyState(day), month, monthTotal };
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * 診断1回ぶんのクォータを消費する。
 * @returns {{ ok: true } | { ok: false, reason: "global_monthly"|"global_daily"|"user_daily" }}
 *  ok:false のときは呼び出し側で reason に応じた案内を返す（Places APIは呼ばない）。
 * @param {object} [opts]
 * @param {Date}   [opts.now] テスト用の現在時刻（日付変更のシミュレーションに使う）
 */
export function consumeDiagQuota(userId, opts = {}) {
  rollover(opts.now);

  // 上限チェック（月次 → 日次 → ユーザーの順。案内文の「明日/来月」を正しく出し分けるため）
  if (state.monthTotal >= DIAG_GLOBAL_MONTHLY_LIMIT) return { ok: false, reason: "global_monthly" };
  if (state.dayTotal >= DIAG_GLOBAL_DAILY_LIMIT) return { ok: false, reason: "global_daily" };
  if ((state.users[userId] || 0) >= DIAG_USER_DAILY_LIMIT) return { ok: false, reason: "user_daily" };

  state.users[userId] = (state.users[userId] || 0) + 1;
  state.dayTotal++;
  state.monthTotal++;
  saveState(state);
  return { ok: true };
}

/** /health 用の現在値（userIdは出さない・件数のみ） */
export function getDiagUsage(opts = {}) {
  rollover(opts.now);
  return {
    day: state.day,
    today: state.dayTotal,
    daily_limit: DIAG_GLOBAL_DAILY_LIMIT,
    month: state.month,
    this_month: state.monthTotal,
    monthly_limit: DIAG_GLOBAL_MONTHLY_LIMIT,
    user_daily_limit: DIAG_USER_DAILY_LIMIT,
  };
}
