import { fetchStaticLunchSpots } from "./static-search.js?v=1";

const DEFAULT_LOCATION = { lat: 35.681236, lng: 139.767125 };
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
  tapMode: false,
  mapProvider: "google",
  map: null,
  markers: [],
  currentData: null,
  infoWindow: null
};

const elements = {
  form: document.querySelector("#searchForm"),
  locationInput: document.querySelector("#locationInput"),
  vehicleType: document.querySelector("#vehicleType"),
  timeInput: document.querySelector("#timeInput"),
  radiusInput: document.querySelector("#radiusInput"),
  locateButton: document.querySelector("#locateButton"),
  tapModeButton: document.querySelector("#tapModeButton"),
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
  elements.timeInput.value = currentTimeValue();
  await initMap();
  bindEvents();
  watchSpeed();
  registerServiceWorker();
  updateSpots();
}

function currentTimeValue() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

async function initMap() {
  const config = await loadConfig();
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
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    gestureHandling: "greedy",
    clickableIcons: true
  });
  state.infoWindow = new google.maps.InfoWindow();
  state.map.addListener("click", (event) => {
    if (!state.tapMode || !event.latLng) return;
    setLocation({ lat: event.latLng.lat(), lng: event.latLng.lng() });
  });
  elements.mapCredit.textContent = "Google Maps / OSMライブ検索";
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
    const parsed = parseLocationInput(elements.locationInput.value);
    if (parsed) setLocation(parsed, false);
    updateSpots();
  });

  elements.locateButton.addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude
        });
      },
      () => {
        elements.locationInput.focus();
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  });

  elements.tapModeButton.addEventListener("click", () => {
    state.tapMode = !state.tapMode;
    elements.tapModeButton.setAttribute("aria-pressed", String(state.tapMode));
  });

  elements.safeTab.addEventListener("click", () => switchTab("safe"));
  elements.cautionTab.addEventListener("click", () => switchTab("caution"));
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

function setLocation(location, updateInput = true) {
  state.location = location;
  if (updateInput) elements.locationInput.value = `${location.lat.toFixed(6)},${location.lng.toFixed(6)}`;
  if (state.mapProvider === "google") {
    state.map.setCenter(location);
    state.map.setZoom(Math.max(state.map.getZoom(), 14));
  }
  updateSpots();
}

async function updateSpots() {
  const params = new URLSearchParams({
    lat: String(state.location.lat),
    lng: String(state.location.lng),
    radiusM: elements.radiusInput.value,
    vehicleType: elements.vehicleType.value,
    time: elements.timeInput.value
  });

  try {
    const response = await fetch(`api/lunch-spots?${params}`);
    if (!response.ok) throw new Error(`API ${response.status}`);
    state.currentData = await response.json();
  } catch {
    state.currentData = await fetchStaticLunchSpots({
      lat: state.location.lat,
      lng: state.location.lng,
      radiusM: Number.parseInt(elements.radiusInput.value, 10),
      vehicleType: elements.vehicleType.value,
      time: elements.timeInput.value
    });
  }
  elements.safeCount.textContent = String(state.currentData.safeSpots.length);
  elements.cautionCount.textContent = String(state.currentData.cautionSpots.length);
  const liveStatus = state.currentData.liveDataStatus;
  elements.liveStatus.textContent = liveStatus?.message ?? "周辺のお店と駐車場を取得しました。";
  elements.liveStatus.classList.toggle("active", Boolean(liveStatus?.used));
  renderList();
  renderMarkers();
}

function switchTab(tab) {
  state.selectedTab = tab;
  elements.safeTab.classList.toggle("active", tab === "safe");
  elements.cautionTab.classList.toggle("active", tab === "caution");
  elements.safeTab.setAttribute("aria-selected", String(tab === "safe"));
  elements.cautionTab.setAttribute("aria-selected", String(tab === "caution"));
  renderList();
}

function renderList() {
  const data = state.currentData;
  if (!data) return;
  const spots = state.selectedTab === "safe" ? data.safeSpots : data.cautionSpots;

  if (!spots.length) {
    elements.spotList.innerHTML = `<div class="empty">この条件で表示できるお店がありません</div>`;
    return;
  }

  elements.spotList.innerHTML = spots.map((spot) => spotCard(spot)).join("");
  elements.spotList.querySelectorAll("[data-focus-spot]").forEach((button) => {
    button.addEventListener("click", () => focusSpot(button.dataset.focusSpot));
  });
}

function spotCard(spot) {
  const parking = spot.nearestParkingCandidate;
  const parkingText = parking
    ? `${parking.name} / 徒歩${parking.walkingDistanceM}m / ${parking.availability}`
    : "近くの駐車場所は未確認";
  const mapsTarget = parking?.location ?? spot.location;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${mapsTarget.lat},${mapsTarget.lng}`;
  const streetViewUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${spot.location.lat},${spot.location.lng}`;
  const pickupText = pickupLabels(spot.pickupTypes);

  return `
    <article class="spot-card rank-${spot.recommendedRank}">
      <h2>${escapeHtml(spot.name)}</h2>
      <div class="spot-meta">
        <span class="badge">${escapeHtml(spot.rankLabel)}</span>
        <span class="badge">${spot.distanceFromQueryM}m</span>
        <span class="badge warning">信頼度 ${Math.round(spot.confidence * 100)}%</span>
      </div>
      <p>${escapeHtml(pickupText)}</p>
      <p>${escapeHtml(parkingText)}</p>
      <p>${escapeHtml(spot.caution)}</p>
      <div class="spot-actions">
        <button type="button" data-focus-spot="${spot.id}">地図</button>
        <a href="${streetViewUrl}" target="_blank" rel="noreferrer">店前確認</a>
        <a href="${mapsUrl}" target="_blank" rel="noreferrer">行き先</a>
      </div>
    </article>
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
  const data = state.currentData;
  if (!data) return;
  const spots = [...data.safeSpots, ...data.cautionSpots];

  if (state.mapProvider === "google") {
    state.markers.forEach((marker) => marker.setMap(null));
    state.markers = [];

    state.markers.push(
      new google.maps.Marker({
        position: state.location,
        map: state.map,
        title: "検索地点",
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: "#f8c35a",
          fillOpacity: 1,
          strokeColor: "#14362f",
          strokeWeight: 3
        }
      })
    );

    for (const spot of spots) {
      const marker = new google.maps.Marker({
        position: spot.location,
        map: state.map,
        title: spot.name,
        label: spot.recommendedRank === "CAUTION" ? "!" : spot.recommendedRank
      });
      marker.spotId = spot.id;
      marker.addListener("click", () => openGoogleInfoWindow(marker, spot));
      state.markers.push(marker);
    }
    return;
  }

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
