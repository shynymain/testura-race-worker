// Fixed Worker with race_list_sub

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
          "/api/debug-list?date=2026-05-02",
          "/api/race?date=2026-05-02&place=京都&raceNo=9"
        ]
      });
    }

    if (url.pathname === "/api/debug-list") {
      const date = url.searchParams.get("date");
      const races = await getRaceList(date);
      return json({ ok: true, count: races.length, races });
    }

    return json({ ok: false });
  }
};

function json(data) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}

async function getRaceList(date) {
  const ymd = date.replaceAll("-", "");
  const url = `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${ymd}`;

  const html = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://race.netkeiba.com/"
    }
  }).then(r => r.text());

  const races = [];
  const matches = [...html.matchAll(/race_id=(\d{12})/g)];

  for (const m of matches) {
    const raceId = m[1];
    const raceNo = String(Number(raceId.slice(-2)));
    const around = html.slice(m.index - 200, m.index + 200);

    let place = "";
    if (around.includes("京都")) place = "京都";
    else if (around.includes("東京")) place = "東京";
    else if (around.includes("新潟")) place = "新潟";
    else if (around.includes("阪神")) place = "阪神";

    if (!place) continue;

    races.push({ place, raceNo, raceId });
  }

  return races;
}
