import test from "node:test";
import assert from "node:assert/strict";
import { fetchOverpassLunchData } from "../src/providers/overpass.mjs";

test("Overpass provider normalizes restaurants and parking lots", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      elements: [
        {
          type: "node",
          id: 1,
          lat: 35.1,
          lon: 139.1,
          tags: { amenity: "fast_food", name: "テストバーガー", takeaway: "yes" }
        },
        {
          type: "node",
          id: 2,
          lat: 35.1003,
          lon: 139.1003,
          tags: { amenity: "parking", name: "テスト駐車場", capacity: "12" }
        },
        {
          type: "node",
          id: 3,
          lat: 35.1004,
          lon: 139.1004,
          tags: { shop: "supermarket", name: "テストスーパー", parking: "customers" }
        }
      ]
    })
  });

  const result = await fetchOverpassLunchData({ lat: 35.1, lng: 139.1, radiusM: 1000 }, fakeFetch);
  assert.equal(result.restaurants.length, 2);
  assert.equal(result.parkingLots.length, 1);
  assert.deepEqual(result.restaurants[0].pickupTypes, ["takeout"]);
  assert.deepEqual(result.restaurants[1].parkingHints, ["on_site"]);
  assert.equal(result.parkingLots[0].capacity, 12);
});
