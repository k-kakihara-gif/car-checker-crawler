// crawler.js
// カーセンサー全ページを巡回して価格を収集する
// GitHub Actionsで毎日実行・前回の続きから再開

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const CONFIG = {
  baseUrl: "https://www.carsensor.net/usedcar/index",
  params: "",
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

function randomSleep() {
  const ms = CONFIG.minIntervalMs + Math.random() * (CONFIG.maxIntervalMs - CONFIG.minIntervalMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================
// HTMLから車両情報を抽出
// カーセンサーの構造:
// <div id="AU2311262168_cas">  ← 車両ID
// <span class="basePrice__mainPriceNum">293</span>  ← 本体価格（万円）
// <span class="basePrice__unit">万円</span> or 円
// <span class="totalPrice__mainPriceNum">303</span>  ← 支払総額（万円）
// =============================
function parseHtml(html) {
  const cars = [];
  const seen = new Set();

  // カセットIDを取得: id="AU2311262168_cas"
  const cassettePattern = /id="([A-Z]{2}\d{6,12})_cas"/g;
  let match;

  while ((match = cassettePattern.exec(html)) !== null) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const start = match.index;
    const block = html.slice(start, start + 5000);

    let price = null;

    // パターン1: basePrice__mainPriceNum（本体価格）
    // 整数部: <span class="basePrice__mainPriceNum">8</span>
    // 小数部: <span class="basePrice__subPriceNum">.8</span>（任意）
    const basePriceMainMatch = block.match(/basePrice__mainPriceNum[^>]*>(\d+)<\/span>/);
    if (basePriceMainMatch) {
      let intPart = parseFloat(basePriceMainMatch[1]);
      const basePriceSubMatch = block.match(/basePrice__subPriceNum[^>]*>(\.\d+)<\/span>/);
      const subPart = basePriceSubMatch ? parseFloat(basePriceSubMatch[1]) : 0;
      const val = intPart + subPart;
      if (val >= 2) {
        price = val;
      }
    }

    // パターン2: basePrice の近くの数字
    if (!price) {
      const basePriceBlock = block.match(/class="basePrice"[^]*?class="basePrice__content"[^]*?(\d+(?:\.\d+)?)/);
      if (basePriceBlock) {
        price = parseFloat(basePriceBlock[1]);
      }
    }

    // パターン3: totalPrice__mainPriceNum（支払総額）をフォールバック
    if (!price) {
      const totalPriceMatch = block.match(/totalPrice__mainPriceNum[^>]*>(\d+(?:\.\d+)?)<\/span>/);
      if (totalPriceMatch) {
        price = parseFloat(totalPriceMatch[1]);
      }
    }

    if (price && price >= 1 && price <= 10000) {
      cars.push({ car_id: "CS-" + id, price });
      console.log(`  取得: ${id} = ${price}万円`);
    } else {
      console.log(`  価格なし: ${id}`);
    }
  }

  return cars;
}

async function fetchPage(page, retryCount = 0) {
  // URL形式: index.html(1ページ目), index2.html(2ページ目), ...
  const suffix = page === 1 ? ".html" : `${page}.html`;
  const url = `${CONFIG.baseUrl}${suffix}`;

  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
  ];
  const ua = userAgents[Math.floor(Math.random() * userAgents.length)];

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.7,en;q=0.3",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Cache-Control": "max-age=0",
      },
    });

    if (res.status === 429 || res.status === 503) {
      if (retryCount < 3) {
        console.warn(`ページ${page}: ${res.status} → 30秒待ってリトライ`);
        await new Promise(r => setTimeout(r, 30000));
        return fetchPage(page, retryCount + 1);
      }
      return [];
    }

    if (!res.ok) {
      console.warn(`ページ${page}: HTTP ${res.status}`);
      return [];
    }

    const html = await res.text();
    if (html.length < 5000) {
      console.warn(`ページ${page}: HTMLが短すぎる (${html.length}bytes)`);
      return [];
    }

    return parseHtml(html);
  } catch (e) {
    if (retryCount < 2) {
      await new Promise(r => setTimeout(r, 10000));
      return fetchPage(page, retryCount + 1);
    }
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
  let zeroCount = 0;

  for (let page = startPage; page <= CONFIG.totalPages; page++) {
    currentPage = page;

    const elapsed = Date.now() - startTime;
    if (elapsed >= maxMs) {
      console.log(`時間制限（${CONFIG.maxMinutes}分）に達しました。${page}ページで停止。`);
      break;
    }

    const cars = await fetchPage(page);
    console.log(`ページ ${page}/${CONFIG.totalPages}: ${cars.length}件`);

    if (cars.length === 0) {
      zeroCount++;
      if (zeroCount >= 10) {
        console.log(`連続${zeroCount}ページ0件 → 15秒待機`);
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
          console.warn(`保存失敗: ${car.car_id} - ${e.message}`);
        }
      }
    }

    if (page % 10 === 0) {
      saveProgress(page, totalSaved);
      const elapsedMin = Math.floor(elapsed / 60000);
      console.log(`進捗: ${page}/${CONFIG.totalPages}ページ, ${totalSaved}件保存, ${elapsedMin}分経過`);
    }

    await randomSleep();
  }

  saveProgress(currentPage, totalSaved);
  console.log(`完了: ${currentPage}ページまで処理, 合計${totalSaved}件保存`);
}

main().catch((e) => {
  console.error("クローラーエラー:", e);
  process.exit(1);
});
