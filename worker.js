const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const PLACE_CODES = {
  "札幌":"01","函館":"02","福島":"03","新潟":"04","東京":"05","中山":"06",
  "中京":"07","京都":"08","阪神":"09","小倉":"10"
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") return json({ ok:true, service:"testura-race-worker" });
      if (url.pathname === "/api/race") {
        const date = url.searchParams.get("date") || "";
        const place = url.searchParams.get("place") || "";
        const raceNo = normalizeRaceNo(url.searchParams.get("raceNo") || "");
        const forcedRaceId = url.searchParams.get("raceId") || "";
        if ((!date || !place || !raceNo) && !forcedRaceId) return json({ ok:false, error:"date/place/raceNo are required" }, 400);

        const raceId = forcedRaceId || await resolveRaceId(date, place, raceNo);
        if (!raceId) return json({ ok:false, error:"race_id not found", input:{date,place,raceNo} }, 404);

        const [basic, horses, result] = await Promise.all([
          fetchBasic(raceId, date, place, raceNo),
          fetchHorsesAndOdds(raceId),
          fetchResult(raceId)
        ]);

        const race = {
          date: toSlashDate(date || basic.date),
          place: place || basic.place,
          raceNo: raceNo || basic.raceNo,
          raceId,
          raceName: basic.raceName || "",
          surface: basic.surface || "",
          distance: basic.distance || "",
          grade: basic.grade || "",
          condition: basic.condition || "",
          age: basic.age || "",
          sex: basic.sex || "",
          headcount: String(horses.length || basic.headcount || "")
        };
        return json({ ok:true, race, horses, result });
      }
      return json({ ok:true, endpoints:["/api/health","/api/race?date=2026-05-02&place=京都&raceNo=9"] });
    } catch (e) {
      return json({ ok:false, error:e.message, stack:String(e.stack || "").slice(0,800) }, 500);
    }
  }
};

async function resolveRaceId(date, place, raceNo) {
  const ymd = compactDate(date);
  const listUrl = `https://race.netkeiba.com/top/race_list.html?kaisai_date=${ymd}`;
  const html = await fetchText(listUrl);
  const placeCode = PLACE_CODES[place];
  const rr = String(raceNo).padStart(2, "0");
  const direct = html.match(new RegExp(`race_id=(${ymd}\\d{2}${placeCode || "\\d{2}"}${rr})`, "g"));
  if (direct && direct.length) {
    const ids = direct.map(x => (x.match(/race_id=(\d+)/)||[])[1]).filter(Boolean);
    if (ids.length === 1) return ids[0];
    if (placeCode) return ids.find(id => id.slice(8,10) === placeCode && id.slice(10,12) === rr) || ids[0];
  }

  const anchors = [...html.matchAll(/href=["'][^"']*race_id=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/g)];
  for (const a of anchors) {
    const id = a[1];
    const txt = strip(a[2]);
    if (id.startsWith(ymd) && (!placeCode || id.slice(8,10) === placeCode) && id.slice(10,12) === rr) return id;
    if (txt.includes(place) && txt.includes(`${Number(raceNo)}R`)) return id;
  }
  return null;
}

async function fetchBasic(raceId, date, place, raceNo) {
  const html = await fetchText(`https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`);
  const title = strip((html.match(/<title>([\s\S]*?)<\/title>/i)||[])[1] || "");
  const h1 = strip((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)||[])[1] || "");
  const raceName = cleanupRaceName(h1 || title);
  const dataIntro = strip((html.match(/<div[^>]+class=["'][^"']*RaceData01[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)||[])[1] || "");
  const data02 = strip((html.match(/<div[^>]+class=["'][^"']*RaceData02[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)||[])[1] || "");
  const surface = dataIntro.includes("ダ") ? "ダート" : (dataIntro.includes("芝") ? "芝" : "");
  const distance = (dataIntro.match(/(\d{3,4})m/) || [])[1] || "";
  const grade = detectGrade(raceName + " " + data02);
  const condition = data02.includes("ハンデ") ? "ハンデ" : (data02.includes("別定") ? "別定" : "定量");
  const age = (data02.match(/(\d歳以上|\d歳|\d歳未勝利|\d歳オープン|\d歳新馬)/)||[])[1] || "";
  const sex = data02.includes("牝") ? "牝馬" : "混合";
  return { date: toSlashDate(date), place, raceNo, raceName, surface, distance, grade, condition, age, sex };
}

async function fetchHorsesAndOdds(raceId) {
  const html = await fetchText(`https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`);
  const rows = [...html.matchAll(/<tr[^>]*class=["'][^"']*(?:HorseList|Shutuba_Table_Row)[^"']*["'][^>]*>([\s\S]*?)<\/tr>/g)];
  const horses = [];
  for (const m of rows) {
    const row = m[1];
    const tds = [...row.matchAll(/<td[^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/td>/g)].map(x => ({ cls:x[1], text:strip(x[2]), html:x[2] }));
    const name = strip((row.match(/<span[^>]*class=["'][^"']*HorseName[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)||row.match(/<a[^>]+href=["'][^"']*horse[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)||[])[1] || "");
    const no = pickByClass(tds, /Umaban|Horse_Num|Txt_C/) || "";
    const frame = pickByClass(tds, /Waku|Frame/) || calcFrame(no, rows.length || 18);
    let odds = pickByClass(tds, /Odds|Popular/);
    if (!odds) odds = strip((row.match(/data-odds=["']([^"']+)["']/i)||[])[1] || "");
    const popularity = pickByClass(tds, /Ninki|Popular/);
    if (name || no) horses.push({ frame:String(frame||""), no:String(no||""), name, odds:cleanOdds(odds), popularity:cleanNumber(popularity) });
  }
  const dedup = [];
  const seen = new Set();
  for (const h of horses) {
    const key = h.no || h.name;
    if (!key || seen.has(key)) continue;
    seen.add(key); dedup.push(h);
  }
  dedup.sort((a,b)=>Number(a.no||999)-Number(b.no||999));
  return dedup;
}

async function fetchResult(raceId) {
  const html = await fetchText(`https://race.netkeiba.com/race/result.html?race_id=${raceId}`);
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(x=>x[1]);
  const top = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x=>strip(x[1]));
    if (cells.length < 4) continue;
    const rank = cleanNumber(cells[0]);
    if (!["1","2","3"].includes(rank)) continue;
    const no = cells.find(c => /^\d{1,2}$/.test(c) && c !== rank) || "";
    const name = strip((row.match(/<a[^>]+href=["'][^"']*horse[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)||[])[1] || "");
    top.push({ rank, no, name });
  }
  const p = parsePayouts(html);
  return {
    firstFrame: calcFrame(top[0]?.no, 18), firstNo: top[0]?.no || "", firstName: top[0]?.name || "",
    secondFrame: calcFrame(top[1]?.no, 18), secondNo: top[1]?.no || "", secondName: top[1]?.name || "",
    thirdFrame: calcFrame(top[2]?.no, 18), thirdNo: top[2]?.no || "", thirdName: top[2]?.name || "",
    umaren: p.umaren || "", umarenPay: p.umarenPay || "",
    sanrenpuku: p.sanrenpuku || "", sanrenpukuPay: p.sanrenpukuPay || ""
  };
}

function parsePayouts(html) {
  const text = strip(html).replace(/\s+/g, " ");
  const out = {};
  const uma = text.match(/馬連\s*([0-9]{1,2}\s*[-－]\s*[0-9]{1,2})\s*([0-9,]+)円/);
  if (uma) { out.umaren = uma[1].replace(/\s/g,"").replace("－","-"); out.umarenPay = uma[2].replace(/,/g,""); }
  const san = text.match(/3連複\s*([0-9]{1,2}\s*[-－]\s*[0-9]{1,2}\s*[-－]\s*[0-9]{1,2})\s*([0-9,]+)円/);
  if (san) { out.sanrenpuku = san[1].replace(/\s/g,"").replace(/－/g,"-"); out.sanrenpukuPay = san[2].replace(/,/g,""); }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Accept-Language":"ja,en-US;q=0.8" } });
  if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url}`);
  return await res.text();
}
function json(obj, status=200){ return new Response(JSON.stringify(obj,null,2), { status, headers:{...CORS,"Content-Type":"application/json; charset=utf-8"} }); }
function compactDate(s){ return String(s||"").replace(/\D/g,"").slice(0,8); }
function toSlashDate(s){ const d=compactDate(s); return d.length===8 ? `${d.slice(0,4)}/${d.slice(4,6)}/${d.slice(6,8)}` : String(s||""); }
function normalizeRaceNo(s){ return cleanNumber(String(s).replace(/R/i,"")); }
function strip(html){ return String(html||"").replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#039;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g," ").trim(); }
function cleanNumber(s){ return String(s||"").match(/\d+/)?.[0] || ""; }
function cleanOdds(s){ return String(s||"").replace(/[倍人気]/g,"").match(/\d+(?:\.\d+)?/)?.[0] || ""; }
function cleanupRaceName(s){ return String(s||"").replace(/出馬表.*$/," ").replace(/\|.*$/," ").replace(/^[0-9]+R\s*/,"").trim(); }
function detectGrade(s){ if(/G1|Ｇ１|GI/.test(s))return"G1"; if(/G2|Ｇ２|GII/.test(s))return"G2"; if(/G3|Ｇ３|GIII/.test(s))return"G3"; if(/3勝|３勝/.test(s))return"3勝"; if(/2勝|２勝/.test(s))return"2勝"; if(/1勝|１勝/.test(s))return"1勝"; if(/オープン|OP/.test(s))return"OP"; return""; }
function pickByClass(tds, re){ const x = tds.find(t=>re.test(t.cls)); return x ? x.text : ""; }
function calcFrame(no, headcount=18){ no=Number(no); headcount=Number(headcount)||18; if(!no)return""; if(headcount<=8)return String(no); if(headcount===9)return no<=1?"1":no<=2?"2":no<=3?"3":no<=4?"4":no<=5?"5":no<=6?"6":no<=7?"7":"8"; if(headcount===10)return no<=1?"1":no<=2?"2":no<=3?"3":no<=4?"4":no<=5?"5":no<=7?"6":no<=8?"7":"8"; if(headcount===11)return no<=1?"1":no<=2?"2":no<=3?"3":no<=4?"4":no<=6?"5":no<=7?"6":no<=9?"7":"8"; if(headcount===12)return no<=1?"1":no<=2?"2":no<=4?"3":no<=5?"4":no<=7?"5":no<=8?"6":no<=10?"7":"8"; if(headcount===13)return no<=1?"1":no<=3?"2":no<=4?"3":no<=6?"4":no<=7?"5":no<=9?"6":no<=11?"7":"8"; if(headcount===14)return no<=2?"1":no<=3?"2":no<=5?"3":no<=6?"4":no<=8?"5":no<=10?"6":no<=12?"7":"8"; if(headcount===15)return no<=2?"1":no<=4?"2":no<=5?"3":no<=7?"4":no<=9?"5":no<=11?"6":no<=13?"7":"8"; if(headcount===16)return no<=2?"1":no<=4?"2":no<=6?"3":no<=8?"4":no<=10?"5":no<=12?"6":no<=14?"7":"8"; if(headcount===17)return no<=2?"1":no<=4?"2":no<=6?"3":no<=8?"4":no<=10?"5":no<=12?"6":no<=15?"7":"8"; return no<=2?"1":no<=4?"2":no<=6?"3":no<=8?"4":no<=10?"5":no<=12?"6":no<=15?"7":"8"; }
