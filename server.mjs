import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadData } from "./src/core/data.mjs";
import { buildLunchSpotResponse } from "./src/core/scoring.mjs";
import { fetchOverpassLunchData } from "./src/providers/overpass.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const seedData = loadData(path.join(__dirname, "data"));

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"]
]);

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

function parseNumber(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

function mergeLiveData(seed, live, status) {
  return {
    ...seed,
    restaurants: [...live.restaurants, ...seed.restaurants],
    parkingLots: [...live.parkingLots, ...seed.parkingLots],
    sourceAuditLogs: [live.auditLog, ...seed.sourceAuditLogs],
    liveDataStatus: status
  };
}

async function getSearchData(query) {
  if (process.env.USE_LIVE_OVERPASS === "0") {
    return {
      ...seedData,
      liveDataStatus: {
        provider: "overpass_osm",
        used: false,
        message: "ライブ検索は環境変数 USE_LIVE_OVERPASS=0 で無効化されています。"
      }
    };
  }

  try {
    const live = await fetchOverpassLunchData(query);
    return mergeLiveData(seedData, live, {
      provider: "overpass_osm",
      used: true,
      message: `OpenStreetMapから飲食候補${live.restaurants.length}件、駐車場候補${live.parkingLots.length}件を取得しました。`
    });
  } catch (error) {
    return {
      ...seedData,
      liveDataStatus: {
        provider: "overpass_osm",
        used: false,
        message: `ライブ検索に失敗したためローカル静的データを使用しています: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      }
    };
  }
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalizedPath = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, normalizedPath);

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const file = await readFile(filePath);
  const contentType = mimeTypes.get(path.extname(filePath)) ?? "application/octet-stream";
  const headers = {
    "Content-Type": contentType,
    "Cache-Control":
      requestedPath === "/index.html" || requestedPath.endsWith(".js") || requestedPath === "/sw.js"
        ? "no-store"
        : "public, max-age=3600"
  };
  if (requestedPath === "/index.html") {
    headers["Clear-Site-Data"] = '"cache", "storage"';
  }
  res.writeHead(200, headers);
  res.end(file);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, service: "park-park-lunch" });
      return;
    }

    if (url.pathname === "/api/config") {
      const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY ?? "";
      sendJson(res, 200, {
        preferredMapProvider: googleMapsApiKey ? "google" : "gsi",
        googleMapsApiKey,
        mapUsageBudget: {
          assumedBusinessDaysPerMonth: 22,
          assumedDrivers: 10,
          freeDynamicMapLoadsPerMonth: 10000,
          note: "Google Maps JavaScript API key is public by design. Restrict it by HTTP referrer in Google Cloud Console."
        }
      });
      return;
    }

    if (url.pathname === "/api/lunch-spots") {
      const query = {
        lat: parseNumber(url.searchParams.get("lat"), 35.681236),
        lng: parseNumber(url.searchParams.get("lng"), 139.767125),
        radiusM: Math.min(parseNumber(url.searchParams.get("radiusM"), 2200), 5000),
        vehicleType: url.searchParams.get("vehicleType") ?? "standard",
        time: url.searchParams.get("time") ?? undefined
      };
      sendJson(res, 200, buildLunchSpotResponse(await getSearchData(query), query));
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method not allowed");
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

server.listen(port, () => {
  console.log(`Park Park Lunch MVP running at http://localhost:${port}`);
});
