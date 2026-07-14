// ============================================================================
//  consult.mjs — 相談ハンドオフ（診断→「相談したい」→連絡先→社長へ引き継ぎ）
//
//  背景：LINE公式の管理画面チャットは使えない（チャットモードにすると自動応答が
//  止まる）ため、社長への引き継ぎは「連絡先を聞く → 社長にpush通知 →
//  社長がLINE外（電話等）で連絡」の流れで行う。
//
//  状態管理はインメモリ（Render再起動でリセット＝簡易版として許容）。
//  「連絡先待ち」は24時間で自動失効する。
// ============================================================================

const AWAITING_TTL_MS = 24 * 60 * 60 * 1000; // 24時間で失効

const awaiting = new Map(); // userId -> markedAt (ms)

/** ユーザーを「連絡先待ち」にする */
export function markAwaitingContact(userId) {
  awaiting.set(userId, Date.now());
}

/** 「連絡先待ち」状態か（24時間経過分は自動失効） */
export function isAwaitingContact(userId) {
  const at = awaiting.get(userId);
  if (!at) return false;
  if (Date.now() - at > AWAITING_TTL_MS) {
    awaiting.delete(userId);
    return false;
  }
  return true;
}

/** 「連絡先待ち」を解除する */
export function clearAwaitingContact(userId) {
  awaiting.delete(userId);
}

// ---------------------------------------------------------------------------
// 文面（すべて決定論・Claude API不使用）
// ---------------------------------------------------------------------------

/** 「相談」トリガーへの返信＝連絡先のお願い */
export const CONSULT_ASK_CONTACT = [
  "ありがとうございます！担当の上田からご連絡します📞",
  "",
  "お名前と、お電話番号（またはご希望の連絡方法）を",
  "このトークに送ってください。",
].join("\n");

/** 連絡先を受け取ったあとの返信 */
export const CONSULT_THANKS = [
  "受け取りました！",
  "担当の上田より2営業日以内にご連絡します。",
  "ありがとうございます😊",
].join("\n");

/** 社長（ADMIN_USER_ID）へのpush通知文 */
export function buildAdminNotify({ displayName, storeName, total, contactText }) {
  const store = storeName
    ? `${storeName}（総合${total}%）`
    : "診断履歴なし（相談のみ）";
  return [
    "🔥相談希望が届きました",
    `・お名前（LINE表示名）：${displayName}`,
    `・診断した店：${store}`,
    `・連絡先：${contactText}`,
    "・履歴：スプレッドシート「診断リード」シート",
  ].join("\n");
}
