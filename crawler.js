// crawler.js
// カーセンサー全ページを巡回して価格を収集する
// GitHub Actionsで毎日実行・前回の続きから再開
// ※ボット対策・本体価格取得

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

// ランダムな待機時間
function randomSleep() {
  const ms = CONFIG.minIntervalMs + Math.random() * (CONFIG.maxIntervalMs - CONFIG.minIntervalMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================
// HTMLから車両情報を抽出
// =============================
function parseHtml(html) {
  const cars = [];
  const seen = new Set();

  // パターン1: /usedcar/detail/XXXX/
  const pattern1 = /\/usedcar\/detail\/([A-Z0-9][A-Z0-9\-]{3,30})\//g;
  // パターン2: detail?STID=CS&ID=XXXX
  const pattern2 = /[?&]ID=([A-Z0-9\-]{5,30})/g;
  // パターン3: data-carid="XXXX"
  const pattern3 = /data-carid="([^"]+)"/g;
  // パターン4: data-id="XXXX"
  const pattern4 = /data-id="([A-Z0-9\-]{5,30})"/g;

  const allPatterns = [pattern1, pattern2, pattern3, pattern4];

  for (const pattern of allPatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const id = match[1];
      if (seen.has(id)) continue;
      if (id.length < 5 || id.length > 30) continue;

      seen.add(id);

      const pos = match.index;
      const nearby = html.slice(Math.max(0, pos - 500), pos + 3000);

      let price = null;

      // 本体価格を優先
      const bodyMatch = nearby.match(/(?:車両本体価格|本体価格)[^\d]*([\d,]+\.?\d*)\s*万円/);
      if (bodyMatch) {
        price = parseFloat(bodyMatch[1].replace(",", ""));
      }

      // 2番目の価格（支払総額の次が本体価格）
      if (!price) {
        const allPrices = [...nearby.matchAll(/([\d,]+\.?\d*)\s*万円/g)];
        if (allPrices.length >= 2) {
          price = parseFloat(allPrices[1][1].replace(",", ""));
        } else if (allPrices.length === 1) {
          price = parseFloat(allPrices[0][1].replace(",", ""));
        }
      }

      if (price && price >= 1 && price <= 10000) {
        cars.push({ car_id: "CS-" + id, price });
      }
    }
  }

  return cars;
}

// =============================
// ページ取得（リトライあり）
// =============================
async function fetchPage(page, retryCount = 0) {
  const url = `${CONFIG.baseUrl}?${CONFIG.params}&PAGE=${page}`;

  // ランダムなUser-Agentを使用
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
      // レート制限 → 長めに待ってリトライ
      if (retryCount < 3) {
        console.warn(`ページ${page}: ${res.status} → 30秒待ってリトライ (${retryCount + 1}/3)`);
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

    // ボット対策で空ページが返された場合
    if (html.length < 5000) {
      console.warn(`ページ${page}: HTMLが短すぎる (${html.length}bytes) → スキップ`);
      return [];
    }

    const cars = parseHtml(html);
    return cars;
  } catch (e) {
    console.warn(`ページ${page}: 取得失敗 - ${e.message}`);
    if (retryCount < 2) {
      await new Promise(r => setTimeout(r, 10000));
      return fetchPage(page, retryCount + 1);
    }
    return [];
  }
}

// =============================
// DBに保存
// =============================
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

// =============================
// メイン処理
// =============================
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
  let zeroCount = 0; // 連続0件カウント

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
      // 連続10ページ0件なら少し長めに待つ
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
