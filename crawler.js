// crawler.js
// カーセンサー全ページを巡回して価格を収集する
// GitHub Actionsで毎日実行・前回の続きから再開

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// =============================
// 設定
// =============================
const CONFIG = {
  baseUrl: "https://www.carsensor.net/usedcar/search.php",
  params: "STID=CS210610&SORT=2",  // 新着順・全車種
  totalPages: 17570,
  intervalMs: 4000,      // 1リクエストごとに4秒待機
  maxMinutes: 330,       // 最大5時間30分で自動停止（Actionsの制限に余裕を持たせる）
  progressFile: "progress.json",
};

// =============================
// 進捗ファイルの読み書き
// =============================
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

// =============================
// 指定ミリ秒待機
// =============================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================
// HTMLから車両情報を抽出
// =============================
function parseHtml(html) {
  const cars = [];
  const seen = new Set();

  // 車両詳細URLからIDを取得
  const linkPattern = /href="(\/usedcar\/detail\/[^"]+)"/g;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const path = match[1];
    const idMatch = path.match(/detail\/([A-Z0-9\-]+)/i);
    if (idMatch && !seen.has(idMatch[1])) {
      seen.add(idMatch[1]);

      // このIDの近くにある価格を探す
      const pos = match.index;
      const nearby = html.slice(pos, pos + 2000);
      const priceMatch = nearby.match(/([\d,]+\.?\d*)\s*万円/);
      if (priceMatch) {
        const price = parseFloat(priceMatch[1].replace(",", ""));
        if (price >= 1 && price <= 10000) {
          cars.push({ car_id: "CS-" + idMatch[1], price });
        }
      }
    }
  }
  return cars;
}

// =============================
// 1ページ取得
// =============================
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

// =============================
// DBに保存（今日分は更新）
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

  // 開始ページの決定
  // 全ページ完了していたら最初に戻る
  let startPage = progress.lastPage + 1;
  if (startPage > CONFIG.totalPages) {
    console.log("全ページ完了済み。最初から再開します。");
    startPage = 1;
    progress.totalSaved = 0;
  }

  // 手動指定があればそちらを優先
  if (process.env.START_PAGE && !isNaN(parseInt(process.env.START_PAGE))) {
    startPage = parseInt(process.env.START_PAGE);
  }

  console.log(`開始ページ: ${startPage} / ${CONFIG.totalPages}`);
  console.log(`最大実行時間: ${CONFIG.maxMinutes}分`);

  let totalSaved = progress.totalSaved || 0;
  let currentPage = startPage;

  for (let page = startPage; page <= CONFIG.totalPages; page++) {
    currentPage = page;

    // 時間制限チェック
    const elapsed = Date.now() - startTime;
    if (elapsed >= maxMs) {
      console.log(`時間制限（${CONFIG.maxMinutes}分）に達しました。${page}ページで停止。`);
      break;
    }

    // ページ取得
    const cars = await fetchPage(page);
    console.log(`ページ ${page}/${CONFIG.totalPages}: ${cars.length}件`);

    // DB保存
    for (const car of cars) {
      try {
        await saveToDb(car.car_id, car.price);
        totalSaved++;
      } catch (e) {
        console.warn(`保存失敗: ${car.car_id} - ${e.message}`);
      }
    }

    // 進捗保存（10ページごと）
    if (page % 10 === 0) {
      saveProgress(page, totalSaved);
      const elapsedMin = Math.floor(elapsed / 60000);
      console.log(`進捗: ${page}/${CONFIG.totalPages}ページ, ${totalSaved}件保存, ${elapsedMin}分経過`);
    }

    // 待機
    await sleep(CONFIG.intervalMs);
  }

  // 最終進捗保存
  saveProgress(currentPage, totalSaved);
  console.log(`完了: ${currentPage}ページまで処理, 合計${totalSaved}件保存`);
}

main().catch((e) => {
  console.error("クローラーエラー:", e);
  process.exit(1);
});
