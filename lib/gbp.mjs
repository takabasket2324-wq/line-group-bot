// ============================================================================
//  gbp.mjs — Googleビジネスプロフィール(GBP)無料診断 v1 のコア
//  （原本：ai-company-kit/server/lib/gbp.js からの移植。採点ロジックは同一）
//  役割：Places API (New) で店の公開情報を取得 → 採点ルーブリック(29項目)で
//        ○△×判定 → 関連性45/距離15/知名度40 の重み付き総合最適化度%を算出。
//
//  ⚠️ 大原則（オンブランド・厳守）
//   - Googleの検索順位は保証しない。これは「最適化度の診断」であって順位保証ではない。
//   - 取れない項目は捏造しない。△要確認のまま残し、本番でオーナー確認/手入力で埋める。
//   - APIキーはコードに書かない。呼び出し側が環境変数 GOOGLE_PLACES_API_KEY を渡す。
//
//  半自動が現実解：
//   Places API (New) では「オーナー確認状態・投稿(Posts)・Q&A・オーナー返信率・
//   口コミ本文の全解析(直近5件のみ)・写真の種別/正確枚数」は取得できない。
//   → これらは △要確認 とし、manual{} 手入力/オーナー確認で上書きする設計。
// ============================================================================

const PLACES_BASE = "https://places.googleapis.com/v1";

// Place Details で要求するフィールド（field mask）。
// rating / reviews / photos を含めると課金階層が上がる点に注意（呼び出し側で費用管理）。
const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "primaryType",
  "primaryTypeDisplayName",
  "types",
  "formattedAddress",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "websiteUri",
  "googleMapsUri",
  "rating",
  "userRatingCount",
  "regularOpeningHours",
  "currentOpeningHours",
  "photos",
  "editorialSummary",
  "reviews",
  "businessStatus",
  "priceLevel",
  "accessibilityOptions",
].join(",");

// 集約サイト・SNSのホスト（websiteUri がこれらなら「自社HP」ではないと判定）
const AGGREGATOR_HOSTS = [
  "tabelog.com", "hotpepper.jp", "gnavi.co.jp", "retty.me", "ekiten.jp",
  "instagram.com", "facebook.com", "twitter.com", "x.com", "gorp.jp",
  "goo.gle", "g.page", "maps.app.goo.gl", "line.me", "toreta.in",
];

// ---------------------------------------------------------------------------
// 1. データ取得：Places API (New)  Text Search → Place Details
// ---------------------------------------------------------------------------

/** 店名(＋エリア)から place_id を1件引く（Text Search） */
export async function searchPlaceId({ query, apiKey }) {
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY 未設定");
  const res = await fetch(`${PLACES_BASE}/places:searchText`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
    },
    body: JSON.stringify({ textQuery: query, languageCode: "ja", regionCode: "JP" }),
  });
  if (!res.ok) throw new Error(`Text Search 失敗: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const first = (data.places || [])[0];
  if (!first) throw new Error(`「${query}」に一致する店が見つかりませんでした`);
  return first.id;
}

/** place_id から詳細を取得（Place Details）し、採点に使う正規化オブジェクトへ */
export async function fetchPlaceDetails({ placeId, apiKey }) {
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY 未設定");
  const res = await fetch(`${PLACES_BASE}/places/${placeId}`, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": DETAILS_FIELD_MASK,
      "Accept-Language": "ja",
    },
  });
  if (!res.ok) throw new Error(`Place Details 失敗: ${res.status} ${await res.text()}`);
  return normalizePlace(await res.json());
}

/** Places API のレスポンス → 採点で使う素直な形に */
export function normalizePlace(p) {
  const photos = p.photos || [];
  return {
    placeId: p.id || null,
    displayName: p.displayName?.text || null,
    primaryType: p.primaryType || null,
    primaryTypeDisplayName: p.primaryTypeDisplayName?.text || null,
    types: p.types || [],
    formattedAddress: p.formattedAddress || null,
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber || null,
    websiteUri: p.websiteUri || null,
    googleMapsUri: p.googleMapsUri || null,
    rating: typeof p.rating === "number" ? p.rating : null,
    userRatingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
    hasRegularHours: !!p.regularOpeningHours,
    weekdayHours: p.regularOpeningHours?.weekdayDescriptions || [],
    hasSpecialHours: !!(p.currentOpeningHours?.specialDays?.length),
    // ⚠️ Places は写真参照を最大10件しか返さない＝「正確な総枚数」ではない（上限あり）
    photoRefCount: photos.length,
    editorialSummary: p.editorialSummary?.text || null,
    reviews: (p.reviews || []).map((r) => ({
      text: r.text?.text || r.originalText?.text || "",
      rating: r.rating,
      publishTime: r.publishTime || null,
      // ⚠️ Places の reviews にオーナー返信は含まれない → 返信率は算出不可(△/手入力)
    })),
    accessibility: p.accessibilityOptions || null,
    businessStatus: p.businessStatus || null,
    _fetchedAt: new Date().toISOString(),
    _source: "places_api_new",
  };
}

// ---------------------------------------------------------------------------
// 2. 採点ルーブリック（29項目＝Google公式3要素26項目＋社長承認の追加3項目）
//    weight は軸の配点。各項目は evaluate(place, manual) → { mark:'○'|'△'|'×', reason }
//    manual{itemXX} で上書き可能（半自動：オーナー確認/手入力で△を確定させる）
// ---------------------------------------------------------------------------

const OWN = "自社独自ドメイン";
function isOwnWebsite(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return !AGGREGATOR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch { return false; }
}

// 「Places APIでは取得できない＝手入力/オーナー確認で埋める」項目の共通△
function needManual(note) {
  return { mark: "△", reason: `要確認（Places API取得不可・${note}）` };
}

export const RUBRIC = {
  axes: { relevance: 45, distance: 15, prominence: 40 },
  items: [
    // ===== 関連性 Relevance（11項目）=====
    { id: "R1", n: 1, axis: "relevance", label: "ビジネス名が実店舗名と一致（詰め込み無し）",
      ev: (p) => p.displayName
        ? { mark: "○", reason: `Google表示「${p.displayName}」を確認（詰め込みの有無は目視推奨）` }
        : { mark: "×", reason: "店名が取得できません" } },
    { id: "R4", n: 4, axis: "relevance", label: "営業時間を登録済み",
      ev: (p) => p.hasRegularHours ? { mark: "○", reason: "営業時間の登録あり" } : { mark: "×", reason: "営業時間 未登録" } },
    { id: "R5", n: 5, axis: "relevance", label: "祝日・特別営業時間を設定済み",
      ev: (p) => p.hasSpecialHours ? { mark: "○", reason: "特別営業時間あり" } : needManual("祝日/臨時営業の設定は要確認") },
    { id: "R6", n: 6, axis: "relevance", label: "Webサイト欄にURL設定",
      ev: (p) => p.websiteUri ? { mark: "○", reason: `Webサイト欄あり（${p.websiteUri}）` } : { mark: "×", reason: "Webサイト欄が空" } },
    { id: "R7", n: 7, axis: "relevance", label: "予約/注文リンクを設定",
      ev: () => needManual("予約導線はオーナー確認/目視") },
    { id: "R8", n: 8, axis: "relevance", label: "メインカテゴリが業態に最適",
      ev: (p) => p.primaryTypeDisplayName
        ? { mark: "△", reason: `主要カテゴリ「${p.primaryTypeDisplayName}」。店名/看板との整合を要確認` }
        : needManual("主要カテゴリ未取得") },
    { id: "R9", n: 9, axis: "relevance", label: "サブカテゴリを網羅",
      ev: (p) => (p.types && p.types.length >= 3)
        ? { mark: "○", reason: `カテゴリ ${p.types.length} 種を確認` }
        : { mark: "△", reason: "サブカテゴリが少ない/未確認（追加カテゴリの活用余地）" } },
    { id: "R10", n: 10, axis: "relevance", label: "属性を設定（支払/席/設備等）",
      ev: (p) => p.accessibility
        ? { mark: "△", reason: "一部属性あり。支払/席等の網羅は要確認" }
        : needManual("属性設定は要確認") },
    { id: "R11", n: 11, axis: "relevance", label: "メニュー(商品/サービス)を登録",
      ev: () => needManual("メニュー登録はオーナー確認/目視") },
    { id: "R27", n: 27, axis: "relevance", label: "メニューに写真があるか【追加】",
      ev: () => needManual("メニュー写真はオーナー確認/目視") },
    { id: "R28", n: 28, axis: "relevance", label: "商品/サービスの説明文が充実か【追加】",
      ev: () => needManual("メニュー説明文はオーナー確認/目視") },

    // ===== 距離 Distance（3項目・NAP一貫性）=====
    { id: "D2", n: 2, axis: "distance", label: "住所が正確（建物・階数まで）",
      ev: (p) => p.formattedAddress
        ? { mark: "○", reason: `住所登録あり（${p.formattedAddress}）。建物/階の正確さは目視推奨` }
        : { mark: "×", reason: "住所未取得" } },
    { id: "D3", n: 3, axis: "distance", label: "電話番号のNAP一貫",
      ev: (p) => p.phone
        ? { mark: "○", reason: `電話登録あり（${p.phone}）。他媒体との一致はNo.26で確認` }
        : { mark: "×", reason: "電話番号 未登録" } },
    { id: "D26", n: 26, axis: "distance", label: "他媒体(食べログ/HPB等)とNAP一致",
      ev: () => needManual("他媒体との住所/電話/名称の一致は目視照合") },

    // ===== 知名度 Prominence（15項目）=====
    { id: "P17", n: 17, axis: "prominence", label: "クチコミ件数（競合比で多いか）",
      ev: (p) => p.userRatingCount == null
        ? needManual("口コミ件数が未取得（未ログイン制限等）")
        : (p.userRatingCount >= 50
            ? { mark: "○", reason: `口コミ ${p.userRatingCount} 件` }
            : (p.userRatingCount >= 20
                ? { mark: "△", reason: `口コミ ${p.userRatingCount} 件（増やす余地）` }
                : { mark: "×", reason: `口コミ ${p.userRatingCount} 件（少ない）` })) },
    { id: "P18", n: 18, axis: "prominence", label: "平均評価（★）",
      ev: (p) => p.rating == null
        ? needManual("★評価が未取得")
        : (p.rating >= 4.0
            ? { mark: "○", reason: `★${p.rating}（4.0以上）` }
            : (p.rating >= 3.5
                ? { mark: "△", reason: `★${p.rating}（3.5〜4.0）` }
                : { mark: "×", reason: `★${p.rating}（3.5未満）` })) },
    { id: "P19", n: 19, axis: "prominence", label: "クチコミへの返信率",
      ev: () => needManual("オーナー返信率はAPI非対応・オーナー確認/目視") },
    { id: "P20", n: 20, axis: "prominence", label: "直近1ヶ月に新規クチコミ",
      ev: (p) => {
        const t = p.reviews?.[0]?.publishTime;
        if (!t) return needManual("直近口コミの日付が未取得（口コミは直近5件のみ）");
        const days = (Date.now() - new Date(t).getTime()) / 86400000;
        return days <= 31
          ? { mark: "○", reason: `直近口コミ ${Math.round(days)}日前` }
          : { mark: "△", reason: `直近口コミ ${Math.round(days)}日前（鮮度は要確認）` };
      } },
    { id: "P21", n: 21, axis: "prominence", label: "投稿(最新情報)を定期発信",
      ev: () => needManual("投稿(Posts)頻度はAPI非対応・オーナー確認") },
    { id: "P22", n: 22, axis: "prominence", label: "メッセージ機能ON",
      ev: () => needManual("メッセージ機能はAPI非対応・オーナー確認") },
    { id: "P23", n: 23, axis: "prominence", label: "Q&Aに回答あり",
      ev: () => needManual("Q&AはAPI非対応・目視/オーナー確認") },
    { id: "P12", n: 12, axis: "prominence", label: "外観写真あり",
      ev: (p) => p.photoRefCount > 0
        ? { mark: "○", reason: `写真あり（参照${p.photoRefCount}件）。種別(外観/内観)の判別は目視` }
        : { mark: "×", reason: "写真なし" } },
    { id: "P13", n: 13, axis: "prominence", label: "内観写真あり",
      ev: () => needManual("写真の種別(内観)はAPIで判別不可・目視") },
    { id: "P14", n: 14, axis: "prominence", label: "料理写真が10枚以上",
      ev: (p) => needManual(`写真の正確枚数はAPI上限あり（参照${p.photoRefCount}件）・目視/オーナー確認`) },
    { id: "P15", n: 15, axis: "prominence", label: "写真が直近3ヶ月以内に更新",
      ev: () => needManual("写真の更新日はAPI非対応・目視/オーナー確認") },
    { id: "P16", n: 16, axis: "prominence", label: "ロゴ・カバー写真を設定",
      ev: () => needManual("ロゴ/カバーの設定はAPIで判別不可・オーナー確認") },
    { id: "P24", n: 24, axis: "prominence", label: "自社HP/LPがある",
      ev: (p) => p.websiteUri
        ? (isOwnWebsite(p.websiteUri)
            ? { mark: "○", reason: `${OWN}のサイトあり（${p.websiteUri}）` }
            : { mark: "×", reason: `Webサイト欄が集約/SNS（${p.websiteUri}）＝自社HPではない` })
        : { mark: "×", reason: "Webサイト欄が空＝自社HP無しの可能性大" } },
    { id: "P25", n: 25, axis: "prominence", label: "HP→GBPへの導線/地図埋め込み",
      ev: (p) => (p.websiteUri && isOwnWebsite(p.websiteUri))
        ? needManual("自社HP側のGBP導線/地図埋め込みは目視")
        : { mark: "×", reason: "自社HPが無いため導線なし" } },
    { id: "P29", n: 29, axis: "prominence", label: "口コミに業種/メニュー等の関連キーワードが入っているか【追加】",
      ev: (p) => {
        // 直近5件しか取れないため「全解析」は不可。取れた範囲でキーワード有無を推定。
        const kws = keywordsFor(p);
        const texts = (p.reviews || []).map((r) => r.text).filter(Boolean);
        if (!texts.length) return needManual("口コミ本文が未取得（直近5件のみ・未ログイン制限等）");
        const hit = texts.some((t) => kws.some((k) => t.includes(k)));
        return hit
          ? { mark: "△", reason: `直近口コミに関連語あり（全件解析は不可＝要確認）。処方＝口コミオバケ👻` }
          : { mark: "△", reason: `直近口コミに関連語が薄い（全件解析は不可＝要確認）。処方＝口コミオバケ👻` };
      } },
  ],
};

// 関連キーワード候補（店名トークン＋カテゴリ表示名）
function keywordsFor(p) {
  const set = new Set();
  if (p.primaryTypeDisplayName) set.add(p.primaryTypeDisplayName.replace(/店$/, ""));
  (p.displayName || "").split(/[\s　のと・]/).filter((s) => s.length >= 2).forEach((s) => set.add(s));
  return [...set];
}

// ---------------------------------------------------------------------------
// 3. 採点実行：place(+manual) → 軸別スコア・項目一覧・総合最適化度%
// ---------------------------------------------------------------------------

const MARK_VAL = { "○": 1, "△": 0.5, "×": 0 };

export function scoreGbp(place, manual = {}) {
  const items = RUBRIC.items.map((it) => {
    // manual 上書き（半自動：オーナー確認/手入力で△を確定）
    if (manual[it.id]) {
      const m = manual[it.id];
      return { id: it.id, n: it.n, axis: it.axis, label: it.label,
        mark: m.mark, reason: m.reason || "手入力/オーナー確認で確定", manual: true };
    }
    const r = it.ev(place) || needManual("判定不可");
    return { id: it.id, n: it.n, axis: it.axis, label: it.label, mark: r.mark, reason: r.reason, manual: false };
  });

  const axes = {};
  for (const axis of Object.keys(RUBRIC.axes)) {
    const list = items.filter((i) => i.axis === axis);
    const got = list.reduce((s, i) => s + MARK_VAL[i.mark], 0);
    const ratio = list.length ? got / list.length : 0;
    axes[axis] = {
      weight: RUBRIC.axes[axis],
      count: list.length,
      ratio,
      weighted: ratio * RUBRIC.axes[axis],
      tally: {
        "○": list.filter((i) => i.mark === "○").length,
        "△": list.filter((i) => i.mark === "△").length,
        "×": list.filter((i) => i.mark === "×").length,
      },
    };
  }
  const total = Object.values(axes).reduce((s, a) => s + a.weighted, 0);
  const signal = total >= 80 ? "🟢" : total >= 50 ? "🟡" : "🔴";
  return { items, axes, total: Math.round(total * 10) / 10, signal };
}

// ---------------------------------------------------------------------------
// 4. モックデータ：豚足のかどや なんば本店（2026-07-12 実地確認・未ログイン制限）
//    ※実APIキーがあれば userRatingCount / reviews も返るが、本モックは実測値に忠実。
//    manual{} は実地確認で人が確定した値（カテゴリのズレ・オーナー未登録 等）。
// ---------------------------------------------------------------------------

export const MOCK_TONSOKU = {
  place: {
    placeId: "MOCK_tonsoku_kadoya",
    displayName: "豚足のかどや",
    primaryType: "barbecue_restaurant",
    primaryTypeDisplayName: "ホルモン焼肉店",
    types: ["barbecue_restaurant", "restaurant", "food", "point_of_interest"],
    formattedAddress: "〒556-0011 大阪府大阪市浪速区難波中1-4-15 南松竹マンション 1階",
    phone: "06-6631-7956",
    websiteUri: null,                 // Google上「ウェブサイトを追加してください」＝空
    googleMapsUri: "https://maps.google.com/?cid=7469375472072128284",
    rating: 4.3,                      // 実測（Googleマップ）
    userRatingCount: null,            // 未ログイン制限で非表示 → △要確認
    hasRegularHours: true,
    weekdayHours: ["日曜日: 11:00～21:30", "月曜日: 11:00～21:30", "火曜日: 11:00～21:30"],
    hasSpecialHours: false,
    photoRefCount: 1,                 // 店頭写真は確認（正確枚数は未ログインで不明）
    editorialSummary: "ビールや日本酒とよく合うホルモンの串焼きが人気の気取りのない素朴な店。",
    reviews: [],                      // 未ログインで本文取得不可
    accessibility: { wheelchairAccessibleEntrance: false },
    businessStatus: "OPERATIONAL",
    _fetchedAt: "2026-07-12T00:00:00.000Z",
    _source: "manual_field_check(Googleマップ/食べログ)・未ログイン制限",
  },
  // 実地確認で人が確定した項目（半自動の“手入力/オーナー確認”相当）
  manual: {
    R7:  { mark: "×", reason: "予約導線なし（食べログ上も「予約不可」＝店の方針。優先度は低い）" },
    R8:  { mark: "×", reason: "主要カテゴリが「ホルモン焼肉店」＝看板の“豚足”が反映されていない（実地確認）" },
    R9:  { mark: "×", reason: "サブカテゴリの表示なし（豚料理/居酒屋/もつ焼き等が未設定に見える）" },
    R11: { mark: "×", reason: "メニュー項目の表示なし（オーナー未登録のため未登録と推定）" },
    R27: { mark: "×", reason: "メニュー未登録のため写真もなし" },
    R28: { mark: "×", reason: "メニュー未登録＝説明文なし。Google説明は自動生成の短文のみ" },
    D26: { mark: "○", reason: "Google↔食べログで住所・電話・営業時間が一致（HPB/ぐるなび等の全媒体照合は要確認）" },
    P12: { mark: "○", reason: "Googleに店頭写真あり（実地確認）" },
    P19: { mark: "×", reason: "オーナー未登録の表示あり＝オーナー返信は行われていないと推定" },
    P21: { mark: "×", reason: "オーナー未登録＝投稿(最新情報)は未使用と推定" },
    P22: { mark: "×", reason: "オーナー未登録＝メッセージ未設定と推定" },
    P29: { mark: "△", reason: "Google口コミ本文は未取得(要確認)。食べログ側は「豚足/老舗/専門店」が濃厚＝素地あり。処方＝口コミオバケ👻" },
  },
  // レポートに載せる代替指標（出典明記・捏造しない）
  altMetrics: [
    "食べログ 3.55（口コミ2,459件・写真11,746枚）※2026-07時点",
    "Yahoo!マップ 3.93（127件）",
    "1951年創業／多言語メニューあり（英・中繁・中簡・韓）＝インバウンド素地",
  ],
};
