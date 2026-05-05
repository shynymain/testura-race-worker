// testura-race-worker 検証用 no-odds 詳細ページraceName優先版
// 一覧ページでは raceId だけ取得。raceName は /race/shutuba.html の詳細ページから取得。
// オッズ取得は完全OFF。odds/popularity は空。

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return json({
        ok: true,
        version: "verify-no-odds-fetchfix-v2-20240501",
        purpose: "raceId/basic/horses/result from detail, last3 from horse page fallback. odds disabled.",
        endpoints: [
          "/api/health",
          "/api/debug-list?date=2026-05-02",
          "/api/debug-horse?horseId=2023106995",
          "/api/race?date=2026-05-02&place=京都&raceNo=9",
          "/api/race?date=2026-05-03&place=京都&raceNo=11"
        ]
      });
    }

    if (url.pathname === "/api/debug-list") {
      const date = url.searchParams.get("date");
      if (!date) return json({ ok: false, error: "date required" }, 400);
      return json(await getRaceList(date, true));
    }

    if (url.pathname === "/api/debug-horse") {
      const horseId = url.searchParams.get("horseId");
      if (!horseId) return json({ ok: false, error: "horseId required" }, 400);

      const fetched = await fetchHtml(`https://db.netkeiba.com/horse/${horseId}/`);
      const html = fetched.html || "";
      return json({
        ok: true,
        horseId,
        status: fetched.status,
        finalUrl: fetched.finalUrl || fetched.url,
        htmlLength: html.length,
        hasRaceTable: html.includes("db_h_race_results"),
        hasTable: html.includes("<table"),
        hasAccessDenied: /Access Denied|Forbidden|アクセス|captcha|Cloudflare/i.test(html),
        head: html.slice(0, 1200)
      });
    }

    if (url.pathname === "/api/race") {
      const date = url.searchParams.get("date");
      const place = url.searchParams.get("place");
      const raceNo = normalizeRaceNo(url.searchParams.get("raceNo"));

      if (!date || !place || !raceNo) {
        return json({ ok: false, error: "date/place/raceNo required" }, 400);
      }

      const listData = await getRaceList(date, false);
      const races = listData.races || [];
      const target = races.find(r =>
        r.place.includes(place) &&
        String(Number(r.raceNo)) === String(Number(raceNo))
      );

      if (!target) {
        return json({
          ok: false,
          error: "race_id not found",
          input: { date, place, raceNo },
          raceListStatus: listData.status || "",
          count: races.length,
          foundRaces: races
        }, 404);
      }

      const raceBasic = await getRaceBasic(target.raceId, date, place, raceNo);
      const horses = await getShutuba(target.raceId);
      const result = await getResult(target.raceId);

      const race = {
        ...raceBasic,
        date: date.replaceAll("-", "/"),
        place,
        raceNo: String(Number(raceNo)),
        raceId: target.raceId,
        // 一覧ページの raceName は使わない。詳細ページだけを信頼する。
        raceName: raceBasic.raceName || "",
        headcount: String(horses.length)
      };

      const validation = validateRacePayload(race, horses, result);

      return json({
        ok: true,
        mode: "verify-no-odds-fetchfix",
        validation,
        race,
        horses,
        result
      });
    }

    return json({ ok: false, error: "not found" }, 404);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" }
  });
}

function normalizeRaceNo(v) {
  if (!v) return "";
  return String(v).replace("R", "").replace("r", "").trim();
}

function normalizeDate(date) {
  return String(date || "").replaceAll("-", "").replaceAll("/", "");
}

function commonHeaders(referer = "https://race.netkeiba.com/") {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,application/json,text/plain,*/*;q=0.8",
    "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": referer
  };
}

async function fetchHtml(targetUrl) {
  const referer = targetUrl.includes("db.netkeiba.com")
    ? "https://db.netkeiba.com/"
    : "https://race.netkeiba.com/";

  const res = await fetch(targetUrl, {
    method: "GET",
    redirect: "follow",
    headers: commonHeaders(referer)
  });

  const buffer = await res.arrayBuffer();

  let html = "";
  // netkeibaはEUC-JPが多い。失敗時のみSJIS/UTF-8へfallback。
  try {
    html = new TextDecoder("EUC-JP").decode(buffer);
  } catch {
    try {
      html = new TextDecoder("shift_jis").decode(buffer);
    } catch {
      try {
        html = new TextDecoder("utf-8").decode(buffer);
      } catch {
        html = "";
      }
    }
  }

  // 文字化け保険：EUCで崩れた時にUTF-8の方が自然なら差し替える
  try {
    const utf8 = new TextDecoder("utf-8").decode(buffer);
    if (
      utf8 &&
      utf8.includes("<html") &&
      (!html.includes("<html") || html.includes("�"))
    ) {
      html = utf8;
    }
  } catch {}

  return {
    ok: res.ok,
    status: res.status,
    finalUrl: res.url,
    url: targetUrl,
    html
  };
}

async function getRaceList(date, includeDebug = false) {
  const ymd = normalizeDate(date);
  const urls = [
    `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${ymd}`,
    `https://race.netkeiba.com/top/race_list.html?kaisai_date=${ymd}`
  ];

  let lastInfo = null;

  for (const targetUrl of urls) {
    const fetched = await fetchHtml(targetUrl);
    const html = fetched.html || "";
    const races = parseRaceListHtml(html);

    if (races.length > 0) {
      return {
        ok: true,
        date,
        sourceUrl: targetUrl,
        status: fetched.status,
        count: races.length,
        races
      };
    }

    lastInfo = {
      sourceUrl: targetUrl,
      status: fetched.status,
      htmlLength: html.length,
      hasRaceId: html.includes("race_id"),
      hasKyoto: html.includes("京都"),
      head: html.slice(0, 300)
    };
  }

  return {
    ok: true,
    date,
    status: "no races parsed",
    count: 0,
    races: [],
    debug: includeDebug ? lastInfo : undefined
  };
}

function parseRaceListHtml(html) {
  const races = [];
  const seen = new Set();
  const matches = [...html.matchAll(/race_id=(\d{12})/g)];

  for (const m of matches) {
    const raceId = m[1];
    if (seen.has(raceId)) continue;
    seen.add(raceId);

    const raceNo = String(Number(raceId.slice(-2)));
    const around = html.slice(Math.max(0, m.index - 700), Math.min(html.length, m.index + 700));
    const aroundText = stripTags(around);

    let place = detectPlace(aroundText);
    if (!place) place = placeFromRaceId(raceId);
    if (!place) continue;

    // debug-listではraceNameを無理に取らない。一覧は不安定なので空で返す。
    races.push({
      place,
      raceNo,
      raceId,
      raceName: ""
    });
  }

  return races.sort((a, b) => {
    if (a.place !== b.place) return a.place.localeCompare(b.place, "ja");
    return Number(a.raceNo) - Number(b.raceNo);
  });
}

function detectPlace(text) {
  const places = ["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"];
  return places.find(p => text.includes(p)) || "";
}

function placeFromRaceId(raceId) {
  const code = raceId.slice(4, 6);
  const map = {
    "01": "札幌",
    "02": "函館",
    "03": "福島",
    "04": "新潟",
    "05": "東京",
    "06": "中山",
    "07": "中京",
    "08": "京都",
    "09": "阪神",
    "10": "小倉"
  };
  return map[code] || "";
}

async function getRaceBasic(raceId, date, place, raceNo) {
  const fetched = await fetchHtml(`https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`);
  const html = fetched.html || "";

  const raceName = extractRaceNameFromDetail(html);

  const infoText = stripTags(html);

  const surface = parseSurface(infoText);
  const distance = parseDistance(infoText);
  const grade = parseGrade(infoText);
  const condition = parseCondition(infoText);
  const age = parseAge(infoText);
  const sex = parseSex(infoText);

  return { date, place, raceNo, raceName, surface, distance, grade, condition, age, sex };
}

function extractRaceNameFromDetail(html) {
  let raceName = "";

  // h1優先
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1 && h1[1]) {
    raceName = stripTags(h1[1]);
  }

  // title fallback
  if (!raceName) {
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (title && title[1]) {
      raceName = stripTags(title[1].split("|")[0]);
    }
  }

  // og:title fallback
  if (!raceName) {
    const og = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
    if (og && og[1]) {
      raceName = cleanText(og[1]);
    }
  }

  return sanitizeRaceName(raceName);
}

function sanitizeRaceName(s) {
  let t = cleanText(String(s || ""))
    .replace(/-->/g, "")
    .replace(/→/g, "")
    .replace(/▶/g, "")
    .replace(/出馬表.*$/g, "")
    .replace(/結果.*$/g, "")
    .replace(/オッズ.*$/g, "")
    .replace(/^\d+\s*R\s*/g, "")
    .replace(/\(.+?\)/g, "")
    .trim();

  if (!t || t === "-" || t === "--" || t === "ー" || t === "⇒") return "";

  const ng = ["Race", "レース一覧", "開催", "競馬", "netkeiba"];
  if (ng.some(x => t.includes(x))) return "";

  return t;
}

function parseSurface(text) {
  if (text.includes("障")) return "障害";
  if (text.includes("ダ")) return "ダート";
  if (text.includes("芝")) return "芝";
  return "";
}

function parseDistance(text) {
  const m = text.match(/(?:芝|ダ|ダート|障)[^\d]{0,10}(\d{3,4})m/);
  return m ? m[1] : "";
}

function parseGrade(text) {
  if (text.includes("G1")) return "G1";
  if (text.includes("G2")) return "G2";
  if (text.includes("G3")) return "G3";
  if (text.includes("リステッド") || text.includes("L)")) return "L";
  if (text.includes("オープン")) return "OP";
  if (text.includes("3勝クラス")) return "3勝";
  if (text.includes("2勝クラス")) return "2勝";
  if (text.includes("1勝クラス")) return "1勝";
  if (text.includes("未勝利")) return "未勝利";
  if (text.includes("新馬")) return "新馬";
  return "";
}

function parseCondition(text) {
  if (text.includes("ハンデ")) return "ハンデ";
  if (text.includes("別定")) return "別定";
  return "定量";
}

function parseAge(text) {
  const m = text.match(/([2-5]歳以上|[2-4]歳)/);
  return m ? m[1] : "";
}

function parseSex(text) {
  return text.includes("牝") ? "牝馬" : "混合";
}

async function getShutuba(raceId) {
  const fetched = await fetchHtml(`https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`);
  const html = fetched.html || "";

  const rows = [...html.matchAll(/<tr[^>]*HorseList[^>]*>([\s\S]*?)<\/tr>/g)];
  const horses = [];

  for (const row of rows) {
    const tr = row[1];

    const no = cleanText(stripTags(tr.match(/<td[^>]*Umaban[^>]*>([\s\S]*?)<\/td>/i)?.[1] || "")).replace(/\D/g, "");

    const frameByHtml = cleanText(stripTags(tr.match(/<td[^>]*Waku[^>]*>([\s\S]*?)<\/td>/i)?.[1] || "")).replace(/\D/g, "");

    const frame = frameByHtml || calcJraFrame(no, rows.length);

    const horseLink =
      tr.match(/href=["']https?:\/\/db\.netkeiba\.com\/horse\/(\d+)\/?["']/i)?.[1] ||
      tr.match(/href=["']\/horse\/(\d+)\/?["']/i)?.[1] ||
      tr.match(/horse\/(\d+)/i)?.[1] ||
      "";

    const nameRaw =
      tr.match(/<span[^>]*HorseName[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
      tr.match(/class=["']HorseName["'][\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
      "";

    const name = cleanText(stripTags(nameRaw));

    // まず出馬表内から取得。不足なら個別馬ページで補完。
    let last = parseRecentFinishesFromRow(tr);

    if ((!last.last1 || !last.last2 || !last.last3) && horseLink) {
      const hp = await getHorseLastFinishes(horseLink);
      if (hp.last1 || hp.last2 || hp.last3) last = hp;
    }

    if (no || name) {
      horses.push({
        frame,
        no,
        name,
        horseId: horseLink,
        last1: last.last1 || "",
        last2: last.last2 || "",
        last3: last.last3 || "",
        odds: "",
        popularity: ""
      });
    }
  }

  return horses.sort((a, b) => Number(a.no || 999) - Number(b.no || 999));
}

async function getHorseLastFinishes(horseId) {
  // db.netkeiba 個別馬ページから近3走の着順を取得するTD抽出・最終版。
  // ポイント:
  // 1) db_h_race_results テーブルを優先
  // 2) <td> を正規抽出して cols 配列化
  // 3) 人気・オッズ・馬番・枠番を避け、着順候補だけ採用
  // 4) テーブルが取れない場合はページ内tr全体をfallback探索
  const url = `https://db.netkeiba.com/horse/${horseId}/`;
  const fetched = await fetchHtml(url);
  const html = fetched.html || "";

  let targetHtml = "";

  const tableMatch =
    html.match(/<table[^>]*class=["'][^"']*db_h_race_results[^"']*["'][^>]*>[\s\S]*?<\/table>/i) ||
    html.match(/<table[^>]*db_h_race_results[^>]*>[\s\S]*?<\/table>/i);

  if (tableMatch) {
    targetHtml = tableMatch[0];
  } else {
    // fallback：テーブルclassが取れない場合でも、ページ全体からtr探索する
    targetHtml = html;
  }

  const rows = [...targetHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const finishes = [];

  for (const row of rows) {
    const rowHtml = row[1];

    // ヘッダー除外
    if (/<th[\s\S]*?>/i.test(rowHtml)) continue;

    const cols = extractTdValues(rowHtml);

    // 戦績行でないものを除外
    if (cols.length < 8) continue;

    // 戦績行判定：日付が先頭付近にあることを優先
    const hasDate = cols.slice(0, 3).some(c => /^\d{4}\/\d{1,2}\/\d{1,2}/.test(c));
    if (!hasDate) continue;

    const finish = pickSafeFinishFromHorseRow(cols);
    if (finish) finishes.push(finish);

    if (finishes.length >= 3) break;
  }

  return {
    last1: finishes[0] || "",
    last2: finishes[1] || "",
    last3: finishes[2] || ""
  };
}

function extractTdValues(rowHtml) {
  const tdMatches = [...String(rowHtml || "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];

  return tdMatches.map(m =>
    cleanText(
      stripTags(m[1])
        .replace(/\r?\n/g, " ")
        .replace(/\t/g, " ")
    )
  ).filter(v => v !== "");
}

function pickSafeFinishFromHorseRow(cols) {
  // netkeiba DBの標準列:
  // 0日付,1開催,2天気,3R,4レース名,5映像,6頭数,7枠番,8馬番,9オッズ,10人気,11着順...
  // まず index 11〜14 を優先。ここが一番人気混入しにくい。
  const preferredIndexes = [11, 12, 13, 14];
  for (const idx of preferredIndexes) {
    const v = normalizeFinishValue(cols[idx]);
    if (v) return v;
  }

  // 構造ズレ対策:
  // ただし 7枠番, 8馬番, 9オッズ, 10人気 は危険なので除外。
  for (let i = 0; i < cols.length; i++) {
    if (i === 7 || i === 8 || i === 9 || i === 10) continue;

    const raw = cols[i];
    const v = normalizeFinishValue(raw);

    if (!v) continue;

    // 日付・開催回・R番号・頭数などの混入防止
    if (i <= 6) continue;

    return v;
  }

  return "";
}

function parseRecentFinishesFromRow(tr) {
  // 前走着順取得 v2
  // 方針：td配列化 → 末尾側の候補列だけを見る → 着順らしい値を最大3つ取得
  // 前走/前2走/前3走が取れない場合は空欄。誤取得より空欄優先。
  const tdHtmls = [...String(tr || "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => x[1]);

  if (!tdHtmls.length) {
    return { last1: "", last2: "", last3: "" };
  }

  const cols = tdHtmls
    .map(x => cleanText(stripTags(x)))
    .map(x => x.replace(/[()（）]/g, "").replace(/着$/g, "").trim());

  // netkeibaの出馬表は、近走/成績系の列が後方寄りに出るケースが多い。
  // ただし馬体重・斤量・年齢・人気などの数字も混ざるため、末尾全部ではなく候補幅を絞る。
  const candidateRanges = [
    cols.slice(-10, -1),
    cols.slice(-12, -1),
    cols.slice(-14, -1),
    cols.slice(-10),
    cols
  ];

  for (const range of candidateRanges) {
    const finishes = [];

    for (const raw of range) {
      const v = normalizeFinishValue(raw);
      if (v) finishes.push(v);
      if (finishes.length >= 3) break;
    }

    if (finishes.length >= 3 && looksSafeFinishSet(finishes)) {
      return {
        last1: finishes[0] || "",
        last2: finishes[1] || "",
        last3: finishes[2] || ""
      };
    }
  }

  // HTML内のclass名が近走系/着順系のセルだけを狙う保険
  const classTargetCells = [...String(tr || "").matchAll(
    /<td[^>]*(?:Result|Chakujun|Past|Recent|RaceData|Order|Rank|txt_r)[^>]*>([\s\S]*?)<\/td>/gi
  )].map(x => normalizeFinishValue(stripTags(x[1]))).filter(Boolean);

  if (classTargetCells.length >= 3 && looksSafeFinishSet(classTargetCells)) {
    return {
      last1: classTargetCells[0] || "",
      last2: classTargetCells[1] || "",
      last3: classTargetCells[2] || ""
    };
  }

  return { last1: "", last2: "", last3: "" };
}

function normalizeFinishValue(raw) {
  let t = cleanText(String(raw || ""))
    .replace(/[()（）]/g, "")
    .replace(/着$/g, "")
    .replace(/^\s+|\s+$/g, "");

  if (!t || t === "-" || t === "－" || t === "—") return "";

  // 中止・除外・取消はアプリ仕様に合わせて0扱い
  if (/^(中止|除外|取消|取|除|中|競走中止)$/.test(t)) return "0";

  // 「1着」「12着」など
  const mFinish = t.match(/^(\d{1,2})着$/);
  if (mFinish) {
    const n = Number(mFinish[1]);
    if (n >= 1 && n <= 18) return String(n);
  }

  // 数字単独のみ。斤量55.0、距離1600、日付などは除外。
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    if (n >= 1 && n <= 18) return String(n);
  }

  return "";
}

function looksSafeFinishSet(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return false;

  const first3 = arr.slice(0, 3);

  // 全部空ではない
  if (first3.every(x => !x)) return false;

  // 0〜18のみ
  for (const v of first3) {
    if (!/^\d{1,2}$/.test(String(v))) return false;
    const n = Number(v);
    if (n < 0 || n > 18) return false;
  }

  // 近走3つとして明らかに不自然なケースは除外しない。
  // 空欄より取得を優先するが、日付や距離は normalizeFinishValue で除外済み。
  return true;
}

function calcJraFrame(no, headcount) {
  const n = Number(no);
  const h = Number(headcount);
  if (!n || !h) return "";
  if (h <= 8) return String(n);
  if (h === 9) return n <= 7 ? String(n) : "8";
  if (h === 10) {
    if (n <= 6) return String(n);
    if (n <= 8) return "7";
    return "8";
  }
  if (h === 11) {
    if (n <= 5) return String(n);
    if (n <= 7) return "6";
    if (n <= 9) return "7";
    return "8";
  }
  if (h === 12) {
    if (n <= 4) return String(n);
    if (n <= 6) return "5";
    if (n <= 8) return "6";
    if (n <= 10) return "7";
    return "8";
  }
  if (h === 13) {
    if (n <= 3) return String(n);
    if (n <= 5) return "4";
    if (n <= 7) return "5";
    if (n <= 9) return "6";
    if (n <= 11) return "7";
    return "8";
  }
  if (h === 14) {
    if (n <= 2) return String(n);
    if (n <= 4) return "3";
    if (n <= 6) return "4";
    if (n <= 8) return "5";
    if (n <= 10) return "6";
    if (n <= 12) return "7";
    return "8";
  }
  if (h === 15) {
    if (n <= 1) return "1";
    if (n <= 3) return "2";
    if (n <= 5) return "3";
    if (n <= 7) return "4";
    if (n <= 9) return "5";
    if (n <= 11) return "6";
    if (n <= 13) return "7";
    return "8";
  }
  if (n <= 2) return "1";
  if (n <= 4) return "2";
  if (n <= 6) return "3";
  if (n <= 8) return "4";
  if (n <= 10) return "5";
  if (n <= 12) return "6";
  if (h === 16) return n <= 14 ? "7" : "8";
  if (h === 17) return n <= 15 ? "7" : "8";
  return n <= 15 ? "7" : "8";
}

async function getResult(raceId) {
  const fetched = await fetchHtml(`https://race.netkeiba.com/race/result.html?race_id=${raceId}`);
  const html = fetched.html || "";

  const result = { first: "", second: "", third: "", umaren: "", umarenPay: "", sanrenpuku: "", sanrenpukuPay: "" };

  if (!html || !html.includes("Result")) return result;

  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];

  for (const row of rows) {
    const rowHtml = row[1];
    const text = stripTags(rowHtml);

    const rankMatch = text.match(/^([123])\s+/) || text.match(/\s([123])\s+\d{1,2}\s+/);
    if (!rankMatch) continue;

    const rank = rankMatch[1];

    let horseNo = cleanText(stripTags(rowHtml.match(/<td[^>]*Umaban[^>]*>([\s\S]*?)<\/td>/i)?.[1] || "")).replace(/\D/g, "");

    if (!horseNo) {
      const nums = [...text.matchAll(/\b(\d{1,2})\b/g)].map(x => x[1]);
      horseNo = nums.find(n => Number(n) >= 1 && Number(n) <= 18) || "";
    }

    if (rank === "1") result.first = horseNo;
    if (rank === "2") result.second = horseNo;
    if (rank === "3") result.third = horseNo;
  }

  const pageText = stripTags(html);

  const umaren = pageText.match(/馬連\s+(\d+\s*-\s*\d+)\s+([\d,]+)円/);
  if (umaren) {
    result.umaren = umaren[1].replace(/\s/g, "");
    result.umarenPay = umaren[2].replace(/,/g, "");
  }

  const sanrenpuku = pageText.match(/3連複\s+(\d+\s*-\s*\d+\s*-\s*\d+)\s+([\d,]+)円/);
  if (sanrenpuku) {
    result.sanrenpuku = sanrenpuku[1].replace(/\s/g, "");
    result.sanrenpukuPay = sanrenpuku[2].replace(/,/g, "");
  }

  return result;
}

function validateRacePayload(race, horses, result) {
  const warnings = [];
  if (!race.raceId) warnings.push("raceId empty");
  if (!race.raceName) warnings.push("raceName empty");
  if (!race.surface) warnings.push("surface empty");
  if (!race.distance) warnings.push("distance empty");
  if (!horses.length) warnings.push("horses empty");

  const noSet = new Set();
  for (const h of horses) {
    if (!h.no) warnings.push(`horse no empty: ${h.name || "unknown"}`);
    if (!h.name) warnings.push(`horse name empty: no ${h.no || "?"}`);
    if (String(h.name).includes("<") || String(h.name).includes(">")) warnings.push(`horse name html mixed: no ${h.no}`);
    if (h.no) {
      if (noSet.has(h.no)) warnings.push(`duplicate horse no: ${h.no}`);
      noSet.add(h.no);
    }
  }

  if (String(race.headcount || "") !== String(horses.length)) {
    warnings.push(`headcount mismatch: race=${race.headcount}, horses=${horses.length}`);
  }

  return { ok: warnings.length === 0, warnings, horseCount: horses.length, resultExists: !!(result.first || result.second || result.third) };
}

function stripTags(s) {
  return cleanText(String(s || "")
    .replace(/<script[^]*?<\/script>/g, " ")
    .replace(/<style[^]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " "));
}

function cleanText(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
