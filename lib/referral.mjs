// ============================================================================
//  referral.mjs — LINE流入元計測（友だち追加時の1問アンケート）
//
//  流れ：
//   follow（友だち追加）→ あいさつに続けてアンケート送信 → 「回答待ち」に登録
//   → 次のメッセージが 1〜6（or キーワード）なら data/referral.json に記録
//   → それ以外のメッセージは一切触らず通常フロー（診断・相談・AI回答）へ
//
//  設計メモ：
//   - userId は SHA-256 ハッシュ（先頭16桁）で匿名化して保存する
//   - 「回答待ち」状態もファイルに永続化（Render無料プランはスピンダウンで
//     プロセスが落ちるため、インメモリだと回答前に状態が消える）
//   - 回答待ちは REFERRAL_TTL_MS（既定72時間）で自動失効
//   - 同一ユーザーが2回答えたら上書き（重複カウントしない）
//   - 集計（/health用）は累計と直近7日（JST基準）
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 保存先（テスト時は REFERRAL_FILE で差し替え可能）
const REFERRAL_FILE =
  process.env.REFERRAL_FILE || join(__dirname, "..", "data", "referral.json");

// 回答待ちの有効期限（既定72時間。追加直後に答えない人も翌日まで拾う）
const REFERRAL_TTL_MS = 72 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 文言（すべてここを直せば変わる・仮文言）
// ---------------------------------------------------------------------------

/** 友だち追加あいさつの直後に送る1問アンケート */
export const REFERRAL_QUESTION = [
  "どこで上田AI工房を知りましたか？（数字でOK）",
  "1. X（Twitter）",
  "2. note",
  "3. 交流会・イベント",
  "4. 知人の紹介",
  "5. お店で見た",
  "6. その他",
].join("\n");

/** 回答へのお礼（軽く返すだけ） */
export const REFERRAL_THANKS = "ありがとうございます！参考にさせていただきます😊";

// 選択肢の定義（集計キー・番号・キーワード）。文言を変えるときはここも合わせる
export const REFERRAL_SOURCES = [
  { key: "X",     num: "1", keywords: /(twitter|ツイッター|エックス)/i, exact: /^[xｘ]$/i },
  { key: "note",  num: "2", keywords: /(note|ノート)/i },
  { key: "交流会", num: "3", keywords: /(交流会|イベント)/ },
  { key: "紹介",  num: "4", keywords: /(紹介|知人|友人|友達)/ },
  { key: "店頭",  num: "5", keywords: /(お店|店で|店頭|店舗)/ },
  { key: "その他", num: "6", keywords: /その他/ },
];

// ---------------------------------------------------------------------------
// 内部：状態の読み書き（ratelimit.mjs と同じアトミック書き込み方式）
// ---------------------------------------------------------------------------

function emptyState() {
  return { awaiting: {}, answers: [] };
}

function loadState() {
  try {
    const s = JSON.parse(readFileSync(REFERRAL_FILE, "utf-8"));
    if (s && typeof s === "object") {
      return {
        awaiting: typeof s.awaiting === "object" && s.awaiting ? s.awaiting : {},
        answers: Array.isArray(s.answers) ? s.answers : [],
      };
    }
  } catch { /* 初回 or 壊れファイル → 新規（安全側） */ }
  return emptyState();
}

function saveState(state) {
  try {
    mkdirSync(dirname(REFERRAL_FILE), { recursive: true });
    const tmp = REFERRAL_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, REFERRAL_FILE); // 書きかけで壊れないようアトミックに
  } catch (err) {
    console.error("[referral] 保存に失敗:", err.message);
  }
}

let state = loadState();

/** userId の匿名化（SHA-256 先頭16桁） */
function anonymize(userId) {
  return createHash("sha256").update(String(userId)).digest("hex").slice(0, 16);
}

// JSTの "YYYY-MM-DD"（ratelimit.mjs と同方式）
function jstDay(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now);
}

// JSTの "YYYY-MM-DD HH:mm"
function jstStamp(now = new Date()) {
  const day = jstDay(now);
  const time = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
  return `${day} ${time}`;
}

// ---------------------------------------------------------------------------
// 回答待ち状態（follow時にセット → 回答 or 72時間で解除）
// ---------------------------------------------------------------------------

/** 友だち追加されたユーザーを「アンケート回答待ち」にする */
export function markAwaitingReferral(userId) {
  state.awaiting[anonymize(userId)] = Date.now();
  saveState(state);
}

/** 回答待ちか（期限切れは自動失効） */
export function isAwaitingReferral(userId) {
  const hash = anonymize(userId);
  const at = state.awaiting[hash];
  if (!at) return false;
  if (Date.now() - at > REFERRAL_TTL_MS) {
    delete state.awaiting[hash];
    saveState(state);
    return false;
  }
  return true;
}

/** 回答待ちを解除する */
export function clearAwaitingReferral(userId) {
  delete state.awaiting[anonymize(userId)];
  saveState(state);
}

// ---------------------------------------------------------------------------
// 回答の解釈・記録・集計
// ---------------------------------------------------------------------------

/**
 * メッセージがアンケート回答かを判定する。
 * @returns {string|null} 該当すれば集計キー（"X"|"note"|"交流会"|"紹介"|"店頭"|"その他"）、
 *  該当しなければ null（→ 呼び出し側は通常フローへ。ここが「無干渉」の要）
 */
export function parseReferralAnswer(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;

  // ① 数字回答（全角対応・「3番」「3です」「3。」も許容）
  const normalized = t
    .replace(/[１-６]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s。．.!！]+$/g, "");
  const m = normalized.match(/^([1-6])(番|で|です)?$/);
  if (m) {
    const src = REFERRAL_SOURCES.find((s) => s.num === m[1]);
    return src ? src.key : null;
  }

  // ② キーワード回答（短文のみ。長文は質問・相談の可能性が高いので通常フローへ）
  if (t.length > 12) return null;
  for (const src of REFERRAL_SOURCES) {
    if (src.exact && src.exact.test(t)) return src.key;
    if (src.keywords.test(t)) return src.key;
  }
  return null;
}

/**
 * 回答を記録する（同一ユーザーの再回答は上書き）。
 * @returns {{ answer: string, updated: boolean }}
 */
export function recordReferralAnswer(userId, answerKey, now = new Date()) {
  const hash = anonymize(userId);
  const entry = { user: hash, answer: answerKey, day: jstDay(now), at: jstStamp(now) };
  const idx = state.answers.findIndex((a) => a.user === hash);
  const updated = idx >= 0;
  if (updated) state.answers[idx] = entry;
  else state.answers.push(entry);
  delete state.awaiting[hash]; // 回答したら待ち解除
  saveState(state);
  return { answer: answerKey, updated };
}

/** /health 用の集計（累計＋直近7日・JST基準。個人情報なし） */
export function getReferralStats(now = new Date()) {
  const cutoff = jstDay(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
  const total = {};
  const last7days = {};
  for (const src of REFERRAL_SOURCES) {
    total[src.key] = 0;
    last7days[src.key] = 0;
  }
  for (const a of state.answers) {
    if (!(a.answer in total)) continue;
    total[a.answer]++;
    if (a.day >= cutoff) last7days[a.answer]++;
  }
  return { answers: state.answers.length, total, last7days };
}
