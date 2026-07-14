// ============================================================================
//  diagnose.mjs — LINE用 無料GBP診断（店名 → Places取得 → 29項目採点 → 要約文）
//
//  ⚠️ オンブランド厳守（gbp.mjs と同じ大原則）：
//   - 検索順位は保証しない（文言にも必ず免責を入れる）
//   - 取れない項目は捏造しない（△要確認のまま）
//   - 口コミオバケ👻＝代筆・自演・自動返信ではない（そういう表現を使わない）
//   - APIキーは環境変数 GOOGLE_PLACES_API_KEY から読む（コードに書かない）
//
//  返信はLINEの1通に収まる短い要約（総合%＋良い点1つ＋伸びしろ2つ＋無料相談CTA）。
//  Claude APIは使わない決定論生成＝診断1回あたりの課金はPlaces 2コールのみ。
// ============================================================================

import { searchPlaceId, fetchPlaceDetails, scoreGbp } from "./gbp.mjs";

const AXIS_JA = { relevance: "関連性", distance: "距離", prominence: "知名度" };

// 「伸びしろ」として案内する優先順位（×項目から選ぶ。営業導線に近いものを上位に）
const GAP_PRIORITY = [
  "P24", // 自社HP/LPがない → 入口商品に直結
  "R6",  // Webサイト欄が空
  "R8",  // 主要カテゴリのズレ
  "R11", // メニュー未登録
  "P17", // 口コミ件数が少ない → 口コミオバケに直結
  "P18", // 平均評価
  "R4",  // 営業時間未登録
  "D3",  // 電話未登録
  "D2",  // 住所
  "P12", // 写真なし
  "P25", // HP→GBP導線
  "R9",  // サブカテゴリ
];

// 「良い点」として案内する優先順位（○項目から選ぶ。褒めて刺さるものを上位に）
const GOOD_PRIORITY = ["P18", "P17", "P24", "P20", "R4", "R6", "D2", "D3", "P12", "R1"];

// 伸びしろ項目のお客さま向け言い回し（×項目のラベルは肯定文なのでそのままだと不自然）
const GAP_TEXT = {
  P24: "自社のHP/LPがまだ無い（Googleで見つけた人の受け皿づくり）",
  R6: "GoogleのWebサイト欄が空になっている",
  R8: "Googleのカテゴリ設定がお店の看板と合っていない可能性",
  R11: "メニュー（商品・サービス）がGoogleに未登録",
  P17: "Googleの口コミ件数がまだ少ない",
  P18: "Googleの平均評価（★）に改善余地",
  R4: "営業時間がGoogleに未登録",
  D3: "電話番号がGoogleに未登録",
  D2: "住所情報が未登録/不正確の可能性",
  P12: "お店の写真がGoogleに載っていない",
  P25: "HPからGoogleマップへの導線が無い",
  R9: "Googleのサブカテゴリが未活用",
  R1: "店名情報が取得できない状態",
};
const gapText = (item) => GAP_TEXT[item.id] || `「${item.label}」が未対応/要確認`;

function pickByPriority(items, mark, priority, count) {
  const pool = items.filter((i) => i.mark === mark);
  const picked = [];
  for (const id of priority) {
    const hit = pool.find((i) => i.id === id);
    if (hit && !picked.includes(hit)) picked.push(hit);
    if (picked.length >= count) return picked;
  }
  for (const i of pool) {
    if (!picked.includes(i)) picked.push(i);
    if (picked.length >= count) break;
  }
  return picked;
}

const pct = (x) => Math.round(x * 100);

/** 「伸びしろ」2項目を選ぶ（buildSummary と診断リード記録で同じものを使う） */
export function pickGaps(score) {
  let gaps = pickByPriority(score.items, "×", GAP_PRIORITY, 2);
  // ×が2件未満の店（かなり整っている店）は△要確認で補う
  if (gaps.length < 2) {
    gaps = gaps.concat(
      pickByPriority(score.items, "△", GAP_PRIORITY, 2 - gaps.length)
    );
  }
  return gaps;
}

/** 採点結果 → LINEで返す要約テキスト（決定論・捏造なし） */
export function buildSummary(place, score) {
  const goods = pickByPriority(score.items, "○", GOOD_PRIORITY, 1);
  const gaps = pickGaps(score);

  const L = [];
  L.push("📊 無料GBP診断の結果です");
  L.push(`「${place.displayName}」さま`);
  L.push("");
  L.push(`Google最適化度：約${score.total}%（${score.signal}）`);
  L.push(
    "内訳：" +
      Object.entries(score.axes)
        .map(([k, v]) => `${AXIS_JA[k]}${pct(v.ratio)}%`)
        .join(" ／ ")
  );
  L.push("");
  L.push("✅ 良い点");
  if (goods.length) {
    for (const g of goods) L.push(`・${g.label}｜${g.reason}`);
  } else {
    L.push("・現状、○がつく項目が見当たりませんでした（＝伸びしろ大です）");
  }
  L.push("");
  L.push("📈 伸びしろ");
  for (const g of gaps) L.push(`・${gapText(g)}`);
  L.push("");
  L.push("※本診断は「Googleでの最適化度」の点検で、検索順位を保証するものではありません。");
  L.push("※一部は公開情報だけでは確定できないため、詳細診断でオーナーさま確認のうえ確定します。");
  L.push("");
  L.push("29項目の詳しいレポートと改善のご相談は無料です。");
  L.push("『相談したい』と返信いただければ、担当の上田が直接ご連絡します😊");
  return L.join("\n");
}

/**
 * 店名 → 診断実行（Places Text Search + Details の2コール）
 * @returns {{ place, score, summary, gaps }} gaps＝要約で提示した「伸びしろ」2項目の文言
 * @throws 店が見つからない／APIエラー時（呼び出し側でユーザー向け文言に変換）
 */
export async function runDiagnosis(storeName) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY 未設定");
  const placeId = await searchPlaceId({ query: storeName, apiKey });
  const place = await fetchPlaceDetails({ placeId, apiKey });
  const score = scoreGbp(place); // manual なし＝公開情報のみの一次診断
  return {
    place,
    score,
    summary: buildSummary(place, score),
    gaps: pickGaps(score).map(gapText), // リード名簿に残す「提示した伸びしろ」
  };
}
