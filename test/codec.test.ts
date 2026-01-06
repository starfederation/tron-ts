import { canonical, detectType, encode, fromJSON, tron, tronBytes, vacuum } from "../src/index";

const roundtrip = (value: unknown) => tron(encode(value as never));

const expectBytesEqual = (a: Uint8Array, b: Uint8Array) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i]).toBe(b[i]);
  }
};

describe("tron proxy", () => {
  test("scalars", () => {
    expect(roundtrip(null)).toBeNull();
    expect(roundtrip(true)).toBe(true);
    expect(roundtrip(false)).toBe(false);
    expect(roundtrip(42)).toBe(42);
    expect(roundtrip(3.5)).toBe(3.5);
    expect(roundtrip("hello")).toBe("hello");
  });

  test("binary", () => {
    const bytes = new Uint8Array([1, 2, 3, 255]);
    const decoded = roundtrip(bytes) as Uint8Array;
    expect(decoded).toBeInstanceOf(Uint8Array);
    expectBytesEqual(decoded, bytes);
  });

  test("arrays and maps", () => {
    const value = {
      a: [1, 2, 3],
      b: { nested: true, items: ["x", "y"] },
      c: null,
    };
    expect(roundtrip(value)).toEqual(value);
  });

  test("empty array and map", () => {
    expect(roundtrip([])).toEqual([]);
    expect(roundtrip({})).toEqual({});
  });

  test("i64 as bigint", () => {
    const value = 123n;
    const encoded = encode(value);
    const decoded = tron(encoded, { i64: "bigint" });
    expect(decoded).toBe(123n);
  });

  test("i64 tron modes", () => {
    const safe = 9007199254740991n;
    const unsafe = 9007199254740993n;

    const safeTronBytes = encode(safe);
    const unsafeTronBytes = encode(unsafe);

    expect(tron(safeTronBytes)).toBe(Number(safe));
    expect(tron(unsafeTronBytes)).toBe(unsafe);

    expect(() => tron(unsafeTronBytes, { i64: "number" })).toThrow("range");

    expect(tron(safeTronBytes, { i64: "bigint" })).toBe(safe);
    expect(tron(unsafeTronBytes, { i64: "bigint" })).toBe(unsafe);
  });

  test("detect tron type", () => {
    expect(detectType(encode(1))).toBe("scalar");
    expect(detectType(encode([1, 2, 3]))).toBe("tree");
  });

  test("json roundtrip with b64 bin", () => {
    const json = JSON.stringify({ bin: "b64:AQID", text: "hi", nums: [1, 2, 3] });
    const tronBytes = fromJSON(json);
    const decoded = tron(tronBytes);
    expect(decoded).toHaveProperty("bin");
    const bin = (decoded as { bin: Uint8Array }).bin;
    expect(bin).toBeInstanceOf(Uint8Array);
    expectBytesEqual(bin, new Uint8Array([1, 2, 3]));

    const out = (decoded as { ToJSON: () => string }).ToJSON();
    const parsed = JSON.parse(out) as { bin: string; text: string; nums: number[] };
    expect(parsed.bin).toBe("b64:AQID");
    expect(parsed.text).toBe("hi");
    expect(parsed.nums).toEqual([1, 2, 3]);
  });

  test("vacuum preserves value and drops history", () => {
    const value = { a: [1, 2, 3], b: { c: "hi", d: [true, null] } };
    const bytes = encode(value as never);
    const proxy = tron(bytes) as any;
    proxy.a[1] = 9;
    proxy.b.c = "ok";
    const updated = tronBytes(proxy);
    const vacuumed = vacuum(updated);
    const vacuumJson = (tron(vacuumed) as { ToJSON: () => string }).ToJSON();
    const updatedJson = (tron(updated) as { ToJSON: () => string }).ToJSON();
    expect(vacuumJson).toBe(updatedJson);
    const prevOffset =
      vacuumed[vacuumed.length - 8] |
      (vacuumed[vacuumed.length - 7] << 8) |
      (vacuumed[vacuumed.length - 6] << 16) |
      (vacuumed[vacuumed.length - 5] << 24);
    expect(prevOffset).toBe(0);
  });

  test("canonical rebuild matches spec encoding", () => {
    const value = { a: [1, 2, 3], b: { c: "hi", d: [true, null] }, z: { y: 4 } };
    const bytes = encode(value as never);
    const proxy = tron(bytes) as any;
    proxy.a[1] = 9;
    proxy.b.c = "ok";
    const updated = tronBytes(proxy);
    const canon = canonical(updated);
    const canonFromJson = fromJSON((tron(updated) as { ToJSON: () => string }).ToJSON());
    expectBytesEqual(canon, canonFromJson);
    const prevOffset =
      canon[canon.length - 8] |
      (canon[canon.length - 7] << 8) |
      (canon[canon.length - 6] << 16) |
      (canon[canon.length - 5] << 24);
    expect(prevOffset).toBe(0);
  });
});
