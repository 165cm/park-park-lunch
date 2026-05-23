import { clearStaticLunchSpotCache, fetchOsmParkingLots, fetchStaticLunchSpots } from "./static-search.js?v=4";

const DEFAULT_LOCATION = { lat: 35.681236, lng: 139.767125 };
const DATA_VERSION = "2026-05-24-google-places-new-1";
const REQUIRED_CAUTION =
  "現地標識確認必須。本アプリは駐車許可を保証しません。車を離れる場合は推奨された駐車施設を利用してください。";
const LOCATION_ALIASES = new Map([
  ["東京駅", DEFAULT_LOCATION],
  ["丸の内", { lat: 35.6811, lng: 139.7659 }],
  ["神田", { lat: 35.6928, lng: 139.7705 }],
  ["日本橋", { lat: 35.6847, lng: 139.7742 }],
  ["芝公園", { lat: 35.6543, lng: 139.7502 }],
  ["新宿", { lat: 35.6903, lng: 139.7004 }],
  ["芝浦", { lat: 35.6417, lng: 139.7579 }]
]);

const state = {
  location: DEFAULT_LOCATION,
  selectedTab: "safe",
  mapProvider: "google",
  map: null,
  markers: [],
  currentData: null,
  infoWindow: null,
  geocoder: null,
  googleMapsApiKey: "",
  requestId: 0,
  loadingTimer: null,
  loadingStartedAt: 0
};

const elements = {
  form: document.querySelector("#searchForm"),
  locationInput: document.querySelector("#locationInput"),
  vehicleType: document.querySelector("#vehicleType"),
  timeInput: document.querySelector("#timeInput"),
  radiusInput: document.querySelector("#radiusInput"),
  resultLimit: document.querySelector("#resultLimit"),
  genreFilter: document.querySelector("#genreFilter"),
  locateButton: document.querySelector("#locateButton"),
  searchButton: document.querySelector("#searchButton"),
  safeTab: document.querySelector("#safeTab"),
  cautionTab: document.querySelector("#cautionTab"),
  spotList: document.querySelector("#spotList"),
  safeCount: document.querySelector("#safeCount"),
  cautionCount: document.querySelector("#cautionCount"),
  liveStatus: document.querySelector("#liveStatus"),
  speedStatus: document.querySelector("#speedStatus"),
  driveLock: document.querySelector("#driveLock"),
  lockSpeed: document.querySelector("#lockSpeed"),
  map: document.querySelector("#map"),
  mapCredit: document.querySelector("#mapCredit")
};

async function init() {
  await resetStaleLocalData();
  elements.timeInput.value = currentTimeValue();
  await initMap();
  bindEvents();
  watchSpeed();
  registerServiceWorker();
  setStatus("条件を設定して「この場所で探す」を押してください。", "idle");
}

async function resetStaleLocalData() {
  const storageKey = "parkParkLunchDataVersion";
  let previousVersion = null;
  try {
    previousVersion = window.localStorage?.getItem(storageKey);
  } catch {
    previousVersion = null;
  }
  if (previousVersion === DATA_VERSION) return;

  clearStaticLunchSpotCache();
  state.currentData = null;
  try {
    window.localStorage?.setItem(storageKey, DATA_VERSION);
  } catch {
  }

  if (!("caches" in window)) return;
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith("park-park-lunch-")).map((key) => caches.delete(key)));
}

function currentTimeValue() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

async function initMap() {
  const config = await loadConfig();
  state.googleMapsApiKey = config.googleMapsApiKey;
  if (!config.googleMapsApiKey) {
    showMapError("Google Maps APIキーが未設定です。", "GOOGLE_MAPS_API_KEY を設定してサーバーを再起動してください。");
    return;
  }

  const loaded = await loadGoogleMaps(config.googleMapsApiKey);
  if (!loaded) {
    showMapError("Google Mapsを読み込めませんでした。", "ネットワーク、APIキー、Maps JavaScript APIの有効化状態を確認してください。");
    return;
  }
  initGoogleMap();
  scheduleGoogleAuthErrorNotice();
}

async function loadConfig() {
  try {
    const response = await fetch("api/config");
    if (response.ok) return await response.json();
  } catch {
  }

  const staticConfig = window.PARK_PARK_LUNCH_CONFIG ?? {};
  return {
    preferredMapProvider: staticConfig.googleMapsApiKey ? "google" : "static",
    googleMapsApiKey: staticConfig.googleMapsApiKey ?? ""
  };
}

function loadGoogleMaps(apiKey) {
  if (window.google?.maps) return Promise.resolve(true);

  return new Promise((resolve) => {
    const callbackName = `initGoogleMaps_${Date.now()}`;
    window[callbackName] = () => {
      delete window[callbackName];
      resolve(true);
    };

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&language=ja&region=JP&callback=${callbackName}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      delete window[callbackName];
      resolve(false);
    };
    document.head.append(script);
  });
}

function initGoogleMap() {
  state.mapProvider = "google";
  state.markers = [];
  elements.map.innerHTML = "";
  state.map = new google.maps.Map(elements.map, {
    center: state.location,
    zoom: 14,
    zoomControl: true,
    zoomControlOptions: {
      position: google.maps.ControlPosition.RIGHT_TOP
    },
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    gestureHandling: "greedy",
    clickableIcons: true
  });
  state.infoWindow = new google.maps.InfoWindow();
  elements.mapCredit.textContent = "Google Maps / Places API店舗 + OSM駐車補助";
}

function scheduleGoogleAuthErrorNotice() {
  setTimeout(() => {
    if (state.mapProvider !== "google") return;
    if (!elements.map.querySelector(".gm-err-container")) return;
    showMapError(
      "Google Mapsの認証エラーです。",
      "Google Cloud Consoleで、このAPIキーのHTTPリファラーに http://localhost:4173/* を追加してください。"
    );
  }, 2500);
}

function showMapError(title, message) {
  elements.map.innerHTML = `
    <div class="map-error">
      <div class="map-error-inner">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <p>このMVPはGoogle Maps限定表示に設定されています。</p>
      </div>
    </div>
  `;
  elements.mapCredit.textContent = "Google Maps / 認証確認中";
}

function bindEvents() {
  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const typedLocation = elements.locationInput.value.trim();
    if (typedLocation) {
      setStatus("入力された場所を確認中です…", "loading");
      const resolved = await resolveLocationInput(typedLocation);
      if (!resolved) {
        setStatus("場所が見つかりませんでした。駅名・住所、または「35.681,139.767」の形式で入力してください。", "error");
        elements.locationInput.focus();
        return;
      }
      setLocation(resolved, false, { refresh: false });
    }
    updateSpots();
  });

  elements.locateButton.addEventListener("click", () => {
    if (!navigator.geolocation) {
      setStatus("このブラウザでは現在地を取得できません。駅名・住所で検索してください。", "error");
      return;
    }
    setStatus("現在地を確認中です…", "loading");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude
        }, true, { refresh: false });
        setStatus("現在地を設定しました。条件を確認してから検索してください。", "active");
      },
      () => {
        setStatus("現在地を取得できませんでした。駅名・住所で検索してください。", "error");
        elements.locationInput.focus();
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  });

  elements.safeTab.addEventListener("click", () => switchTab("safe"));
  elements.cautionTab.addEventListener("click", () => switchTab("caution"));
  bindChoiceGroup("vehicleTypeChoice", elements.vehicleType);
  bindChoiceGroup("radiusChoice", elements.radiusInput);
  bindChoiceGroup("resultLimitChoice", elements.resultLimit, refreshVisibleResults);
  bindChoiceGroup("genreChoice", elements.genreFilter, refreshVisibleResults);
}

function bindChoiceGroup(name, targetInput, onChange) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      targetInput.value = input.value;
      onChange?.();
    });
  });
}

async function resolveLocationInput(value) {
  const parsed = parseLocationInput(value);
  if (parsed) return parsed;
  return geocodeAddress(value);
}

function parseLocationInput(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (LOCATION_ALIASES.has(trimmed)) return LOCATION_ALIASES.get(trimmed);

  const match = trimmed.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;

  const lat = Number.parseFloat(match[1]);
  const lng = Number.parseFloat(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function geocodeAddress(address) {
  if (!window.google?.maps) return null;
  if (!state.geocoder) {
    if (!google.maps.Geocoder && google.maps.importLibrary) {
      const { Geocoder } = await google.maps.importLibrary("geocoding");
      state.geocoder = new Geocoder();
    } else if (google.maps.Geocoder) {
      state.geocoder = new google.maps.Geocoder();
    }
  }
  if (!state.geocoder) return null;
  const tokyoBounds = new google.maps.LatLngBounds(
    new google.maps.LatLng(35.45, 139.45),
    new google.maps.LatLng(35.9, 140.05)
  );
  return new Promise((resolve) => {
    state.geocoder.geocode(
      {
        address,
        bounds: tokyoBounds,
        componentRestrictions: { country: "JP" },
        region: "JP"
      },
      (results, status) => {
        if (status !== "OK" || !results?.[0]?.geometry?.location) {
          resolve(null);
          return;
        }
        const location = results[0].geometry.location;
        resolve({ lat: location.lat(), lng: location.lng() });
      }
    );
  });
}

function setLocation(location, updateInput = true, options = {}) {
  state.location = location;
  if (updateInput) elements.locationInput.value = `${location.lat.toFixed(6)},${location.lng.toFixed(6)}`;
  if (state.mapProvider === "google") {
    state.map.setCenter(location);
    state.map.setZoom(Math.max(state.map.getZoom(), 14));
  }
  if (options.refresh !== false) updateSpots();
}

async function updateSpots() {
  const requestId = ++state.requestId;
  setLoading(true, "周辺の飲食・テイクアウト候補と駐車候補を検索中です…");
  renderLoadingList();

  const params = new URLSearchParams({
    lat: String(state.location.lat),
    lng: String(state.location.lng),
    radiusM: elements.radiusInput.value,
    vehicleType: elements.vehicleType.value,
    time: elements.timeInput.value
  });

  try {
    state.currentData = await fetchGoogleLunchSpots({
      lat: state.location.lat,
      lng: state.location.lng,
      radiusM: Number.parseInt(elements.radiusInput.value, 10),
      vehicleType: elements.vehicleType.value,
      time: elements.timeInput.value
    });
  } catch {
    try {
      state.currentData = await fetchStaticLunchSpots({
        lat: state.location.lat,
        lng: state.location.lng,
        radiusM: Number.parseInt(elements.radiusInput.value, 10),
        vehicleType: elements.vehicleType.value,
        time: elements.timeInput.value
      });
    } catch {
      state.currentData = emptyResult();
    }
  }
  if (requestId !== state.requestId) return;

  updateResultCounts();
  const liveStatus = state.currentData.liveDataStatus;
  setStatus(liveStatus?.message ?? "周辺のお店と駐車場を取得しました。", liveStatus?.used ? "active" : "error");
  setLoading(false);
  renderList();
  renderMarkers();
}

async function fetchGoogleLunchSpots(query) {
  const restaurants = await fetchGooglePlacesRestaurants(query);
  let parkingResult = { parkingLots: [], message: "駐車場補助データは未取得です。" };
  try {
    parkingResult = await fetchOsmParkingLots(query);
  } catch {
  }

  const requestedLocation = { lat: query.lat, lng: query.lng };
  const spots = restaurants
    .map((restaurant) => scoreRestaurantWithParking(restaurant, parkingResult.parkingLots, requestedLocation))
    .sort((a, b) => b.score - a.score);

  return {
    query: { ...query, timezone: "Asia/Tokyo" },
    generatedAt: new Date().toISOString(),
    liveDataStatus: {
      provider: "google_places_osm_parking",
      used: true,
      message: `Google Placesから店舗候補${restaurants.length}件、${parkingResult.message}`
    },
    policyNotice: REQUIRED_CAUTION,
    dataSources: [
      { source: "google_places", label: "Google Places", updatedAt: new Date().toISOString().slice(0, 10) },
      { source: "overpass_osm", label: "OpenStreetMap parking helper", updatedAt: new Date().toISOString().slice(0, 10) }
    ],
    safeSpots: spots.filter((spot) => spot.recommendedRank !== "CAUTION"),
    cautionSpots: spots.filter((spot) => spot.recommendedRank === "CAUTION")
  };
}

async function fetchGooglePlacesRestaurants(query) {
  const types = googlePlaceSearchTypes(elements.genreFilter.value);
  const results = await Promise.all(types.map((type) => nearbySearchNew(query, type)));
  const deduped = new Map();
  for (const place of results.flat()) {
    if (!place.id || !place.location || place.businessStatus === "CLOSED_PERMANENTLY") continue;
    deduped.set(place.id, place);
  }
  return [...deduped.values()].map(toGoogleRestaurant).slice(0, 40);
}

async function nearbySearchNew(query, includedType) {
  if (!state.googleMapsApiKey) throw new Error("Google Places API key is unavailable");
  const response = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": state.googleMapsApiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.types,places.businessStatus"
    },
    body: JSON.stringify({
      includedTypes: [includedType],
      maxResultCount: 20,
      rankPreference: "DISTANCE",
      locationRestriction: {
        circle: {
          center: {
            latitude: query.lat,
            longitude: query.lng
          },
          radius: Math.min(query.radiusM, 5000)
        }
      }
    })
  });
  if (!response.ok) throw new Error(`Google Places API ${response.status}`);
  return (await response.json()).places ?? [];
}

function googlePlaceSearchTypes(genre) {
  const byGenre = {
    convenience: ["convenience_store"],
    fast_food: ["meal_takeaway"],
    cafe: ["cafe"],
    deli: ["bakery"],
    supermarket: ["supermarket"],
    restaurant: ["restaurant"]
  };
  return byGenre[genre] ?? ["restaurant", "cafe", "meal_takeaway", "convenience_store", "bakery", "supermarket"];
}

function toGoogleRestaurant(place) {
  const location = { lat: place.location.latitude, lng: place.location.longitude };
  const types = place.types ?? [];
  return {
    id: `google_${place.id}`,
    placeId: place.id,
    name: place.displayName?.text ?? "名称未設定の候補",
    category: googleCategory(types),
    location,
    pickupTypes: googlePickupTypes(types),
    parkingHints: [],
    estimatedStayMinutes: types.includes("convenience_store") || types.includes("meal_takeaway") ? 10 : 18,
    dataSources: ["google_places"],
    sourceNote: "Google Placesの店舗候補です。営業状況と受取方法は店舗側で確認してください。"
  };
}

function googleCategory(types) {
  if (types.includes("convenience_store")) return "convenience";
  if (types.includes("cafe")) return "cafe";
  if (types.includes("bakery")) return "bakery";
  if (types.includes("supermarket")) return "supermarket";
  if (types.includes("meal_takeaway")) return "fast_food";
  return "restaurant";
}

function googlePickupTypes(types) {
  if (types.includes("convenience_store") || types.includes("meal_takeaway") || types.includes("bakery") || types.includes("supermarket")) {
    return ["takeout"];
  }
  return ["eat_in", "takeout"];
}

function scoreRestaurantWithParking(restaurant, parkingLots, requestedLocation) {
  const distanceFromQueryM = Math.round(distanceMeters(requestedLocation, restaurant.location));
  const distancePenalty = recommendationDistancePenalty(distanceFromQueryM);
  const lot = nearestParking(parkingLots, restaurant, 150);

  if (restaurant.pickupTypes.includes("drive_through") || restaurant.pickupTypes.includes("curbside_pickup")) {
    return {
      ...restaurant,
      distanceFromQueryM,
      recommendedRank: "A",
      rankLabel: "車から受け取り",
      score: 95 - distancePenalty * 0.8,
      confidence: 0.82,
      nearestParkingCandidate: {
        type: "not_required",
        name: "車から受け取れる可能性",
        walkingDistanceM: 0,
        availability: "店舗側対応要確認"
      },
      caution: REQUIRED_CAUTION
    };
  }

  if (lot) {
    return {
      ...restaurant,
      distanceFromQueryM,
      recommendedRank: "C",
      rankLabel: "近くに駐車場",
      score: 68 - lot.distanceM / 30 - distancePenalty,
      confidence: 0.7,
      nearestParkingCandidate: {
        id: lot.id,
        type: "parking_lot",
        name: lot.name,
        location: lot.location,
        walkingDistanceM: Math.round(lot.distanceM),
        availability: "未確認"
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
    confidence: 0.52,
    nearestParkingCandidate: null,
    caution: REQUIRED_CAUTION
  };
}

function nearestParking(parkingLots, restaurant, maxMeters) {
  return parkingLots
    .map((lot) => ({ ...lot, distanceM: distanceMeters(restaurant.location, lot.location) }))
    .filter((lot) => lot.distanceM <= maxMeters)
    .sort((a, b) => a.distanceM - b.distanceM)[0];
}

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

function recommendationDistancePenalty(distanceM) {
  if (distanceM <= 250) return 0;
  return Math.min(28, (distanceM - 250) / 70);
}

function emptyResult() {
  return {
    query: {
      lat: state.location.lat,
      lng: state.location.lng,
      radiusM: Number.parseInt(elements.radiusInput.value, 10),
      vehicleType: elements.vehicleType.value,
      time: elements.timeInput.value
    },
    generatedAt: new Date().toISOString(),
    liveDataStatus: {
      used: false,
      message: "検索先が混み合っています。少し時間を置いてもう一度お試しください。"
    },
    safeSpots: [],
    cautionSpots: []
  };
}

function setLoading(isLoading, message) {
  elements.form.classList.toggle("is-loading", isLoading);
  elements.searchButton.disabled = isLoading;
  elements.locateButton.disabled = isLoading;
  window.clearInterval(state.loadingTimer);
  state.loadingTimer = null;
  if (!isLoading) return;

  state.loadingStartedAt = Date.now();
  const update = () => {
    const seconds = Math.floor((Date.now() - state.loadingStartedAt) / 1000);
    setStatus(`${message} ${seconds}秒`, "loading");
  };
  update();
  state.loadingTimer = window.setInterval(update, 1000);
}

function setStatus(message, mode = "active") {
  elements.liveStatus.textContent = message;
  elements.liveStatus.classList.toggle("active", mode === "active");
  elements.liveStatus.classList.toggle("loading", mode === "loading");
  elements.liveStatus.classList.toggle("error", mode === "error");
}

function switchTab(tab) {
  state.selectedTab = tab;
  elements.safeTab.classList.toggle("active", tab === "safe");
  elements.cautionTab.classList.toggle("active", tab === "caution");
  elements.safeTab.setAttribute("aria-selected", String(tab === "safe"));
  elements.cautionTab.setAttribute("aria-selected", String(tab === "caution"));
  refreshVisibleResults();
}

function refreshVisibleResults() {
  if (!state.currentData) return;
  updateResultCounts();
  renderList();
  renderMarkers();
}

function filteredSpots(tab) {
  const data = state.currentData;
  if (!data) return [];
  const source = tab === "safe" ? data.safeSpots : data.cautionSpots;
  const genre = elements.genreFilter.value;
  const filtered = genre === "all" ? source : source.filter((spot) => spotGenre(spot) === genre);
  const sorted = [...filtered].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const limit = elements.resultLimit.value;
  return limit === "all" ? sorted : sorted.slice(0, Number.parseInt(limit, 10));
}

function updateResultCounts() {
  elements.safeCount.textContent = String(filteredSpots("safe").length);
  elements.cautionCount.textContent = String(filteredSpots("caution").length);
}

function spotGenre(spot) {
  const category = spot.category ?? "";
  if (category === "convenience") return "convenience";
  if (category === "fast_food" || spot.pickupTypes?.includes("drive_through")) return "fast_food";
  if (category === "cafe") return "cafe";
  if (category === "deli" || category === "bakery" || category === "greengrocer") return "deli";
  if (category === "supermarket") return "supermarket";
  return "restaurant";
}

function renderList() {
  if (!state.currentData) return;
  const spots = filteredSpots(state.selectedTab);

  if (!spots.length) {
    elements.spotList.innerHTML = `<div class="empty">この条件で表示できる候補がありません</div>`;
    return;
  }

  elements.spotList.innerHTML = spots.map((spot) => spotCard(spot)).join("");
}

function spotCard(spot) {
  const parking = spot.nearestParkingCandidate;
  const mapUrl = googleMapsPointUrl(spot);
  const streetViewUrl = googleMapsStreetViewUrl(spot.location);
  const pickupText = pickupLabels(spot.pickupTypes);
  const genreText = genreLabels()[spotGenre(spot)];
  const parkingText = parking
    ? `🅿️ 徒歩${parking.walkingDistanceM}m ${parking.availability}`
    : "❔ 駐車未確認";
  const showParkingText = Boolean(parking) || spot.recommendedRank !== "CAUTION";

  return `
    <article class="spot-card rank-${spot.recommendedRank}">
      <div class="spot-title">
        <h2>${escapeHtml(spot.name)}</h2>
        <span class="genre-label">${escapeHtml(genreText)}</span>
      </div>
      <div class="spot-meta">
        <span class="badge">${escapeHtml(spot.rankLabel)}</span>
        <span class="badge distance">📍 ${spot.distanceFromQueryM}m</span>
        <span class="badge warning">信頼度 ${Math.round(spot.confidence * 100)}%</span>
      </div>
      <div class="spot-quick-info">
        <span>🥡 ${escapeHtml(pickupText)}</span>
        ${showParkingText ? `<span>${escapeHtml(parkingText)}</span>` : ""}
      </div>
      <div class="spot-actions">
        <a href="${mapUrl}" target="_blank" rel="noreferrer">Google Map</a>
        <a href="${streetViewUrl}" target="_blank" rel="noreferrer">店前を確認</a>
      </div>
    </article>
  `;
}

function googleMapsPointUrl(spot) {
  if (spot.placeId) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(spot.name)}&query_place_id=${encodeURIComponent(spot.placeId)}`;
  }
  return `https://www.google.com/maps/@${spot.location.lat},${spot.location.lng},18z`;
}

function googleMapsStreetViewUrl(location) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${location.lat},${location.lng}`;
}

function genreLabels() {
  return {
    convenience: "コンビニ",
    fast_food: "ファストフード",
    cafe: "カフェ",
    deli: "弁当・惣菜",
    supermarket: "スーパー",
    restaurant: "飲食店"
  };
}

function renderLoadingList() {
  elements.spotList.innerHTML = `
    <div class="loading-card"></div>
    <div class="loading-card"></div>
    <div class="loading-card"></div>
  `;
}

function pickupLabels(types) {
  const labels = {
    drive_through: "ドライブスルー",
    curbside_pickup: "カーブサイド",
    takeout: "テイクアウト",
    eat_in: "店内",
    convenience: "コンビニ"
  };
  return types.map((type) => labels[type] ?? type).join(" / ") || "受取方法未確認";
}

function renderMarkers() {
  if (!state.currentData) return;
  const spots = filteredSpots(state.selectedTab);

  if (state.mapProvider === "google") {
    state.markers.forEach((marker) => marker.setMap(null));
    state.markers = [];

    state.markers.push(
      new google.maps.Marker({
        position: state.location,
        map: state.map,
        title: "検索地点",
        icon: markerIcon("QUERY")
      })
    );

    for (const spot of spots) {
      const marker = new google.maps.Marker({
        position: spot.location,
        map: state.map,
        title: spot.name,
        icon: markerIcon(spot.recommendedRank),
        label: markerLabel(spot.recommendedRank)
      });
      marker.spotId = spot.id;
      marker.addListener("click", () => openGoogleInfoWindow(marker, spot));
      state.markers.push(marker);
    }
    return;
  }

}

function markerIcon(rank) {
  const colors = {
    QUERY: { fill: "#f8c35a", stroke: "#14362f" },
    A: { fill: "#16845b", stroke: "#ffffff" },
    B: { fill: "#1768a6", stroke: "#ffffff" },
    C: { fill: "#b56a00", stroke: "#ffffff" },
    CAUTION: { fill: "#b42318", stroke: "#ffffff" }
  };
  const color = colors[rank] ?? colors.CAUTION;
  return {
    path: "M12 2C8.1 2 5 5.1 5 9c0 5.3 7 13 7 13s7-7.7 7-13c0-3.9-3.1-7-7-7z",
    fillColor: color.fill,
    fillOpacity: 1,
    strokeColor: color.stroke,
    strokeWeight: 2,
    scale: rank === "QUERY" ? 1.35 : 1.45,
    anchor: new google.maps.Point(12, 22),
    labelOrigin: new google.maps.Point(12, 9)
  };
}

function markerLabel(rank) {
  const text = {
    QUERY: "●",
    A: "車",
    B: "P",
    C: "P",
    CAUTION: "?"
  }[rank];
  return {
    text,
    color: rank === "QUERY" ? "#14362f" : "#ffffff",
    fontSize: rank === "A" ? "10px" : "12px",
    fontWeight: "800"
  };
}

function openGoogleInfoWindow(marker, spot) {
  state.infoWindow.setContent(`<strong>${escapeHtml(spot.name)}</strong><br>${escapeHtml(spot.rankLabel)}`);
  state.infoWindow.open({ map: state.map, anchor: marker });
}

function focusSpot(spotId) {
  const spots = [...(state.currentData?.safeSpots ?? []), ...(state.currentData?.cautionSpots ?? [])];
  const spot = spots.find((candidate) => candidate.id === spotId);
  if (!spot) return;
  if (state.mapProvider === "google") {
    state.map.setCenter(spot.location);
    state.map.setZoom(16);
    const marker = state.markers.find((item) => item.spotId === spotId);
    if (marker) openGoogleInfoWindow(marker, spot);
  }
}

function watchSpeed() {
  if (!navigator.geolocation) {
    elements.speedStatus.textContent = "速度取得なし";
    return;
  }

  navigator.geolocation.watchPosition(
    (position) => {
      const speedKmh = position.coords.speed == null ? 0 : position.coords.speed * 3.6;
      const locked = speedKmh >= 10;
      elements.speedStatus.textContent = locked ? `${Math.round(speedKmh)}km/h ロック中` : "停車中";
      elements.driveLock.classList.toggle("hidden", !locked);
      elements.lockSpeed.textContent = `${Math.round(speedKmh)}km/h`;
    },
    () => {
      elements.speedStatus.textContent = "速度取得なし";
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    navigator.serviceWorker.getRegistrations?.().then((registrations) => {
      registrations.forEach((registration) => registration.unregister());
    });
    return;
  }
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[char];
  });
}

init();
