const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

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
      node(around:${radius},${lat},${lng})["amenity"~"restaurant|fast_food|cafe"];
      way(around:${radius},${lat},${lng})["amenity"~"restaurant|fast_food|cafe"];
      relation(around:${radius},${lat},${lng})["amenity"~"restaurant|fast_food|cafe"];
      node(around:${radius},${lat},${lng})["amenity"="food_court"];
      way(around:${radius},${lat},${lng})["amenity"="food_court"];
      node(around:${radius},${lat},${lng})["shop"~"convenience|bakery|deli|supermarket|greengrocer"];
      way(around:${radius},${lat},${lng})["shop"~"convenience|bakery|deli|supermarket|greengrocer"];
      node(around:${radius},${lat},${lng})["amenity"="parking"];
      way(around:${radius},${lat},${lng})["amenity"="parking"];
    );
    out center tags 80;
  `;
}

function pointFromElement(element) {
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function restaurantCategory(tags) {
  return tags.amenity ?? tags.shop ?? "food";
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

function parkingHints(tags) {
  const hints = [];
  if (["yes", "customers", "surface", "underground", "multi-storey"].includes(tags.parking)) {
    hints.push("on_site");
  }
  if (tags["parking:condition:right"] || tags["parking:condition:left"] || tags["parking:lane:right"] || tags["parking:lane:left"]) {
    hints.push("street_side_unverified");
  }
  return hints;
}

function toRestaurant(element) {
  const location = pointFromElement(element);
  if (!location) return null;
  const tags = element.tags ?? {};
  return {
    id: `osm_${element.type}_${element.id}`,
    name: tags.name || tags["name:ja"] || "名称未設定の飲食候補",
    category: restaurantCategory(tags),
    location,
    pickupTypes: pickupTypes(tags),
    parkingHints: parkingHints(tags),
    estimatedStayMinutes: tags.amenity === "fast_food" || tags.shop ? 12 : 20,
    dataSources: ["overpass_osm"],
    sourceNote: "OpenStreetMap/Overpassのライブ取得データです。営業状況と受取方法は現地・店舗側で確認してください。"
  };
}

function toParkingLot(element) {
  const location = pointFromElement(element);
  if (!location) return null;
  const tags = element.tags ?? {};
  return {
    id: `osm_${element.type}_${element.id}`,
    name: tags.name || "OSM時間貸駐車場候補",
    location,
    capacity: tags.capacity ? Number.parseInt(tags.capacity, 10) : null,
    availability: "unknown",
    source: "overpass_osm"
  };
}

function normalizeOverpass(json) {
  const restaurants = [];
  const parkingLots = [];

  for (const element of json.elements ?? []) {
    const tags = element.tags ?? {};
    if (tags.amenity === "parking") {
      const lot = toParkingLot(element);
      if (lot) parkingLots.push(lot);
      continue;
    }

    if (tags.amenity || tags.shop) {
      const restaurant = toRestaurant(element);
      if (restaurant) restaurants.push(restaurant);
    }
  }

  return {
    restaurants: restaurants.slice(0, 40),
    parkingLots: parkingLots.slice(0, 60),
    auditLog: {
      source: "overpass_osm",
      label: "OpenStreetMap Overpass live search",
      updatedAt: new Date().toISOString().slice(0, 10),
      license: "ODbL",
      productionReady: false
    }
  };
}

export async function fetchOverpassLunchData(query, fetchImpl = fetch) {
  const key = cacheKey(query);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached.value;

  const body = new URLSearchParams({ data: buildOverpassQuery(query) });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 14000);

  try {
    const response = await fetchImpl(OVERPASS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "park-park-lunch-mvp/0.1"
      },
      body,
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`Overpass API error ${response.status}`);
    const value = normalizeOverpass(await response.json());
    cache.set(key, { createdAt: Date.now(), value });
    return value;
  } finally {
    clearTimeout(timeout);
  }
}
