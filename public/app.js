import { clearStaticLunchSpotCache, fetchOsmStoreParkingHints } from "./static-search.js?v=5";

const DEFAULT_LOCATION = { lat: 35.681236, lng: 139.767125 };
const DATA_VERSION = "2026-05-24-onsite-chain-parking-1";
const GOOGLE_PLACES_CACHE_TTL_MS = 10 * 60 * 1000;
const REQUIRED_CAUTION =
  "現地標識確認必須。本アプリは駐車許可を保証しません。車を離れる場合は推奨された駐車施設を利用してください。";
const CHAIN_CATALOG = [
  { id: "mcdonalds", label: "マクドナルド", query: "マクドナルド", genre: "fast_food", pattern: /マクドナルド|mcdonald/i },
  { id: "kfc", label: "ケンタッキー", query: "ケンタッキー", genre: "fast_food", pattern: /ケンタッキー|kfc/i },
  { id: "mos", label: "モスバーガー", query: "モスバーガー", genre: "fast_food", pattern: /モスバーガー|mos burger/i },
  { id: "burger_king", label: "バーガーキング", query: "バーガーキング", genre: "fast_food", pattern: /バーガーキング|burger king/i },
  { id: "sukiya", label: "すき家", query: "すき家", genre: "beef_bowl", pattern: /すき家|sukiya/i },
  { id: "yoshinoya", label: "吉野家", query: "吉野家", genre: "beef_bowl", pattern: /吉野家|yoshinoya/i },
  { id: "matsuya", label: "松屋", query: "松屋", genre: "beef_bowl", pattern: /松屋|matsuya/i },
  { id: "nakau", label: "なか卯", query: "なか卯", genre: "beef_bowl", pattern: /なか卯|nakau/i },
  { id: "hotto_motto", label: "ほっともっと", query: "ほっともっと", genre: "deli", pattern: /ほっともっと|hotto motto/i },
  { id: "origin", label: "オリジン弁当", query: "オリジン弁当", genre: "deli", pattern: /オリジン|origin/i }
];
const LOCATION_ALIASES = new Map([
  ["東京駅", DEFAULT_LOCATION],
  ["丸の内", { lat: 35.6811, lng: 139.7659 }],
  ["神田", { lat: 35.6928, lng: 139.7705 }],
  ["日本橋", { lat: 35.6847, lng: 139.7742 }],
  ["芝公園", { lat: 35.6543, lng: 139.7502 }],
  ["新宿", { lat: 35.6903, lng: 139.7004 }],
  ["芝浦", { lat: 35.6417, lng: 139.7579 }]
]);

let pendingSearchAction = null;

const state = {
  location: DEFAULT_LOCATION,
  selectedTab: "safe",
  mapProvider: "google",
  map: null,
  markers: [],
  currentData: null,
  infoWindow: null,
  geocoder: null,
  streetViewService: null,
  streetViewUrlCache: new Map(),
  googleMapsApiKey: "",
  requestId: 0,
  loadingTimer: null,
  loadingStartedAt: 0,
  googlePlacesCache: new Map()
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
  mapCredit: document.querySelector("#mapCredit"),
  passwordGate: document.querySelector("#passwordGate"),
  passwordForm: document.querySelector("#passwordForm"),
  passwordInput: document.querySelector("#passwordInput"),
  passwordSubmit: document.querySelector("#passwordSubmit"),
  passwordError: document.querySelector("#passwordError")
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
  state.googlePlacesCache.clear();
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
  state.streetViewService = new google.maps.StreetViewService();
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
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showPasswordGate(doSearch);
      return;
    }
    doSearch();
  });

  elements.passwordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = elements.passwordInput.value;
    elements.passwordSubmit.disabled = true;
    const hash = await sha256Hex(input);
    if (hash === window.PARK_PARK_LUNCH_CONFIG?.passwordHash) {
      setAuthed();
      hidePasswordGate();
      const action = pendingSearchAction;
      pendingSearchAction = null;
      action?.();
    } else {
      elements.passwordError.textContent = "パスワードが正しくありません。";
      elements.passwordInput.value = "";
      elements.passwordInput.focus();
      elements.passwordSubmit.disabled = false;
    }
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

  elements.spotList.addEventListener("click", async (event) => {
    const link = event.target.closest("[data-road-view]");
    if (!link) return;
    event.preventDefault();
    const lat = Number.parseFloat(link.dataset.lat);
    const lng = Number.parseFloat(link.dataset.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      window.open(link.href, "_blank", "noopener,noreferrer");
      return;
    }
    const originalText = link.textContent;
    link.textContent = "道路ビュー確認中";
    link.setAttribute("aria-busy", "true");
    try {
      const url = await googleMapsRoadStreetViewUrl({ lat, lng });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      window.open(link.href, "_blank", "noopener,noreferrer");
    } finally {
      link.textContent = originalText;
      link.removeAttribute("aria-busy");
    }
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
  setLoading(true, "店舗駐車場つきチェーン候補を検索中です…");
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
    state.currentData = emptyResult();
  }
  if (requestId !== state.requestId) return;

  if (!state.currentData.safeSpots.length && state.currentData.cautionSpots.length) {
    state.selectedTab = "caution";
    elements.safeTab.classList.remove("active");
    elements.cautionTab.classList.add("active");
    elements.safeTab.setAttribute("aria-selected", "false");
    elements.cautionTab.setAttribute("aria-selected", "true");
  }
  updateResultCounts();
  const liveStatus = state.currentData.liveDataStatus;
  setStatus(liveStatus?.message ?? "周辺のお店と駐車場を取得しました。", liveStatus?.used ? "active" : "error");
  setLoading(false);
  renderList();
  renderMarkers();
}

async function fetchGoogleLunchSpots(query) {
  const googleResult = await fetchGooglePlacesRestaurants(query);
  const restaurants = googleResult.restaurants;
  let parkingResult = { storeParkingHints: [], message: "店舗駐車場タグは未取得です。" };
  try {
    parkingResult = await fetchOsmStoreParkingHints(query);
  } catch {
  }

  const requestedLocation = { lat: query.lat, lng: query.lng };
  const spots = restaurants
    .map((restaurant) => scoreRestaurantWithParking(restaurant, parkingResult.storeParkingHints, requestedLocation))
    .sort((a, b) => b.score - a.score);
  const safeSpots = spots.filter((spot) => spot.recommendedRank !== "CAUTION");

  return {
    query: { ...query, timezone: "Asia/Tokyo" },
    generatedAt: new Date().toISOString(),
    liveDataStatus: {
      provider: "google_places_osm_parking",
      used: true,
      message: googlePlacesStatusMessage(googleResult, parkingResult)
    },
    policyNotice: REQUIRED_CAUTION,
    dataSources: [
      { source: "google_places", label: "Google Places", updatedAt: new Date().toISOString().slice(0, 10) },
      { source: "overpass_osm", label: "OpenStreetMap store parking tags", updatedAt: new Date().toISOString().slice(0, 10) }
    ],
    emptyReason: safeSpots.length ? "" : "この条件で店舗駐車場つきチェーンは見つかりませんでした。半径を広げる、スーパーを選ぶ、場所を変えるのいずれかを試してください。",
    safeSpots,
    cautionSpots: []
  };
}

async function fetchGooglePlacesRestaurants(query) {
  const requests = googlePlaceSearchRequests(elements.genreFilter.value);
  const results = await Promise.all(requests.map((request) => fetchGooglePlacesRequest(query, request)));
  const deduped = new Map();
  for (const place of results.flat()) {
    if (!place.id || !place.location || place.businessStatus === "CLOSED_PERMANENTLY") continue;
    const existing = deduped.get(place.id);
    if (!existing || place.chainMatch) deduped.set(place.id, place);
  }
  const validPlaces = [...deduped.values()];
  const focusedPlaces = validPlaces.filter(isParkingFocusedGooglePlace);
  return {
    rawCount: validPlaces.length,
    focusedCount: focusedPlaces.length,
    restaurants: focusedPlaces.map((place) => toGoogleRestaurant(place)).slice(0, 40)
  };
}

function googlePlacesStatusMessage(googleResult, parkingResult) {
  if (!googleResult.restaurants.length) {
    return `Google Placesで対象チェーン候補は見つかりませんでした。${parkingResult.message}`;
  }
  return `Google Placesから対象チェーン候補${googleResult.restaurants.length}件、${parkingResult.message}`;
}

async function fetchGooglePlacesRequest(query, request) {
  if (request.kind === "nearby") {
    return (await nearbySearchNew(query, [request.includedType])).map((place) => ({
      ...place,
      chainCategory: request.category
    }));
  }
  return (await textSearchNew(query, request.chain)).map((place) => ({
    ...place,
    chainMatch: request.chain,
    chainCategory: request.chain.genre
  }));
}

async function nearbySearchNew(query, includedTypes) {
  if (!state.googleMapsApiKey) throw new Error("Google Places API key is unavailable");
  const cacheKey = googlePlacesCacheKey("nearby", query, includedTypes.join("|"));
  const cached = state.googlePlacesCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < GOOGLE_PLACES_CACHE_TTL_MS) return cached.value;

  const response = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": state.googleMapsApiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.types,places.businessStatus"
    },
    body: JSON.stringify({
      includedTypes,
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
  const value = (await response.json()).places ?? [];
  state.googlePlacesCache.set(cacheKey, { createdAt: Date.now(), value });
  return value;
}

async function textSearchNew(query, chain) {
  if (!state.googleMapsApiKey) throw new Error("Google Places API key is unavailable");
  const cacheKey = googlePlacesCacheKey("text", query, chain.id);
  const cached = state.googlePlacesCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < GOOGLE_PLACES_CACHE_TTL_MS) return cached.value;

  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": state.googleMapsApiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.types,places.businessStatus"
    },
    body: JSON.stringify({
      textQuery: chain.query,
      languageCode: "ja",
      regionCode: "JP",
      maxResultCount: 5,
      locationBias: {
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
  if (!response.ok) throw new Error(`Google Places Text Search API ${response.status}`);
  const center = { lat: query.lat, lng: query.lng };
  const value = ((await response.json()).places ?? [])
    .filter((place) => place.location)
    .filter((place) => distanceMeters(center, { lat: place.location.latitude, lng: place.location.longitude }) <= query.radiusM)
    .filter((place) => chain.pattern.test(place.displayName?.text ?? ""));
  state.googlePlacesCache.set(cacheKey, { createdAt: Date.now(), value });
  return value;
}

function googlePlacesCacheKey(kind, query, subject) {
  const lat = Math.round(query.lat * 1000) / 1000;
  const lng = Math.round(query.lng * 1000) / 1000;
  const radius = Math.min(query.radiusM ?? 1500, 5000);
  return `${kind}:${subject}:${lat}:${lng}:${radius}`;
}

function googlePlaceSearchRequests(genre) {
  const requests = [];
  if (genre === "all" || genre === "convenience") {
    requests.push({ kind: "nearby", includedType: "convenience_store", category: "convenience" });
  }
  if (genre === "all" || genre === "supermarket") {
    requests.push({ kind: "nearby", includedType: "supermarket", category: "supermarket" });
  }
  const chainGenres = genre === "all" ? ["fast_food", "beef_bowl", "deli"] : [genre];
  const chainBudget = genre === "all" ? 6 : 8;
  const chainRequests = CHAIN_CATALOG
    .filter((chain) => chainGenres.includes(chain.genre))
    .slice(0, chainBudget)
    .map((chain) => ({ kind: "text", chain }));
  return [...requests, ...chainRequests];
}

function isParkingFocusedGooglePlace(place) {
  const name = place.displayName?.text ?? "";
  const types = place.types ?? [];
  if (place.chainMatch) return place.chainMatch.pattern.test(name);
  if (types.includes("supermarket")) return true;
  if (types.includes("convenience_store")) return true;
  return false;
}

function toGoogleRestaurant(place) {
  const location = { lat: place.location.latitude, lng: place.location.longitude };
  const types = place.types ?? [];
  const category = googleCategory(types, place);
  return {
    id: `google_${place.id}`,
    placeId: place.id,
    name: place.displayName?.text ?? "名称未設定の候補",
    category,
    location,
    pickupTypes: googlePickupTypes(types),
    parkingHints: vehicleFriendlyParkingHints(place),
    estimatedStayMinutes: types.includes("convenience_store") || types.includes("meal_takeaway") ? 10 : 18,
    dataSources: ["google_places"],
    sourceNote: "Google Placesからコンビニ・スーパー・チェーン店だけに絞っています。営業状況と駐車可否は現地で確認してください。"
  };
}

function vehicleFriendlyParkingHints(place) {
  const types = place.types ?? [];
  if (types.includes("supermarket")) return ["chain_parking_possible"];
  if (types.includes("convenience_store")) return ["chain_parking_possible"];
  if (place.chainMatch) return ["chain_parking_possible"];
  return [];
}

function googleCategory(types, place) {
  if (place.chainCategory) return place.chainCategory;
  if (types.includes("convenience_store")) return "convenience";
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

function scoreRestaurantWithParking(restaurant, storeParkingHints, requestedLocation) {
  const distanceFromQueryM = Math.round(distanceMeters(requestedLocation, restaurant.location));
  const distancePenalty = recommendationDistancePenalty(distanceFromQueryM);
  const isVehicleFocused = (restaurant.parkingHints ?? []).includes("chain_parking_possible");
  const storeParking = nearestStoreParkingHint(storeParkingHints, restaurant, 80);

  if (storeParking && isVehicleFocused) {
    return {
      ...restaurant,
      distanceFromQueryM,
      recommendedRank: "C",
      rankLabel: "店舗駐車場あり",
      score: 90 - storeParking.distanceM / 8 - distancePenalty * 0.35,
      confidence: storeParking.distanceM <= 35 ? 0.74 : 0.62,
      nearestParkingCandidate: {
        id: storeParking.id,
        type: "on_site_parking",
        name: storeParking.name,
        location: storeParking.location,
        walkingDistanceM: 0,
        availability: "店舗駐車場タグあり"
      },
      caution: REQUIRED_CAUTION
    };
  }

  return {
    ...restaurant,
    distanceFromQueryM,
    recommendedRank: "CAUTION",
    rankLabel: "店舗駐車場未確認",
    score: 10 - Math.min(10, distanceFromQueryM / 250),
    confidence: 0.35,
    nearestParkingCandidate: null,
    caution: REQUIRED_CAUTION
  };
}

function nearestStoreParkingHint(storeParkingHints, restaurant, maxMeters) {
  return storeParkingHints
    .map((hint) => ({ ...hint, distanceM: distanceMeters(restaurant.location, hint.location) }))
    .filter((hint) => hint.distanceM <= maxMeters)
    .filter((hint) => storeParkingHintMatches(hint, restaurant, hint.distanceM))
    .sort((a, b) => a.distanceM - b.distanceM)[0];
}

function storeParkingHintMatches(hint, restaurant, distanceM) {
  const hintName = normalizeName(hint.name);
  const hintBrand = normalizeName(hint.brand);
  const restaurantName = normalizeName(restaurant.name);
  const nameMatches =
    hintName && restaurantName && (hintName.includes(restaurantName) || restaurantName.includes(hintName));
  if (nameMatches || (hintBrand && restaurantName.includes(hintBrand))) return true;
  return hint.category && hint.category === restaurant.category && distanceM <= 25;
}

function normalizeName(value) {
  return String(value ?? "").toLowerCase().replace(/[\s　（）()・\-_.]/g, "");
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
      message: "店舗駐車場つきチェーンを取得できませんでした。少し時間を置いてもう一度お試しください。"
    },
    emptyReason: "この条件で店舗駐車場つきチェーンは見つかりませんでした。半径を広げる、スーパーを選ぶ、場所を変えるのいずれかを試してください。",
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
  if (category === "beef_bowl") return "beef_bowl";
  if (category === "fast_food" || spot.pickupTypes?.includes("drive_through")) return "fast_food";
  if (category === "deli" || category === "bakery" || category === "greengrocer") return "deli";
  if (category === "supermarket") return "supermarket";
  return "restaurant";
}

function renderList() {
  if (!state.currentData) return;
  const spots = filteredSpots(state.selectedTab);

  if (!spots.length) {
    elements.spotList.innerHTML = `<div class="empty">${escapeHtml(state.currentData.emptyReason || "この条件で店舗駐車場つきチェーンは見つかりませんでした。半径を広げる、スーパーを選ぶ、場所を変えるのいずれかを試してください。")}</div>`;
    return;
  }

  elements.spotList.innerHTML = spots.map((spot) => spotCard(spot)).join("");
}

function spotCard(spot) {
  const parking = spot.nearestParkingCandidate;
  const mapUrl = googleMapsPointUrl(spot);
  const streetViewUrl = googleMapsStreetViewFallbackUrl(spot.location);
  const pickupText = pickupLabels(spot.pickupTypes);
  const genreText = genreLabels()[spotGenre(spot)];
  const parkingText = parking
    ? `🅿️ ${parking.availability}`
    : "❔ 店舗駐車場未確認";
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
        <a href="${streetViewUrl}" target="_blank" rel="noreferrer" data-road-view data-lat="${spot.location.lat}" data-lng="${spot.location.lng}">道路を確認</a>
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

function googleMapsStreetViewFallbackUrl(location) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${location.lat},${location.lng}`;
}

async function googleMapsRoadStreetViewUrl(location) {
  const cacheKey = `${location.lat.toFixed(6)},${location.lng.toFixed(6)}`;
  if (state.streetViewUrlCache.has(cacheKey)) return state.streetViewUrlCache.get(cacheKey);
  if (!state.streetViewService || !window.google?.maps) return googleMapsStreetViewFallbackUrl(location);

  const panorama = await nearestOutdoorPanorama(location);
  const panoLatLng = panorama.location.latLng;
  const heading = Math.round(headingBetween({ lat: panoLatLng.lat(), lng: panoLatLng.lng() }, location));
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(panorama.location.pano)}&heading=${heading}`;
  state.streetViewUrlCache.set(cacheKey, url);
  return url;
}

function nearestOutdoorPanorama(location) {
  return new Promise((resolve, reject) => {
    state.streetViewService.getPanorama(
      {
        location,
        radius: 120,
        source: google.maps.StreetViewSource.OUTDOOR,
        preference: google.maps.StreetViewPreference.NEAREST
      },
      (data, status) => {
        if (status === google.maps.StreetViewStatus.OK && data?.location?.pano && data.location.latLng) {
          resolve(data);
          return;
        }
        reject(new Error("Street View panorama was not found"));
      }
    );
  });
}

function headingBetween(from, to) {
  const fromLat = toRadians(from.lat);
  const toLat = toRadians(to.lat);
  const deltaLng = toRadians(to.lng - from.lng);
  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function toDegrees(value) {
  return (value * 180) / Math.PI;
}

function genreLabels() {
  return {
    convenience: "コンビニ",
    fast_food: "ファストフード",
    beef_bowl: "牛丼・定食",
    deli: "弁当",
    supermarket: "スーパー",
    restaurant: "チェーン"
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

function isAuthed() {
  if (!window.PARK_PARK_LUNCH_CONFIG?.passwordHash) return true;
  try { return sessionStorage.getItem("ppl_authed") === "1"; } catch { return true; }
}

function setAuthed() {
  try { sessionStorage.setItem("ppl_authed", "1"); } catch {}
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function showPasswordGate(onSuccess) {
  pendingSearchAction = onSuccess;
  elements.passwordGate.classList.remove("hidden");
  elements.passwordInput.value = "";
  elements.passwordError.textContent = "";
  elements.passwordInput.focus();
}

function hidePasswordGate() {
  elements.passwordGate.classList.add("hidden");
}

async function doSearch() {
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
}

init();
