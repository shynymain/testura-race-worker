// testura-race-worker
// 最終API版：race_id取得 + EUC-JP取得 + 馬名HTMLタグ除去 + /api/race/odds/tan オッズ取得

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
        version: "odds-final-api-20240501",
        endpoints: [
          "/api/debug-list?date=2026-05-02",
          "/api/debug-odds?raceId=202608030309",
          "/api/race?date=2026-05-02&place=京都&raceNo=9"
        ]
      });
    }

    if (url.pathname === "/api/debug-list") {
      const date = url.searchParams.get("date");
      if (!date) return json({ ok: false, error: "date required" });
      return json(await getRaceList(date, true));
    }

    if (url.pathname === "/api/debug-odds") {
      const raceId = url.searchParams.get("raceId");
      if (!raceId) return json({ ok: false, error: "raceId required" });
      const odds = await getOddsFinal(raceId, true);
      return json({ ok: true, raceId, odds });
    }

    if (url.pathname === "/api/race") {
      const date = url.searchParams.get("date");
      const place = url.searchParams.get("place");
      const raceNo = normalizeRaceNo(url.searchParams.get("raceNo"));

      if (!date || !place || !raceNo) {
        return json({ ok: false, error: "date/place/raceNo required" });
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
          count: races.length,
          foundRaces: races
        });
      }

      const race = await getRaceBasic(target.raceId, date, place, raceNo);
      const horses = await getShutubaAndOdds(target.raceId);
      const result = await getResult(target.raceId);

      return json({
        ok: true,
        race: {
          ...race,
          date: date.replaceAll("-", "/"),
          place,
          raceNo: String(Number(raceNo)),
          raceId: target.raceId,
          raceName: race.raceName || target.raceName || ""
        },
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

function commonHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": "https://race.netkeiba.com/"
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

  return { ok: res.ok, status: res.status, url: targetUrl, html };
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
      return { ok: true, date, sourceUrl: targetUrl, status: fetched.status, count: races.length, races };
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

  return { ok: true, date, status: "no races parsed", count: 0, races: [], debug: includeDebug ? lastInfo : undefined };
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
  const code = raceId.slice(4, 6);
  const map = {
    "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
    "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉"
  };
  return map[code] || "";
}

function guessRaceName(text, raceNo) {
  const t = cleanText(text);
  const m = t.match(new RegExp(`${raceNo}R\\s+([^\\s]+)`));
  return m ? m[1] : "";
}

async function getRaceBasic(raceId, date, place, raceNo) {
  const fetched = await fetchHtml(`https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`);
  const html = fetched.html || "";

  const title = cleanText(stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""));
  const h1 = cleanText(stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ""));
  const raceName = h1 || title.split("|")[0].trim();

  const infoText = stripTags(html);

  const surface = infoText.includes("ダ") ? "ダート" : (infoText.includes("芝") ? "芝" : "");
  const distMatch = infoText.match(/(芝|ダ|ダート)[^\d]{0,8}(\d{3,4})m/);
  const distance = distMatch ? distMatch[2] : "";

  let grade = "";
  if (infoText.includes("G1")) grade = "G1";
  else if (infoText.includes("G2")) grade = "G2";
  else if (infoText.includes("G3")) grade = "G3";
  else if (infoText.includes("3勝クラス")) grade = "3勝";
  else if (infoText.includes("2勝クラス")) grade = "2勝";
  else if (infoText.includes("1勝クラス")) grade = "1勝";
  else if (infoText.includes("オープン")) grade = "OP";

  let condition = "定量";
  if (infoText.includes("ハンデ")) condition = "ハンデ";
  else if (infoText.includes("別定")) condition = "別定";

  const ageMatch = infoText.match(/([2-5]歳以上|[2-4]歳)/);
  const age = ageMatch ? ageMatch[1] : "";

  const sex = infoText.includes("牝") ? "牝馬" : "混合";

  return { date, place, raceNo, raceName, surface, distance, grade, condition, age, sex };
}

async function getShutubaAndOdds(raceId) {
  const shutuba = await fetchHtml(`https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`);
  const html = shutuba.html || "";

  const oddsData = await getOddsFinal(raceId, false);
  const oddsMap = oddsData.map || oddsData || {};

  const horses = [];
  const rowRegex = /<tr[^>]*HorseList[^>]*>([\s\S]*?)<\/tr>/g;
  const rows = [...html.matchAll(rowRegex)];

  for (const row of rows) {
    const tr = row[1];

    const no = cleanText(
      stripTags(tr.match(/<td[^>]*Umaban[^>]*>([\s\S]*?)<\/td>/i)?.[1] || "")
    ).replace(/\D/g, "");

    const frame = cleanText(
      stripTags(tr.match(/<td[^>]*Waku[^>]*>([\s\S]*?)<\/td>/i)?.[1] || "")
    ).replace(/\D/g, "");

    const nameRaw =
      tr.match(/<span[^>]*HorseName[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
      tr.match(/class=["']HorseName["'][\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
      "";

    const name = cleanText(stripTags(nameRaw));

    let odds = no && oddsMap[no] ? oddsMap[no] : "";

    odds = cleanText(odds).replace(/[^\d.]/g, "");

    if (no || name) horses.push({ frame, no, name, odds, popularity: "" });
  }

  assignPopularity(horses);
  return horses.sort((a, b) => Number(a.no) - Number(b.no));
}

async function getOddsFinal(raceId, includeDebug = false) {
  const apiUrls = [
    `https://race.netkeiba.com/api/race/odds/tan?race_id=${raceId}`,
    `https://race.netkeiba.com/api/race/odds/tansho?race_id=${raceId}`,
    `https://race.netkeiba.com/api/odds/tan?race_id=${raceId}`
  ];

  const tried = {};

  for (const apiUrl of apiUrls) {
    try {
      const res = await fetch(apiUrl, {
        headers: {
          ...commonHeaders(),
          "Accept": "application/json,text/plain,*/*",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": `https://race.netkeiba.com/odds/index.html?race_id=${raceId}`
        }
      });

      const text = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }

      const map = parseOddsJson(parsed, text);

      if (Object.keys(map).length > 0) {
        return includeDebug
          ? { sourceUrl: apiUrl, status: res.status, count: Object.keys(map).length, map, rawHead: text.slice(0, 500) }
          : { map };
      }

      tried[apiUrl] = { status: res.status, length: text.length, head: text.slice(0, 300) };
    } catch (e) {
      tried[apiUrl] = { error: String(e) };
    }
  }

  return includeDebug ? { count: 0, map: {}, tried } : { map: {} };
}

function parseOddsJson(parsed, rawText) {
  const map = {};

  function put(no, odds) {
    no = String(no || "").replace(/\D/g, "");
    odds = String(odds || "").replace(/[^\d.]/g, "");
    if (no && odds && Number(no) >= 1 && Number(no) <= 18 && !map[no]) {
      map[no] = odds;
    }
  }

  function walk(v) {
    if (!v) return;

    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }

    if (typeof v === "object") {
      const no =
        v.horse_no ?? v.umaban ?? v.no ?? v.num ?? v.number ??
        v.horseNumber ?? v.HorseNum ?? v.Umaban ?? v.horse_num ?? v.horseNo;

      const odds =
        v.odds ?? v.win_odds ?? v.tan_odds ?? v.TanOdds ??
        v.ninki_odds ?? v.value ?? v.o ?? v.tan;

      if (no != null && odds != null) put(no, odds);

      for (const key of Object.keys(v)) {
        if (/^\d{1,2}$/.test(key) && typeof v[key] !== "object") put(key, v[key]);
        walk(v[key]);
      }
    }
  }

  walk(parsed);

  const patterns = [
    /["'](?:horse_no|umaban|no|horse_num|horseNo)["']\s*:\s*["']?(\d{1,2})["']?[\s\S]{0,120}?["'](?:odds|win_odds|tan_odds|tan)["']\s*:\s*["']?(\d{1,3}\.\d)["']?/gi,
    /["'](?:odds|win_odds|tan_odds|tan)["']\s*:\s*["']?(\d{1,3}\.\d)["']?[\s\S]{0,120}?["'](?:horse_no|umaban|no|horse_num|horseNo)["']\s*:\s*["']?(\d{1,2})["']?/gi,
    /["'](\d{1,2})["']\s*:\s*["']?(\d{1,3}\.\d)["']?/g
  ];

  for (let i = 0; i < patterns.length; i++) {
    const re = patterns[i];
    let m;
    while ((m = re.exec(rawText || "")) !== null) {
      if (i === 1) put(m[2], m[1]);
      else put(m[1], m[2]);
    }
  }

  return map;
}

function assignPopularity(horses) {
  const valid = horses
    .filter(h => h.odds && h.odds !== "0")
    .map(h => ({ no: h.no, odds: Number(h.odds) }))
    .sort((a, b) => a.odds - b.odds);

  let rank = 1;
  for (let i = 0; i < valid.length; i++) {
    if (i > 0 && valid[i].odds !== valid[i - 1].odds) rank = i + 1;
    const h = horses.find(x => x.no === valid[i].no);
    if (h) h.popularity = String(rank);
  }
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

  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];

  for (const row of rows) {
    const text = stripTags(row[1]);
    const chakujun = text.match(/^([123])\s+/);
    if (!chakujun) continue;

    const nums = [...text.matchAll(/\b(\d{1,2})\b/g)].map(x => x[1]);
    const horseNo = nums.find(n => Number(n) >= 1 && Number(n) <= 18) || "";

    if (chakujun[1] === "1") result.first = horseNo;
    if (chakujun[1] === "2") result.second = horseNo;
    if (chakujun[1] === "3") result.third = horseNo;
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
