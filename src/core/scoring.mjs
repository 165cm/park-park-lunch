import { distanceMeters, roundMeters } from "./geo.mjs";

const RANK_LABELS = {
  A: "車から受け取り",
  B: "パーキングメーター近く",
  C: "近くに駐車場",
  CAUTION: "駐車未確認"
};

const REQUIRED_CAUTION =
  "現地標識確認必須。本アプリは駐車許可を保証しません。車を離れる場合は推奨された駐車施設を利用してください。";

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function getTokyoDateParts(time) {
  const date = time ? new Date(time) : new Date();
  if (Number.isNaN(date.getTime())) return getTokyoDateParts();

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short"
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);

  return {
    weekday: DAY_KEYS[weekdayIndex],
    minutes: Number.parseInt(parts.hour, 10) * 60 + Number.parseInt(parts.minute, 10),
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`
  };
}

function getRequestedTime(time) {
  if (typeof time === "string" && /^\d{2}:\d{2}$/.test(time)) {
    const current = getTokyoDateParts();
    const [hour, minute] = time.split(":").map(Number);
    return {
      ...current,
      minutes: hour * 60 + minute,
      hhmm: time
    };
  }

  return getTokyoDateParts(time);
}

function isWithinWindow(minutes, window) {
  const [startHour, startMinute] = window.start.split(":").map(Number);
  const [endHour, endMinute] = window.end.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return minutes >= start && minutes <= end;
}

export function isParkingMeterActive(zone, requestedTime, vehicleType) {
  const allowedVehicleTypes = zone.allowedVehicleTypes ?? ["standard"];
  if (!allowedVehicleTypes.includes(vehicleType)) return false;
  if (zone.activeDays && !zone.activeDays.includes(requestedTime.weekday)) return false;
  return (zone.activeWindows ?? []).some((window) => isWithinWindow(requestedTime.minutes, window));
}

function nearestCandidate(candidates, location, maxMeters) {
  return candidates
    .map((candidate) => ({
      ...candidate,
      distanceM: distanceMeters(location, candidate.location)
    }))
    .filter((candidate) => candidate.distanceM <= maxMeters)
    .sort((a, b) => a.distanceM - b.distanceM)[0];
}

function buildParkingCandidate(candidate, type) {
  if (!candidate) return null;

  if (type === "on_site_parking") {
    return {
      id: `${candidate.id}_parking_hint`,
      type,
        name: "店舗駐車場の可能性",
      location: candidate.location,
      walkingDistanceM: 0,
      activeWindow: null,
      availability: "未確認",
        note: "地図データ上の駐車場情報です。実際の利用可否、台数、料金、入庫条件は現地で確認してください。"
    };
  }

  return {
    id: candidate.id,
    type,
    name: candidate.name,
    location: candidate.location,
    walkingDistanceM: roundMeters(candidate.distanceM),
    activeWindow: candidate.activeWindows?.[0] ?? null,
    availability: type === "parking_lot" ? "未確認" : "利用可能時間内",
    note:
      type === "parking_lot"
        ? "満空未確認。入庫前に現地表示と料金を確認してください。"
        : "パーキング・メーター等の時間制限駐車区間です。現地の標識、枠、手数料を確認してください。"
  };
}

function isManualDriveThrough(restaurant, manualDriveThroughPlaces) {
  return manualDriveThroughPlaces.some((place) => place.restaurantId === restaurant.id);
}

function scoreRestaurant(restaurant, context) {
  const { requestedLocation, activeParkingMeters, parkingLots, manualDriveThroughPlaces } = context;
  const distanceFromQueryM = distanceMeters(requestedLocation, restaurant.location);
  const distancePenalty = recommendationDistancePenalty(distanceFromQueryM);
  const pickupTypes = restaurant.pickupTypes ?? [];
  const canReceiveWithoutLeaving =
    pickupTypes.includes("drive_through") ||
    pickupTypes.includes("curbside_pickup") ||
    isManualDriveThrough(restaurant, manualDriveThroughPlaces);

  if (canReceiveWithoutLeaving) {
    return {
      ...baseSpot(restaurant, distanceFromQueryM),
      recommendedRank: "A",
      rankLabel: RANK_LABELS.A,
      score: 95 - distancePenalty * 0.8,
      confidence: 0.86,
      nearestParkingCandidate: {
        type: "not_required",
        name: "車から受け取れる可能性",
        walkingDistanceM: 0,
        availability: "店舗側対応要確認",
        note: "ドライブスルーまたはカーブサイドの可能性があります。営業状況と受取手順は店舗側で確認してください。"
      },
      caution: REQUIRED_CAUTION
    };
  }

  const nearestActiveMeter = nearestCandidate(activeParkingMeters, restaurant.location, 80);
  if (nearestActiveMeter) {
    return {
      ...baseSpot(restaurant, distanceFromQueryM),
      recommendedRank: "B",
      rankLabel: RANK_LABELS.B,
      score: 82 - nearestActiveMeter.distanceM / 20 - distancePenalty,
      confidence: 0.72,
      nearestParkingCandidate: buildParkingCandidate(nearestActiveMeter, "parking_meter"),
      caution: REQUIRED_CAUTION
    };
  }

  const nearestLot = nearestCandidate(parkingLots, restaurant.location, 150);
  if (nearestLot) {
    return {
      ...baseSpot(restaurant, distanceFromQueryM),
      recommendedRank: "C",
      rankLabel: RANK_LABELS.C,
      score: 68 - nearestLot.distanceM / 30 - distancePenalty,
      confidence: 0.62,
      nearestParkingCandidate: buildParkingCandidate(nearestLot, "parking_lot"),
      caution: REQUIRED_CAUTION
    };
  }

  if ((restaurant.parkingHints ?? []).includes("on_site")) {
    return {
      ...baseSpot(restaurant, distanceFromQueryM),
      recommendedRank: "C",
      rankLabel: RANK_LABELS.C,
      score: 64 - distancePenalty,
      confidence: 0.58,
      nearestParkingCandidate: buildParkingCandidate(restaurant, "on_site_parking"),
      caution: REQUIRED_CAUTION
    };
  }

  return {
    ...baseSpot(restaurant, distanceFromQueryM),
    recommendedRank: "CAUTION",
    rankLabel: RANK_LABELS.CAUTION,
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

function baseSpot(restaurant, distanceFromQueryM) {
  return {
    id: restaurant.id,
    name: restaurant.name,
    location: restaurant.location,
    category: restaurant.category,
    pickupTypes: restaurant.pickupTypes ?? [],
    parkingHints: restaurant.parkingHints ?? [],
    distanceFromQueryM: roundMeters(distanceFromQueryM),
    estimatedStayMinutes: restaurant.estimatedStayMinutes,
    dataSources: restaurant.dataSources ?? [],
    sourceNote: restaurant.sourceNote
  };
}

export function buildLunchSpotResponse(data, query) {
  const requestedLocation = { lat: query.lat, lng: query.lng };
  const requestedTime = getRequestedTime(query.time);
  const vehicleType = query.vehicleType ?? "standard";
  const radiusM = query.radiusM ?? 2200;

  const nearbyRestaurants = data.restaurants.filter(
    (restaurant) => distanceMeters(requestedLocation, restaurant.location) <= radiusM
  );

  const activeParkingMeters = data.parkingMeterZones.filter((zone) =>
    isParkingMeterActive(zone, requestedTime, vehicleType)
  );

  const spots = nearbyRestaurants
    .map((restaurant) =>
      scoreRestaurant(restaurant, {
        requestedLocation,
        activeParkingMeters,
        parkingLots: data.parkingLots,
        manualDriveThroughPlaces: data.manualDriveThroughPlaces
      })
    )
    .sort((a, b) => b.score - a.score);

  return {
    query: {
      lat: query.lat,
      lng: query.lng,
      radiusM,
      vehicleType,
      time: requestedTime.hhmm,
      date: requestedTime.isoDate,
    timezone: "Asia/Tokyo"
    },
    generatedAt: new Date().toISOString(),
    liveDataStatus: data.liveDataStatus ?? {
      provider: "local_static",
      used: false,
      message: "ライブ検索は未使用です。ローカル静的データを使用しています。"
    },
    policyNotice: REQUIRED_CAUTION,
    dataSources: data.sourceAuditLogs,
    safeSpots: spots.filter((spot) => spot.recommendedRank !== "CAUTION"),
    cautionSpots: spots.filter((spot) => spot.recommendedRank === "CAUTION")
  };
}

export const notices = {
  REQUIRED_CAUTION
};
