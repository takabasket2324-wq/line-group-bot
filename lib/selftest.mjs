// ============================================================================
//  selftest.mjs — 無料GBP診断の見張り（2026-11-11 ハック・会議「売れるシステム」⑥）
//
//  ねらい：診断が止まっていても誰も気づかない、を無くす（過去2回の遅れた気づき）
//   - 10/9〜11/1 Places の課金が切れて 403（診断が全部エラー）
//   - 6/15〜11/9 口コミオバケが廃止されたモデル名のまま（別の仕組みだが同じ型の止まり方）
//
//  やること：本物の道を1本ずつ通して確かめる（お客さんには何も送らない）
//   1. LINEの鍵が生きているか（getBotInfo）
//   2. LINE → このサーバーの受け口が届くか（testWebhookEndpoint）
//   3. LINEの今月の送れる残り（診断結果は push で送るので、尽きると結果が届かない）
//   4. 本物の店で診断（Places 2回・回数の上限には数えない・名簿には書かない）
//   5. 4の結果がLINEで送れる形か（validatePush＝送らずに形だけ確かめる）
//   6. スプレッドシートが読めるか
//   7. Claude（ふつうの質問への返事）が呼べるか（ごく短い1回）
//
//  回数：新しく確かめるのは20時間に1回まで（落ちている間は1時間に1回）。
//        それ以外の呼び出しは、前の結果をそのまま返す＝誰が何回開いても Places は増えない。
//  知らせ：落ちたら管理者（ADMIN_USER_ID）のLINEへ。直ったら「復旧」も送る。
//          LINEそのものが落ちている時は送れないので、外の見張り（/selftest を定期で開く無料サービス）が
//          HTTP 500 を見て上田さんのメールへ知らせる。
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SELFTEST_FILE =
  process.env.SELFTEST_FILE || join(__dirname, "..", "data", "selftest.json");
export const SELFTEST_STORE = process.env.SELFTEST_STORE || "SUSHI KAGUYA 心斎橋";
const OK_INTERVAL_MS = num(process.env.SELFTEST_INTERVAL_HOURS, 20) * 3600e3;
const FAIL_INTERVAL_MS = num(process.env.SELFTEST_FAIL_INTERVAL_MINUTES, 60) * 60e3;
const REALERT_MS = num(process.env.SELFTEST_REALERT_HOURS, 20) * 3600e3;
const STEP_TIMEOUT_MS = num(process.env.SELFTEST_STEP_TIMEOUT_SECONDS, 30) * 1e3;
export const MIN_PUSH_LEFT = num(process.env.SELFTEST_MIN_PUSH_LEFT, 10);

// 知らせの文に出す日本語の名前
export const STEP_LABELS = {
  line_token: "LINEの鍵",
  line_webhook: "LINE→サーバーの受け口",
  line_quota: "LINEの今月の送れる残り",
  diagnose: "Googleマップの読み取り（診断）",
  line_validate: "診断結果をLINEで送れる形か",
  sheets: "スプレッドシート",
  claude: "Claude（ふつうの質問への返事）",
};

function withTimeout(promise, ms, name) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${ms / 1000}秒たっても返事が無い（${name}）`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

// エラーの文を短くする（鍵が混ざらないよう、長い英数字の塊も伏せる）
export function shortError(err) {
  const msg = String(err?.message || err || "不明なエラー").replace(/\s+/g, " ");
  return msg.replace(/[A-Za-z0-9_\-]{32,}/g, "＊＊＊").slice(0, 200);
}

function jstStamp(iso) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

export function buildAlertText(result) {
  const failed = result.steps.filter((s) => !s.ok && !s.skipped);
  const lines = [
    "⚠️ 無料診断の見張り：止まっている所があります",
    `確かめた時刻：${jstStamp(result.checked_at)}`,
    "",
    ...failed.map((s) => `✕ ${STEP_LABELS[s.name] || s.name}\n　${s.error}`),
  ];
  const diag = result.steps.find((s) => s.name === "diagnose");
  if (diag && !diag.ok) lines.push("", "→ 今、LINEの「診断 店名」はエラーになります（面談のデモ前は要注意）");
  lines.push("", "ハックに「見張りが鳴った」と伝えてください。");
  return lines.join("\n");
}

export function buildRecoveredText(result) {
  return [
    "✅ 無料診断の見張り：復旧しました",
    `確かめた時刻：${jstStamp(result.checked_at)}`,
    "全部の道が通りました。",
  ].join("\n");
}

/**
 * 見張りを作る。道具は外から渡す（試験で偽物に差し替えるため）。
 * @param {object} deps
 * @param {object} deps.line   { getBotInfo, testWebhookEndpoint, getMessageQuota, getMessageQuotaConsumption, validatePush }
 * @param {Function} deps.runDiagnosis  (storeName) => {summary, score, place}
 * @param {Function} deps.readSheet     () => string
 * @param {Function} deps.pingClaude    () => any
 * @param {Function} deps.notify        (text) => Promise   管理者へ知らせる
 * @param {Function} [deps.now]         () => Date
 * @param {string}   [deps.file]        結果を残すファイル
 */
export function createSelftest(deps) {
  const now = deps.now || (() => new Date());
  const file = deps.file || SELFTEST_FILE;
  let inflight = null;

  function load() {
    try {
      const s = JSON.parse(readFileSync(file, "utf-8"));
      return s && typeof s.checked_at === "string" ? s : null;
    } catch {
      return null;
    }
  }

  function save(s) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      writeFileSync(tmp, JSON.stringify(s, null, 2), "utf-8");
      renameSync(tmp, file);
    } catch (err) {
      console.error("[selftest] 結果の保存に失敗:", err.message);
    }
  }

  let last = load();

  async function step(name, fn) {
    const t0 = Date.now();
    try {
      const detail = await withTimeout(Promise.resolve().then(fn), STEP_TIMEOUT_MS, name);
      return { name, ok: true, ms: Date.now() - t0, ...(detail ? { detail } : {}) };
    } catch (err) {
      return { name, ok: false, ms: Date.now() - t0, error: shortError(err) };
    }
  }

  async function checkOnce() {
    const steps = [];
    // LINEまわり・スプシ・Claude は互いに関係ないので同時に
    const independent = Promise.all([
      step("line_token", async () => {
        const info = await deps.line.getBotInfo();
        if (!info || !info.userId) throw new Error("ボットの情報が空");
      }),
      step("line_webhook", async () => {
        const r = await deps.line.testWebhookEndpoint({});
        if (!r || r.success !== true) {
          throw new Error(`LINEから受け口に届かない（${r?.statusCode ?? "?"} ${r?.reason ?? ""} ${r?.detail ?? ""}）`.trim());
        }
      }),
      step("line_quota", async () => {
        const [q, used] = await Promise.all([
          deps.line.getMessageQuota(),
          deps.line.getMessageQuotaConsumption(),
        ]);
        if (q?.type !== "limited") return "上限なし";
        const left = (q.value ?? 0) - (used?.totalUsage ?? 0);
        if (left < MIN_PUSH_LEFT) {
          throw new Error(`今月あと${left}通（上限${q.value}）。尽きると診断の結果が届かない`);
        }
        return `今月あと${left}通`;
      }),
      step("sheets", async () => {
        const p = await deps.readSheet();
        if (!p || !String(p).trim()) throw new Error("システムプロンプトが空");
      }),
      step("claude", async () => {
        await deps.pingClaude();
      }),
    ]);

    // 診断 → その結果が送れる形か（順番が要る）
    let summary = null;
    const diag = await step("diagnose", async () => {
      const r = await deps.runDiagnosis(SELFTEST_STORE);
      if (!r || typeof r.summary !== "string" || !r.summary.startsWith("📊")) {
        throw new Error("診断の結果の形がおかしい（📊で始まっていない）");
      }
      if (!Number.isFinite(r.score?.total)) throw new Error("点数が出ていない");
      summary = r.summary;
      return `${r.score.total}%`;
    });
    const validate = summary
      ? await step("line_validate", async () => {
          await deps.line.validatePush({ messages: [{ type: "text", text: summary }] });
        })
      : { name: "line_validate", ok: false, skipped: true, error: "診断が通らなかったので確かめていない" };

    const [lineToken, lineWebhook, lineQuota, sheets, claude] = await independent;
    steps.push(lineToken, lineWebhook, lineQuota, diag, validate, sheets, claude);
    return steps;
  }

  async function fresh() {
    let steps = await checkOnce();
    // 一時的なゆらぎで鳴らさないよう、落ちたら10秒おいて1回だけやり直す
    if (steps.some((s) => !s.ok && !s.skipped)) {
      await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 10e3));
      steps = await checkOnce();
    }
    const result = {
      ok: steps.every((s) => s.ok),
      checked_at: now().toISOString(),
      store: SELFTEST_STORE,
      steps,
      alerted_at: last?.alerted_at || null,
    };

    const prevOk = last ? last.ok : true;
    if (!result.ok) {
      const lastAlert = last?.alerted_at ? new Date(last.alerted_at).getTime() : 0;
      // 新しく落ちた時と、落ちたままなら20時間ごとに知らせる
      if (prevOk || now().getTime() - lastAlert >= REALERT_MS) {
        try {
          await deps.notify(buildAlertText(result));
          result.alerted_at = result.checked_at;
        } catch (err) {
          console.error("[selftest] 管理者への知らせに失敗:", err.message);
          result.notify_error = shortError(err);
        }
      }
    } else {
      result.alerted_at = null;
      if (!prevOk) {
        try {
          await deps.notify(buildRecoveredText(result));
        } catch (err) {
          console.error("[selftest] 復旧の知らせに失敗:", err.message);
        }
      }
    }

    for (const s of steps) {
      if (!s.ok && !s.skipped) console.error(`[selftest] ✕ ${s.name}: ${s.error}`);
    }
    console.log(`[selftest] ${result.ok ? "全部OK" : "落ちている所あり"} (${steps.map((s) => `${s.name}:${s.ok ? "ok" : s.skipped ? "skip" : "NG"}`).join(" ")})`);

    last = result;
    save(result);
    return result;
  }

  /** 期限が来ていれば新しく確かめる。来ていなければ前の結果を返す。 */
  async function run({ force = false } = {}) {
    if (inflight) return inflight;
    if (!force && last) {
      const age = now().getTime() - new Date(last.checked_at).getTime();
      const interval = last.ok ? OK_INTERVAL_MS : FAIL_INTERVAL_MS;
      if (age >= 0 && age < interval) return { ...last, cached: true };
    }
    inflight = fresh().finally(() => { inflight = null; });
    const r = await inflight;
    return { ...r, cached: false };
  }

  return { run, getLast: () => last };
}

/** 外に見せる形（エラーの中身は出さない・名前と可否だけ） */
export function publicView(r) {
  return {
    ok: r.ok,
    checked_at: r.checked_at,
    cached: !!r.cached,
    steps: Object.fromEntries(r.steps.map((s) => [s.name, s.ok ? "ok" : s.skipped ? "skipped" : "NG"])),
  };
}
