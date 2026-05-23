import { readFileSync } from "node:fs";
import path from "node:path";

function readJson(dataDir, fileName) {
  return JSON.parse(readFileSync(path.join(dataDir, fileName), "utf8"));
}

export function loadData(dataDir) {
  return {
    restaurants: readJson(dataDir, "restaurants.json"),
    parkingMeterZones: readJson(dataDir, "parking_meter_zones.json"),
    parkingLots: readJson(dataDir, "parking_lots.json"),
    manualDriveThroughPlaces: readJson(dataDir, "manual_drive_through_places.json"),
    sourceAuditLogs: readJson(dataDir, "source_audit_logs.json")
  };
}
