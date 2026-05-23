import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Google Maps support is configured through an environment-backed config endpoint", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(server, /GOOGLE_MAPS_API_KEY/);
  assert.match(server, /\/api\/config/);
  assert.match(app, /loadGoogleMaps/);
  assert.match(app, /Google Maps \/ OSMライブ検索/);
  assert.doesNotMatch(app, /L\.map|tileLayer|地理院タイル/);
});
