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
        endpoints: [
          "/api/health",
          "/api/debug-list?date=2026-05-02",
          "/api/race?date=2026-05-02&place=京都&raceNo=9"
        ]
      });
    }

    if (url.pathname === "/api/debug-list") {
      const date = url.searchParams.get("date");
      if (!date) return json({ ok: false, error: "date required" });

      const races = await getRaceList(date);
      return json({
        ok: true,
        date,
        count: races.length,
        races
      });
    }

    if (url.pathname === "/api/race") {
      const date = url.searchParams.get("date");
      const place = url.searchParams.get("place");
      const raceNo = normalizeRaceNo(url.searchParams.get("raceNo"));

      if (!date || !place || !raceNo) {
        return json({
          ok: false,
          error: "date/place/raceNo required"
        });
      }

      const races = await getRaceList(date);

      const target = races.find(r =>
        r.place.includes(place) &&
        String(Number(r.raceNo)) === String(Number(raceNo))
      );

      if (!target) {
        return json({
          ok: false,
          error: "race_id not found",
          input: { date, place, raceNo },
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

    return json({
      ok: false,
      error: "not found"
    }, 404);
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

async function fetchHtml(targetUrl) {
  const res = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
    }
  });

  const buf = await res.arrayBuffer();

  try {
    return new TextDecoder("EUC-JP").decode(buf);
  } catch {
    try {
      return new TextDecoder("shift_jis").decode(buf);
    } catch {
      return new TextDecoder("utf-8").decode(buf);
    }
  }
}

async function getRaceList(date) {
  const ymd = date.replaceAll("-", "").replaceAll("/", "");

  const html = await fetchHtml(
    `https://race.netkeiba.com/top/race_list.html?kaisai_date=${ymd}`
  );

  const placeNames = [
    "札幌", "函館", "福島", "新潟", "東京",
    "中山", "中京", "京都", "阪神", "小倉"
  ];

  const placeBlocks = [];

  for (const place of placeNames) {
    const idx = html.indexOf(place);
    if (idx >= 0) {
      placeBlocks.push({ place, idx });
    }
  }

  placeBlocks.sort((a, b) => a.idx - b.idx);

  const races = [];

  for (let i = 0; i < placeBlocks.length; i++) {
    const start = placeBlocks[i].idx;
    const end = placeBlocks[i + 1]?.idx ?? html.length;
    const block = html.slice(start, end);
    const place = placeBlocks[i].place;

    const links = [...block.matchAll(/race_id=(\d{12})/g)];

    for (const m of links) {
      const raceId = m[1];

      if (races.some(r => r.raceId === raceId)) continue;

      const raceNo = String(Number(raceId.slice(-2)));

      const around = block.slice(
        Math.max(0, m.index - 300),
        Math.min(block.length, m.index + 500)
      );

      const aroundText = cleanText(
        around
          .replace(/<script[^]*?<\/script>/g, "")
          .replace(/<style[^]*?<\/style>/g, "")
          .replace(/<[^>]+>/g, " ")
      );

      races.push({
        place,
        raceNo,
        raceId,
        raceName: guessRaceName(aroundText, raceNo)
      });
    }
  }

  return races.sort((a, b) => {
    if (a.place !== b.place) return a.place.localeCompare(b.place, "ja");
    return Number(a.raceNo) - Number(b.raceNo);
  });
}

function guessRaceName(text, raceNo) {
  const t = cleanText(text);
  const m = t.match(new RegExp(`${raceNo}R\\s+([^\\s]+)`));
  return m ? m[1] : "";
}

async function getRaceBasic(raceId, date, place, raceNo) {
  const html = await fetchHtml(
    `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`
  );

  const title = cleanText(
    html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || ""
  );

  const h1 = cleanText(
    html.match(/<h1[^>]*>([^<]*)<\/h1>/i)?.[1] || ""
  );

  const raceName = h1 || title.split("|")[0].trim();

  const infoText = cleanText(
    html
      .replace(/<script[^]*?<\/script>/g, "")
      .replace(/<style[^]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, " ")
  );

  const surface = infoText.includes("ダ")
    ? "ダート"
    : infoText.includes("芝")
      ? "芝"
      : "";

  const distMatch = infoText.match(/(芝|ダ|ダート)[^\d]{0,5}(\d{3,4})m/);
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

async function getShutubaAndOdds(raceId) {
  const html = await fetchHtml(
    `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`
  );

  const horses = [];
  const rowRegex = /<tr[^>]*HorseList[^>]*>([\s\S]*?)<\/tr>/g;
  const rows = [...html.matchAll(rowRegex)];

  for (const row of rows) {
    const tr = row[1];

    const no = cleanText(
      tr.match(/<td[^>]*Umaban[^>]*>([\s\S]*?)<\/td>/i)?.[1] || ""
    ).replace(/\D/g, "");

    const frame = cleanText(
      tr.match(/<td[^>]*Waku[^>]*>([\s\S]*?)<\/td>/i)?.[1] || ""
    ).replace(/\D/g, "");

    const name = cleanText(
      tr.match(/<span[^>]*HorseName[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
      tr.match(/class="HorseName"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
      ""
    );

    let odds = cleanText(
      tr.match(/<td[^>]*Odds[^>]*>([\s\S]*?)<\/td>/i)?.[1] || ""
    ).replace(/[^\d.]/g, "");

    if (!odds) {
      odds = cleanText(
        tr.match(/data-odds="([^"]+)"/i)?.[1] || ""
      ).replace(/[^\d.]/g, "");
    }

    if (no || name) {
      horses.push({
        frame,
        no,
        name,
        odds,
        popularity: ""
      });
    }
  }

  assignPopularity(horses);

  return horses.sort((a, b) => Number(a.no) - Number(b.no));
}

function assignPopularity(horses) {
  const valid = horses
    .filter(h => h.odds && h.odds !== "0")
    .map(h => ({
      no: h.no,
      odds: Number(h.odds)
    }))
    .sort((a, b) => a.odds - b.odds);

  let rank = 1;

  for (let i = 0; i < valid.length; i++) {
    if (i > 0 && valid[i].odds !== valid[i - 1].odds) {
      rank = i + 1;
    }

    const h = horses.find(x => x.no === valid[i].no);
    if (h) h.popularity = String(rank);
  }
}

async function getResult(raceId) {
  const html = await fetchHtml(
    `https://race.netkeiba.com/race/result.html?race_id=${raceId}`
  );

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
    const text = cleanText(row[1].replace(/<[^>]+>/g, " "));
    const chakujun = text.match(/^([123])\s+/);

    if (!chakujun) continue;

    const nums = [...text.matchAll(/\b(\d{1,2})\b/g)].map(x => x[1]);
    const horseNo = nums.find(n => Number(n) >= 1 && Number(n) <= 18) || "";

    if (chakujun[1] === "1") result.first = horseNo;
    if (chakujun[1] === "2") result.second = horseNo;
    if (chakujun[1] === "3") result.third = horseNo;
  }

  const pageText = cleanText(
    html
      .replace(/<script[^]*?<\/script>/g, "")
      .replace(/<style[^]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, " ")
  );

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

function cleanText(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
