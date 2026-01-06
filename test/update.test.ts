import { encode, tron, tronBytes } from "../src/index";

describe("tron proxy updates", () => {
  test("updates nested map/array paths", () => {
    const sourceBytes = encode({
      features: [{ properties: { elevation: 1200 } }],
    });
    const geo = tron(sourceBytes);
    geo.features[0].properties.elevation = 1500;
    const updatedBytes = tronBytes(geo);
    const originalView = tron(sourceBytes);
    const updatedView = tron(updatedBytes);
    expect(originalView.features[0].properties.elevation).toBe(1200);
    expect(updatedView.features[0].properties.elevation).toBe(1500);
  });

  test("appends array entries", () => {
    const sourceBytes = encode([1, 2]);
    const list = tron(sourceBytes);
    list[2] = 3;
    const updatedBytes = tronBytes(list);
    const next = tron(updatedBytes);
    expect(next.length).toBe(3);
    expect(next[2]).toBe(3);
  });
});
