// ============================================================================
//  ratelimit.mjs — 診断の簡易レートリミット（1ユーザー1日3回・メモリ内）
//  Places課金・API消費の暴走防止。Render再起動でリセットされるが簡易版として許容。
// ============================================================================

const usage = new Map(); // userId -> { day: "YYYY-MM-DD", count: number }

export const DIAG_DAILY_LIMIT = 3;

/** 実行してよければ true（カウントを消費）。上限超過なら false */
export function consumeDiagQuota(userId, limit = DIAG_DAILY_LIMIT) {
  const day = new Date().toISOString().slice(0, 10);
  const u = usage.get(userId);
  if (!u || u.day !== day) {
    usage.set(userId, { day, count: 1 });
    return true;
  }
  if (u.count >= limit) return false;
  u.count++;
  return true;
}
