// testura-race-worker 検証用
// 目的：netkeibaから「基本・枠・馬番・馬名・前走着順候補・結果」を取得
// 注意：オッズ取得は完全に外す。odds/popularity は空で返す。

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return json({
        ok: true,
        version: "verify-no-odds-20240501",
        purpose: "netkeiba basic/shutuba/result verification. odds disabled.",
        endpoints: [
          "/api/health",
          "/api/debug-list?date=2026-05-02",
          "/api/race?date=2026-05-02&place=京都&raceNo=9",
          "/api/race?date=2026-05-03&place=京都&raceNo=11"
        ]
      });
    }

    if (url.pathname === "/api/debug-list") {
      const date = url.searchParams.get("date");
      if (!date) return json({ ok: false, error: "date required" }, 400);

      const data = await getRaceList(date, true);
      return json(data);
    }

    if (url.pathname === "/api/race") {
      const date = url.searchParams.get("date");
      const place = url.searchParams.get("place");
      const raceNo = normalizeRaceNo(url.searchParams.get("raceNo"));

      if (!date || !place || !raceNo) {
        return json({
          ok: false,
          error: "date/place/raceNo required"
        }, 400);
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
        raceName: raceBasic.raceName || target.raceName || "",
        headcount: String(horses.length)
      };

      const validation = validateRacePayload(race, horses, result);

      return json({
        ok: true,
        mode: "verify-no-odds",
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
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8"
    }
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
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml,application/json,text/plain,*/*;q=0.9",
    "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": referer
  };
}

async function fetchHtml(targetUrl) {
  const res = await fetch(targetUrl, { headers: commonHeaders() });
  const buffer = await res.arrayBuffer();

  let html = "";
  try {
    html = new TextDecoder("EUC-JP").decode(buffer);
  } catch {
    try {
      html = new TextDecoder("shift_jis").decode(buffer);
    } catch {
      html = new TextDecoder("utf-8").decode(buffer);
    }
  }

  return {
    ok: res.ok,
    status: res.status,
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

    races.push({
      place,
      raceNo,
      raceId,
      raceName: guessRaceName(aroundText, raceNo)
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
  // netkeiba/JRA系: YYYY + 場コード2桁 + 開催回2桁 + 開催日2桁 + R2桁 の想定
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

function guessRaceName(text, raceNo) {
  const t = cleanText(text);
  const patterns = [
    new RegExp(`${raceNo}R\\s+([^\\s]+)`),
    new RegExp(`${raceNo}\\s*R\\s+([^\\s]+)`)
  ];

  for (const p of patterns) {
    const m = t.match(p);
    if (m && m[1]) return m[1];
  }

  return "";
}

async function getRaceBasic(raceId, date, place, raceNo) {
  const fetched = await fetchHtml(`https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`);
  const html = fetched.html || "";

  const title = cleanText(stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""));
  const h1 = cleanText(stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ""));
  const raceName = cleanupRaceName(h1 || title.split("|")[0].trim());

  const infoText = stripTags(html);

  const surface = parseSurface(infoText);
  const distance = parseDistance(infoText);
  const grade = parseGrade(infoText);
  const condition = parseCondition(infoText);
  const age = parseAge(infoText);
  const sex = parseSex(infoText);

  return {
    date,
    place,
    raceNo,
    raceName,
    surface,
    distance,
    grade,
    condition,
    age,
    sex
  };
}

function cleanupRaceName(s) {
  return cleanText(String(s || "")
    .replace(/出馬表.*$/, "")
    .replace(/結果.*$/, "")
    .replace(/オッズ.*$/, "")
  );
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

    const no = cleanText(
      stripTags(tr.match(/<td[^>]*Umaban[^>]*>([\s\S]*?)<\/td>/i)?.[1] || "")
    ).replace(/\D/g, "");

    const frameByHtml = cleanText(
      stripTags(tr.match(/<td[^>]*Waku[^>]*>([\s\S]*?)<\/td>/i)?.[1] || "")
    ).replace(/\D/g, "");

    const frame = frameByHtml || calcJraFrame(no, rows.length);

    const nameRaw =
      tr.match(/<span[^>]*HorseName[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
      tr.match(/class=["']HorseName["'][\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
      "";

    const name = cleanText(stripTags(nameRaw));

    const last = parseRecentFinishesFromRow(tr);

    if (no || name) {
      horses.push({
        frame,
        no,
        name,
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

function parseRecentFinishesFromRow(tr) {
  // 検証用：HTMLに着順らしき数字がある場合だけ候補取得。
  // 誤取得防止のため、不明なら空欄。
  const text = stripTags(tr);

  // よくある「前走」「近走」セル全体から、着順らしい 1〜2桁/中/除/取 を拾う。
  // ただし騎手・斤量・日付が混ざるので、最初は弱めにする。
  const raceResultLike = [];

  const tokens = text.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const t = token.replace(/[()（）]/g, "");
    if (/^(中止|除外|取消|取|除|中)$/.test(t)) {
      raceResultLike.push("0");
    } else if (/^\d{1,2}$/.test(t)) {
      const n = Number(t);
      if (n >= 1 && n <= 18) raceResultLike.push(String(n));
    }
  }

  // 混入が多いため、取れすぎる場合は使わない
  if (raceResultLike.length < 3 || raceResultLike.length > 12) {
    return { last1: "", last2: "", last3: "" };
  }

  // 末尾側に近走着順が出ることが多いため、最後の3つを候補にする
  const last3Tokens = raceResultLike.slice(-3);

  return {
    // アプリ仕様：last1=前走, last2=前2走, last3=前3走
    last1: last3Tokens[2] || "",
    last2: last3Tokens[1] || "",
    last3: last3Tokens[0] || ""
  };
}

function calcJraFrame(no, headcount) {
  const n = Number(no);
  const h = Number(headcount);
  if (!n || !h) return "";

  // JRAの一般的な枠順配分に近い簡易版。
  // HTMLから枠が取れない時だけ使うfallback。
  if (h <= 8) return String(n);

  if (h === 9) {
    if (n <= 7) return String(n);
    return "8";
  }

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

  // 16〜18頭
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

  const result = {
    first: "",
    second: "",
    third: "",
    umaren: "",
    umarenPay: "",
    sanrenpuku: "",
    sanrenpukuPay: ""
  };

  if (!html || !html.includes("Result")) {
    return result;
  }

  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];

  for (const row of rows) {
    const rowHtml = row[1];
    const text = stripTags(rowHtml);

    const rankMatch =
      text.match(/^([123])\s+/) ||
      text.match(/\s([123])\s+\d{1,2}\s+/);

    if (!rankMatch) continue;

    const rank = rankMatch[1];

    // Result_Num / Umabanなどから馬番を優先取得
    let horseNo =
      cleanText(stripTags(rowHtml.match(/<td[^>]*Umaban[^>]*>([\s\S]*?)<\/td>/i)?.[1] || "")).replace(/\D/g, "");

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
    if (String(h.name).includes("<") || String(h.name).includes(">")) {
      warnings.push(`horse name html mixed: no ${h.no}`);
    }
    if (h.no) {
      if (noSet.has(h.no)) warnings.push(`duplicate horse no: ${h.no}`);
      noSet.add(h.no);
    }
  }

  if (String(race.headcount || "") !== String(horses.length)) {
    warnings.push(`headcount mismatch: race=${race.headcount}, horses=${horses.length}`);
  }

  return {
    ok: warnings.length === 0,
    warnings,
    horseCount: horses.length,
    resultExists: !!(result.first || result.second || result.third)
  };
}

function stripTags(s) {
  return cleanText(
    String(s || "")
      .replace(/<script[^]*?<\/script>/g, " ")
      .replace(/<style[^]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " ")
  );
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
