const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();
const parkingCache = new Map();
const storeParkingCache = new Map();
const REQUIRED_CAUTION =
  "現地標識確認必須。本アプリは駐車許可を保証しません。車を離れる場合は推奨された駐車施設を利用してください。";

function distanceMeters(a, b) {
  const earthRadiusM = 6371008.8;
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusM * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function cacheKey(query) {
  const lat = Math.round(query.lat * 1000) / 1000;
  const lng = Math.round(query.lng * 1000) / 1000;
  const radius = Math.min(query.radiusM ?? 1500, 2500);
  return `${lat}:${lng}:${radius}`;
}

function buildOverpassQuery({ lat, lng, radiusM }) {
  const radius = Math.min(radiusM ?? 1500, 2500);
  return `
    [out:json][timeout:12];
    (
      node(around:${radius},${lat},${lng})["amenity"~"restaurant|fast_food|cafe|food_court"];
      way(around:${radius},${lat},${lng})["amenity"~"restaurant|fast_food|cafe|food_court"];
      relation(around:${radius},${lat},${lng})["amenity"~"restaurant|fast_food|cafe|food_court"];
      node(around:${radius},${lat},${lng})["shop"~"convenience|bakery|deli|supermarket|greengrocer"];
      way(around:${radius},${lat},${lng})["shop"~"convenience|bakery|deli|supermarket|greengrocer"];
      node(around:${radius},${lat},${lng})["amenity"="parking"];
      way(around:${radius},${lat},${lng})["amenity"="parking"];
    );
    out center tags 80;
  `;
}

function buildParkingOnlyQuery({ lat, lng, radiusM }) {
  const radius = Math.min(radiusM ?? 1500, 2500);
  return `
    [out:json][timeout:12];
    (
      node(around:${radius},${lat},${lng})["amenity"="parking"];
      way(around:${radius},${lat},${lng})["amenity"="parking"];
      node(around:${radius},${lat},${lng})["parking"~"yes|customers|surface|underground|multi-storey"];
      way(around:${radius},${lat},${lng})["parking"~"yes|customers|surface|underground|multi-storey"];
    );
    out center tags 80;
  `;
}

function buildStoreParkingHintQuery({ lat, lng, radiusM }) {
  const radius = Math.min(radiusM ?? 1500, 5000);
  return `
    [out:json][timeout:12];
    (
      node(around:${radius},${lat},${lng})["parking"]["shop"~"convenience|supermarket"];
      way(around:${radius},${lat},${lng})["parking"]["shop"~"convenience|supermarket"];
      relation(around:${radius},${lat},${lng})["parking"]["shop"~"convenience|supermarket"];
      node(around:${radius},${lat},${lng})["parking"]["amenity"~"fast_food|restaurant|cafe"];
      way(around:${radius},${lat},${lng})["parking"]["amenity"~"fast_food|restaurant|cafe"];
      relation(around:${radius},${lat},${lng})["parking"]["amenity"~"fast_food|restaurant|cafe"];
      node(around:${radius},${lat},${lng})["parking:condition"]["shop"~"convenience|supermarket"];
      way(around:${radius},${lat},${lng})["parking:condition"]["shop"~"convenience|supermarket"];
      relation(around:${radius},${lat},${lng})["parking:condition"]["shop"~"convenience|supermarket"];
      node(around:${radius},${lat},${lng})["parking:condition"]["amenity"~"fast_food|restaurant|cafe"];
      way(around:${radius},${lat},${lng})["parking:condition"]["amenity"~"fast_food|restaurant|cafe"];
      relation(around:${radius},${lat},${lng})["parking:condition"]["amenity"~"fast_food|restaurant|cafe"];
    );
    out center tags 120;
  `;
}

function pointFromElement(element) {
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function pickupTypes(tags) {
  const types = [];
  if (tags.drive_through === "yes") types.push("drive_through");
  if (tags.takeaway === "yes" || tags.takeaway === "only") types.push("takeout");
  if (
    tags.amenity === "fast_food" ||
    tags.amenity === "food_court" ||
    ["convenience", "bakery", "deli", "supermarket", "greengrocer"].includes(tags.shop)
  ) {
    types.push("takeout");
  }
  if (!types.length) types.push("eat_in");
  return [...new Set(types)];
}

function categoryFromTags(tags) {
  if (tags.shop === "convenience") return "convenience";
  if (tags.shop === "supermarket") return "supermarket";
  if (tags.shop === "bakery" || tags.shop === "deli") return "deli";
  if (tags.amenity === "fast_food") return "fast_food";
  if (tags.amenity === "cafe") return "cafe";
  return "restaurant";
}

function parkingHints(tags) {
  const hints = [];
  if (["yes", "customers", "surface", "underground", "multi-storey"].includes(tags.parking)) hints.push("on_site");
  if (tags["parking:condition"]) hints.push("on_site");
  return hints;
}

function normalizeElements(elements) {
  const restaurants = [];
  const parkingLots = [];

  for (const element of elements ?? []) {
    const tags = element.tags ?? {};
    const location = pointFromElement(element);
    if (!location) continue;

    if (tags.amenity === "parking" || parkingHints(tags).includes("on_site")) {
      parkingLots.push({
        id: `osm_${element.type}_${element.id}`,
        name: tags.name || (tags.amenity === "parking" ? "時間貸駐車場の可能性" : "店舗駐車場の可能性"),
        location
      });
      if (tags.amenity === "parking") continue;
    }

    restaurants.push({
      id: `osm_${element.type}_${element.id}`,
      name: tags.name || tags["name:ja"] || "名称未設定の候補",
      category: tags.amenity ?? tags.shop ?? "food",
      location,
      pickupTypes: pickupTypes(tags),
      parkingHints: parkingHints(tags),
      estimatedStayMinutes: tags.amenity === "fast_food" || tags.shop ? 12 : 20,
      dataSources: ["overpass_osm"],
      sourceNote: "OpenStreetMap/Overpassのライブ取得データです。営業状況と受取方法は現地・店舗側で確認してください。"
    });
  }

  return {
    restaurants: restaurants.slice(0, 40),
    parkingLots: parkingLots.slice(0, 60)
  };
}

function normalizeStoreParkingHints(elements) {
  const storeParkingHints = [];
  for (const element of elements ?? []) {
    const tags = element.tags ?? {};
    const location = pointFromElement(element);
    if (!location) continue;
    if (!tags.shop && !["fast_food", "restaurant", "cafe"].includes(tags.amenity)) continue;
    if (!parkingHints(tags).includes("on_site")) continue;
    storeParkingHints.push({
      id: `osm_store_parking_${element.type}_${element.id}`,
      name: tags.name || tags.brand || "店舗駐車場タグ付き店舗",
      brand: tags.brand || "",
      category: categoryFromTags(tags),
      location,
      parkingTag: tags.parking || tags["parking:condition"] || "unknown",
      source: "overpass_osm"
    });
  }
  return storeParkingHints.slice(0, 120);
}

function nearestParking(parkingLots, restaurant, maxMeters) {
  return parkingLots
    .map((lot) => ({ ...lot, distanceM: distanceMeters(restaurant.location, lot.location) }))
    .filter((lot) => lot.distanceM <= maxMeters)
    .sort((a, b) => a.distanceM - b.distanceM)[0];
}

function scoreRestaurant(restaurant, parkingLots, requestedLocation) {
  const distanceFromQueryM = Math.round(distanceMeters(requestedLocation, restaurant.location));
  const distancePenalty = recommendationDistancePenalty(distanceFromQueryM);
  const hasNonLeavingPickup =
    restaurant.pickupTypes.includes("drive_through") || restaurant.pickupTypes.includes("curbside_pickup");

  if (hasNonLeavingPickup) {
    return {
      ...restaurant,
      distanceFromQueryM,
      recommendedRank: "A",
      rankLabel: "車から受け取り",
      score: 95 - distancePenalty * 0.8,
      confidence: 0.78,
      nearestParkingCandidate: {
        type: "not_required",
        name: "車から受け取れる可能性",
        walkingDistanceM: 0,
        availability: "店舗側対応要確認"
      },
      caution: REQUIRED_CAUTION
    };
  }

  const lot = nearestParking(parkingLots, restaurant, 150);
  if (lot) {
    return {
      ...restaurant,
      distanceFromQueryM,
      recommendedRank: "C",
      rankLabel: "近くに駐車場",
      score: 68 - lot.distanceM / 30 - distancePenalty,
      confidence: 0.62,
      nearestParkingCandidate: {
        id: lot.id,
        type: "parking_lot",
        name: lot.name,
        location: lot.location,
        walkingDistanceM: Math.round(lot.distanceM),
        availability: "未確認",
        note: "満空未確認。入庫前に現地表示と料金を確認してください。"
      },
      caution: REQUIRED_CAUTION
    };
  }

  if (restaurant.parkingHints.includes("on_site")) {
    return {
      ...restaurant,
      distanceFromQueryM,
      recommendedRank: "C",
      rankLabel: "店舗駐車場の可能性",
      score: 64 - distancePenalty,
      confidence: 0.58,
      nearestParkingCandidate: {
        type: "on_site_parking",
        name: "店舗駐車場の可能性",
        location: restaurant.location,
        walkingDistanceM: 0,
        availability: "未確認",
        note: "地図データ上の駐車場情報です。現地で利用可否を確認してください。"
      },
      caution: REQUIRED_CAUTION
    };
  }

  return {
    ...restaurant,
    distanceFromQueryM,
    recommendedRank: "CAUTION",
    rankLabel: "駐車未確認",
    score: 10 - Math.min(10, distanceFromQueryM / 250),
    confidence: 0.35,
    nearestParkingCandidate: null,
    caution: `${REQUIRED_CAUTION} 近くに使えそうな駐車場所が見つからないため、駐車未確認として分けています。`
  };
}

function recommendationDistancePenalty(distanceM) {
  if (distanceM <= 250) return 0;
  return Math.min(28, (distanceM - 250) / 70);
}

export async function fetchStaticLunchSpots(query) {
  const key = cacheKey(query);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached.value;

  const body = new URLSearchParams({ data: buildOverpassQuery(query) });
  const response = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body
  });
  if (!response.ok) throw new Error(`Overpass API error ${response.status}`);

  const normalized = normalizeElements((await response.json()).elements);
  const requestedLocation = { lat: query.lat, lng: query.lng };
  const spots = normalized.restaurants
    .map((restaurant) => scoreRestaurant(restaurant, normalized.parkingLots, requestedLocation))
    .sort((a, b) => b.score - a.score);

  const value = {
    query: { ...query, timezone: "Asia/Tokyo" },
    generatedAt: new Date().toISOString(),
    liveDataStatus: {
      provider: "overpass_osm_static",
      used: true,
      message: `OpenStreetMapから飲食・テイクアウト候補${normalized.restaurants.length}件、駐車場候補${normalized.parkingLots.length}件を取得しました。`
    },
    policyNotice: REQUIRED_CAUTION,
    dataSources: [
      {
        source: "overpass_osm",
        label: "OpenStreetMap Overpass live search",
        updatedAt: new Date().toISOString().slice(0, 10),
        license: "ODbL",
        productionReady: false
      }
    ],
    safeSpots: spots.filter((spot) => spot.recommendedRank !== "CAUTION"),
    cautionSpots: spots.filter((spot) => spot.recommendedRank === "CAUTION")
  };

  cache.set(key, { createdAt: Date.now(), value });
  return value;
}

export async function fetchOsmParkingLots(query) {
  const key = `parking:${cacheKey(query)}`;
  const cached = parkingCache.get(key);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached.value;

  const body = new URLSearchParams({ data: buildParkingOnlyQuery(query) });
  const response = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body
  });
  if (!response.ok) throw new Error(`Overpass parking API error ${response.status}`);

  const normalized = normalizeElements((await response.json()).elements);
  const value = {
    parkingLots: normalized.parkingLots,
    message: `OSMから駐車場候補${normalized.parkingLots.length}件を補助取得しました。`
  };
  parkingCache.set(key, { createdAt: Date.now(), value });
  return value;
}

export async function fetchOsmStoreParkingHints(query) {
  const key = `store-parking:${cacheKey(query)}`;
  const cached = storeParkingCache.get(key);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached.value;

  const body = new URLSearchParams({ data: buildStoreParkingHintQuery(query) });
  const response = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body
  });
  if (!response.ok) throw new Error(`Overpass store parking API error ${response.status}`);

  const storeParkingHints = normalizeStoreParkingHints((await response.json()).elements);
  const value = {
    storeParkingHints,
    message: `OSMから店舗駐車場タグ${storeParkingHints.length}件を補助取得しました。`
  };
  storeParkingCache.set(key, { createdAt: Date.now(), value });
  return value;
}

export function clearStaticLunchSpotCache() {
  cache.clear();
  parkingCache.clear();
  storeParkingCache.clear();
}
