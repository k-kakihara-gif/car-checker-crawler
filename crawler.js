// crawler.js
// カーセンサー全ページを巡回して価格を収集する
// GitHub Actionsで毎日実行・前回の続きから再開
// ※車両本体価格を取得

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const CONFIG = {
  baseUrl: "https://www.carsensor.net/usedcar/search.php",
  params: "STID=CS210610&SORT=2",
  totalPages: 17570,
  intervalMs: 4000,
  maxMinutes: 330,
  progressFile: "progress.json",
};

function loadProgress() {
  if (existsSync(CONFIG.progressFile)) {
    try {
      const data = JSON.parse(readFileSync(CONFIG.progressFile, "utf8"));
      console.log(`前回の進捗: ${data.lastPage}ページまで完了`);
      return data;
    } catch (e) {}
  }
  return { lastPage: 0, totalSaved: 0 };
}

function saveProgress(lastPage, totalSaved) {
  writeFileSync(
    CONFIG.progressFile,
    JSON.stringify({ lastPage, totalSaved, updatedAt: new Date().toISOString() }, null, 2)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================
// HTMLから車両情報を抽出（本体価格を取得）
// =============================
function parseHtml(html) {
  const cars = [];
  const seen = new Set();

  const linkPattern = /href="(\/usedcar\/detail\/[^"]+)"/g;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const path = match[1];
    const idMatch = path.match(/detail\/([A-Z0-9\-]+)/i);
    if (idMatch && !seen.has(idMatch[1])) {
      seen.add(idMatch[1]);

      const pos = match.index;
      const nearby = html.slice(pos, pos + 3000);

      // 本体価格を優先して取得
      // カーセンサーのHTML構造：「車両本体価格」の後に価格が来る
      let price = null;

      // パターン1: 「本体」「車両本体価格」の近くの価格
      const bodyPriceMatch = nearby.match(/(?:車両本体価格|本体価格|honten)[^>]*?>?\s*([\d,]+\.?\d*)\s*万円/);
      if (bodyPriceMatch) {
        price = parseFloat(bodyPriceMatch[1].replace(",", ""));
      }

      // パターン2: 2つ目の価格（1つ目=支払総額、2つ目=本体価格）
      if (!price) {
        const allPrices = [...nearby.matchAll(/([\d,]+\.?\d*)\s*万円/g)];
        if (allPrices.length >= 2) {
          // 2番目の価格が本体価格である場合が多い
          price = parseFloat(allPrices[1][1].replace(",", ""));
        } else if (allPrices.length === 1) {
          price = parseFloat(allPrices[0][1].replace(",", ""));
        }
      }

      if (price && price >= 1 && price <= 10000) {
        cars.push({ car_id: "CS-" + idMatch[1], price });
      }
    }
  }
  return cars;
}

async function fetchPage(page) {
  const url = `${CONFIG.baseUrl}?${CONFIG.params}&PAGE=${page}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ja,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      console.warn(`ページ${page}: HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    return parseHtml(html);
  } catch (e) {
    console.warn(`ページ${page}: 取得失敗 - ${e.message}`);
    return [];
  }
}

async function saveToDb(car_id, price) {
  const today = new Date().toISOString().split("T")[0];
  const { data: existing } = await supabase
    .from("car_prices")
    .select("id")
    .eq("car_id", car_id)
    .gte("recorded_at", `${today}T00:00:00`)
    .lte("recorded_at", `${today}T23:59:59`)
    .limit(1);

  if (existing && existing.length > 0) {
    await supabase.from("car_prices").update({ price }).eq("id", existing[0].id);
  } else {
    await supabase.from("car_prices").insert({ car_id, price, site: "carsensor" });
  }
}

async function main() {
  const progress = loadProgress();
  const startTime = Date.now();
  const maxMs = CONFIG.maxMinutes * 60 * 1000;

  let startPage = progress.lastPage + 1;
  if (startPage > CONFIG.totalPages) {
    console.log("全ページ完了済み。最初から再開します。");
    startPage = 1;
    progress.totalSaved = 0;
  }

  if (process.env.START_PAGE && !isNaN(parseInt(process.env.START_PAGE))) {
    startPage = parseInt(process.env.START_PAGE);
  }

  console.log(`開始ページ: ${startPage} / ${CONFIG.totalPages}`);

  let totalSaved = progress.totalSaved || 0;
  let currentPage = startPage;

  for (let page = startPage; page <= CONFIG.totalPages; page++) {
    currentPage = page;

    const elapsed = Date.now() - startTime;
    if (elapsed >= maxMs) {
      console.log(`時間制限（${CONFIG.maxMinutes}分）に達しました。${page}ページで停止。`);
      break;
    }

    const cars = await fetchPage(page);
    console.log(`ページ ${page}/${CONFIG.totalPages}: ${cars.length}件`);

    for (const car of cars) {
      try {
        await saveToDb(car.car_id, car.price);
        totalSaved++;
      } catch (e) {
        console.warn(`保存失敗: ${car.car_id} - ${e.message}`);
      }
    }

    if (page % 10 === 0) {
      saveProgress(page, totalSaved);
      const elapsedMin = Math.floor(elapsed / 60000);
      console.log(`進捗: ${page}/${CONFIG.totalPages}ページ, ${totalSaved}件保存, ${elapsedMin}分経過`);
    }

    await sleep(CONFIG.intervalMs);
  }

  saveProgress(currentPage, totalSaved);
  console.log(`完了: ${currentPage}ページまで処理, 合計${totalSaved}件保存`);
}

main().catch((e) => {
  console.error("クローラーエラー:", e);
  process.exit(1);
});
