// crawler.js
// カーセンサー全ページを巡回して価格を収集する

import WebSocket from "ws";
globalThis.WebSocket = WebSocket;

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { realtime: false, auth: { persistSession: false } }
);

const CONFIG = {
  baseUrl: "https://www.carsensor.net/usedcar/index",
  totalPages: 17570,
  minIntervalMs: 3000,
  maxIntervalMs: 7000,
  maxMinutes: 330,
  progressFile: "progress.json",
};

function loadProgress() {
  if (existsSync(CONFIG.progressFile)) {
    try {
      const data = JSON.parse(readFileSync(CONFIG.progressFile, "utf8"));
      console.log("前回の進捗: " + data.lastPage + "ページまで完了");
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

function randomSleep() {
  const ms = CONFIG.minIntervalMs + Math.random() * (CONFIG.maxIntervalMs - CONFIG.minIntervalMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHtml(html) {
  const cars = [];
  const seen = new Set();

  // id="AU1234567890_cas" パターンで車両IDを取得
  const re = /id="([A-Z]{2}\d{6,12})_cas"/g;
  let m;

  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const start = m.index;
    const block = html.slice(start, start + 15000);

    // 整数部: basePrice__mainPriceNum
    const mainRe = /basePrice__mainPriceNum">(\d+)<\/span>/;
    const mainM = mainRe.exec(block);
    if (!mainM) {
      console.log("  価格なし: " + id);
      continue;
    }

    let price = parseInt(mainM[1], 10);

    // 小数部: basePrice__subPriceNum（例: ".0", ".5"）
    const subRe = /basePrice__subPriceNum">([\.\d]+)<\/span>/;
    const subM = subRe.exec(block);
    if (subM) {
      price = parseFloat(price + subM[1]);
    }

    // 1円は価格非公開
    if (price >= 2 && price <= 10000) {
      console.log("  取得: " + id + " = " + price + "万円");
      cars.push({ car_id: "CS-" + id, price, listing: parseListing(id, block, price) });
    } else {
      console.log("  価格なし: " + id + " (value=" + price + ")");
    }
  }

  return cars;
}

// 一覧ページのブロックから車両属性（車名・グレード・年式・走行距離・総額・修復歴）を抽出
function parseListing(id, block, price) {
  const makerM = /<p>([^<]{1,20})<\/p>\s*<h3 class="cassetteMain__title"/.exec(block);
  const titleM = /cassetteMain__link[^"]*"[^>]*>([^<]+)<\/a>/.exec(block);
  const totalM = /totalPrice__mainPriceNum">([\d,]+)</.exec(block);
  const totalSubM = /totalPrice__subPriceNum">([\.\d]+)</.exec(block);
  const yearM = /specList__emphasisData">(\d{4})<\/span><span class="specList__jpYear"/.exec(block);
  const mileM = /走行距離<\/dt>\s*<dd class="specList__data"><span class="specList__emphasisData">([\d.]+)<\/span>万km/.exec(block);
  const repairM = /修復歴<\/dt>\s*<dd class="specList__data">([^<]+)</.exec(block);

  let model = null;
  let grade = null;
  if (titleM) {
    const parts = titleM[1].split("&nbsp;");
    model = parts[0].trim();
    grade = (parts[1] || "").trim();
  }

  let totalPrice = null;
  if (totalM) {
    totalPrice = parseFloat(totalM[1].replace(/,/g, "") + (totalSubM ? totalSubM[1] : ""));
  }

  return {
    car_id: "CS-" + id,
    maker: makerM ? makerM[1].trim() : null,
    model,
    grade,
    year: yearM ? parseInt(yearM[1], 10) : null,
    mileage_km: mileM ? Math.round(parseFloat(mileM[1]) * 10000) : null,
    price_man: price,
    total_price_man: totalPrice,
    repair: repairM ? repairM[1].trim() : null,
    url: "https://www.carsensor.net/usedcar/detail/" + id + "/index.html",
    last_seen_at: new Date().toISOString(),
  };
}

async function fetchPage(page, retryCount = 0) {
  const suffix = page === 1 ? ".html" : page + ".html";
  const url = CONFIG.baseUrl + suffix;

  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
  ];
  const ua = userAgents[Math.floor(Math.random() * userAgents.length)];

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.7,en;q=0.3",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    if (res.status === 429 || res.status === 503) {
      if (retryCount < 3) {
        await new Promise(r => setTimeout(r, 30000));
        return fetchPage(page, retryCount + 1);
      }
      return [];
    }

    if (!res.ok) {
      console.warn("ページ" + page + ": HTTP " + res.status);
      return [];
    }

    const html = await res.text();
    if (html.length < 5000) return [];
    return parseHtml(html);
  } catch (e) {
    if (retryCount < 2) {
      await new Promise(r => setTimeout(r, 10000));
      return fetchPage(page, retryCount + 1);
    }
    return [];
  }
}

async function saveToDb(car_id, price) {
  const today = new Date().toISOString().split("T")[0];
  const { data: existing } = await supabase
    .from("car_prices")
    .select("id")
    .eq("car_id", car_id)
    .gte("recorded_at", today + "T00:00:00")
    .lte("recorded_at", today + "T23:59:59")
    .limit(1);

  if (existing && existing.length > 0) {
    await supabase.from("car_prices").update({ price }).eq("id", existing[0].id);
  } else {
    await supabase.from("car_prices").insert({ car_id, price, site: "carsensor" });
  }
}

async function saveListing(listing) {
  if (!listing.model || !listing.year) return; // 属性が取れないものはスキップ
  await supabase.from("car_listings").upsert(listing, { onConflict: "car_id" });
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

  console.log("開始ページ: " + startPage + " / " + CONFIG.totalPages);

  let totalSaved = progress.totalSaved || 0;
  let currentPage = startPage;
  let zeroCount = 0;

  for (let page = startPage; page <= CONFIG.totalPages; page++) {
    currentPage = page;

    const elapsed = Date.now() - startTime;
    if (elapsed >= maxMs) {
      console.log("時間制限に達しました。" + page + "ページで停止。");
      break;
    }

    const cars = await fetchPage(page);
    console.log("ページ " + page + "/" + CONFIG.totalPages + ": " + cars.length + "件");

    if (cars.length === 0) {
      zeroCount++;
      if (zeroCount >= 10) {
        await new Promise(r => setTimeout(r, 15000));
        zeroCount = 0;
      }
    } else {
      zeroCount = 0;
      for (const car of cars) {
        try {
          await saveToDb(car.car_id, car.price);
          totalSaved++;
        } catch (e) {
          console.warn("保存失敗: " + car.car_id);
        }
        try {
          await saveListing(car.listing);
        } catch (e) {
          console.warn("listing保存失敗: " + car.car_id);
        }
      }
    }

    if (page % 10 === 0) {
      saveProgress(page, totalSaved);
      const elapsedMin = Math.floor(elapsed / 60000);
      console.log("進捗: " + page + "/" + CONFIG.totalPages + "ページ, " + totalSaved + "件保存, " + elapsedMin + "分経過");
    }

    await randomSleep();
  }

  saveProgress(currentPage, totalSaved);
  console.log("完了: " + currentPage + "ページまで処理, 合計" + totalSaved + "件保存");
}

main().catch((e) => {
  console.error("クローラーエラー:", e);
  process.exit(1);
});
