import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { buildLunchSpotResponse, isParkingMeterActive, notices } from "../src/core/scoring.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

const data = {
  restaurants: [
    {
      id: "drive_001",
      name: "テスト ドライブスルー",
      category: "fast_food",
      location: { lat: 35.64172, lng: 139.75792 },
      pickupTypes: ["drive_through", "takeout"],
      estimatedStayMinutes: 8,
      dataSources: ["test"]
    },
    {
      id: "meter_001",
      name: "テスト メーター近接弁当",
      category: "deli",
      location: { lat: 35.6809, lng: 139.76525 },
      pickupTypes: ["takeout"],
      estimatedStayMinutes: 12,
      dataSources: ["test"]
    },
    {
      id: "lot_001",
      name: "テスト 駐車場近接食堂",
      category: "restaurant",
      location: { lat: 35.69285, lng: 139.77045 },
      pickupTypes: ["takeout"],
      estimatedStayMinutes: 18,
      dataSources: ["test"]
    },
    {
      id: "onsite_001",
      name: "テスト 駐車場タグ付きコンビニ",
      category: "convenience",
      location: { lat: 35.694, lng: 139.771 },
      pickupTypes: ["takeout"],
      parkingHints: ["on_site"],
      estimatedStayMinutes: 10,
      dataSources: ["test"]
    },
    {
      id: "caution_001",
      name: "テスト 駐車候補なし",
      category: "restaurant",
      location: { lat: 35.69033, lng: 139.70041 },
      pickupTypes: ["eat_in", "takeout"],
      estimatedStayMinutes: 28,
      dataSources: ["test"]
    }
  ],
  parkingMeterZones: [
    {
      id: "pm_marunouchi_001",
      name: "テスト 丸の内時間制限駐車区間",
      location: { lat: 35.68112, lng: 139.7659 },
      activeDays: ["mon", "tue", "wed", "thu", "fri", "sat"],
      activeWindows: [{ start: "09:00", end: "19:00" }],
      limitMinutes: 60,
      allowedVehicleTypes: ["standard", "cargo"]
    }
  ],
  parkingLots: [
    {
      id: "lot_kanda_001",
      name: "テスト 神田時間貸駐車場",
      location: { lat: 35.6932, lng: 139.77115 },
      availability: "unknown"
    }
  ],
  manualDriveThroughPlaces: [],
  sourceAuditLogs: []
};

test("A rank is returned for non-leaving pickup candidates", () => {
  const response = buildLunchSpotResponse(data, {
    lat: 35.64172,
    lng: 139.75792,
    radiusM: 800,
    vehicleType: "standard",
    time: "12:00"
  });

  assert.equal(response.safeSpots[0].recommendedRank, "A");
  assert.equal(response.safeSpots[0].nearestParkingCandidate.type, "not_required");
});

test("B rank uses active parking meter zones only", () => {
  const response = buildLunchSpotResponse(data, {
    lat: 35.681236,
    lng: 139.767125,
    radiusM: 1000,
    vehicleType: "standard",
    time: "2026-05-25T12:00:00+09:00"
  });

  const bRank = response.safeSpots.find((spot) => spot.id === "meter_001");
  assert.equal(bRank.recommendedRank, "B");
  assert.equal(bRank.nearestParkingCandidate.type, "parking_meter");
});

test("parking meter zones are not active outside their time window", () => {
  const zone = data.parkingMeterZones.find((candidate) => candidate.id === "pm_marunouchi_001");
  assert.equal(
    isParkingMeterActive(zone, { weekday: "mon", minutes: 20 * 60, hhmm: "20:00", isoDate: "2026-05-25" }, "standard"),
    false
  );
});

test("C rank is used when only an unknown parking lot is nearby", () => {
  const response = buildLunchSpotResponse(data, {
    lat: 35.69285,
    lng: 139.77045,
    radiusM: 700,
    vehicleType: "standard",
    time: "20:00"
  });

  const spot = response.safeSpots.find((candidate) => candidate.id === "lot_001");
  assert.equal(spot.recommendedRank, "C");
  assert.equal(spot.nearestParkingCandidate.availability, "未確認");
});

test("recommendations prefer nearby candidates when parking quality is similar", () => {
  const response = buildLunchSpotResponse(
    {
      ...data,
      restaurants: [
        {
          id: "near_lot",
          name: "近い駐車場近接店",
          category: "restaurant",
          location: { lat: 35.6816, lng: 139.7675 },
          pickupTypes: ["takeout"],
          estimatedStayMinutes: 12,
          dataSources: ["test"]
        },
        {
          id: "far_lot",
          name: "遠い駐車場近接店",
          category: "restaurant",
          location: { lat: 35.69285, lng: 139.77045 },
          pickupTypes: ["takeout"],
          estimatedStayMinutes: 12,
          dataSources: ["test"]
        }
      ],
      parkingLots: [
        {
          id: "near_parking",
          name: "近い店の駐車場",
          location: { lat: 35.6818, lng: 139.7677 },
          availability: "unknown"
        },
        {
          id: "far_parking",
          name: "遠い店の駐車場",
          location: { lat: 35.69305, lng: 139.77065 },
          availability: "unknown"
        }
      ],
      parkingMeterZones: []
    },
    {
      lat: 35.681236,
      lng: 139.767125,
      radiusM: 2200,
      vehicleType: "standard",
      time: "12:00"
    }
  );

  assert.equal(response.safeSpots[0].id, "near_lot");
  assert.ok(response.safeSpots[0].score > response.safeSpots[1].score);
});

test("C rank is used when OSM indicates on-site parking", () => {
  const response = buildLunchSpotResponse({ ...data, parkingLots: [] }, {
    lat: 35.694,
    lng: 139.771,
    radiusM: 120,
    vehicleType: "standard",
    time: "20:00"
  });

  assert.equal(response.safeSpots[0].recommendedRank, "C");
  assert.equal(response.safeSpots[0].nearestParkingCandidate.type, "on_site_parking");
});

test("restaurants without parking candidates are separated into caution spots", () => {
  const response = buildLunchSpotResponse(data, {
    lat: 35.69033,
    lng: 139.70041,
    radiusM: 600,
    vehicleType: "standard",
    time: "12:00"
  });

  assert.equal(response.safeSpots.length, 0);
  assert.equal(response.cautionSpots[0].recommendedRank, "CAUTION");
});

test("required legal notice is present and forbidden guarantee copy is absent", () => {
  const files = ["public/index.html", "public/app.js", "src/core/scoring.mjs"];
  const corpus = files.map((file) => readFileSync(path.join(rootDir, file), "utf8")).join("\n");
  assert.match(corpus, /本アプリは駐車許可を保証しません/);
  assert.match(corpus, /停めやすい/);
  assert.match(corpus, /店前を確認/);
  assert.match(corpus, /Google Map/);
  assert.match(notices.REQUIRED_CAUTION, /現地標識確認必須/);
  assert.doesNotMatch(corpus, /駐禁を取られない|停車OK保証|合法保証/);
});
