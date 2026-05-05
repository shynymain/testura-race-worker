function normalizeFinishValue(v) {
  if (!v) return "";

  if (v.includes("中止")) return "中止";
  if (v.includes("取消")) return "中止";
  if (v.includes("除外")) return "中止";

  const num = v.match(/\d+/);
  return num ? num[0] : "";
}

function pickSafeFinishFromHorseRow(cols) {
  const isFinish = (v) => {
    if (!v) return false;

    if (/^\d{1,2}$/.test(v)) return true;
    if (v.includes("中止") || v.includes("取消") || v.includes("除外")) return true;

    return false;
  };

  for (let i = 0; i < cols.length; i++) {
    const v = cols[i];

    // 危険列スキップ
    if (i === 7 || i === 8) continue; // 枠・馬番
    if (i === 9) continue;            // オッズ
    if (i === 10) continue;           // 人気

    if (isFinish(v)) {
      return normalizeFinishValue(v);
    }
  }

  return "";
}
