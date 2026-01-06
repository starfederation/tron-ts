import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { xxh32 } from "../src/xxh32";

type Xxh32Vector = {
  len: number;
  seed: string;
  result: string;
};

type VectorsFile = {
  arrays: {
    XSUM_XXH32_testdata: Xxh32Vector[];
  };
};

describe("xxh32 sanity vectors", () => {
  test("matches Cyan4973/xxHash vectors", () => {
    let vectorsPath: string | null = null;
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      const candidates = [
        join(dir, "shared", "testdata", "vectors", "xxhash_sanity_test_vectors.json"),
        join(dir, "tron-shared", "shared", "testdata", "vectors", "xxhash_sanity_test_vectors.json"),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          vectorsPath = candidate;
          break;
        }
      }
      if (vectorsPath) break;
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    if (!vectorsPath) {
      throw new Error("xxhash_sanity_test_vectors.json not found");
    }

    const raw = readFileSync(vectorsPath, "utf8");
    const parsed = JSON.parse(raw) as VectorsFile;
    if (!parsed.arrays?.XSUM_XXH32_testdata?.length) {
      throw new Error("no XXH32 vectors found");
    }
    const vectors = parsed.arrays.XSUM_XXH32_testdata;
    const maxLen = vectors.reduce((max, entry) => Math.max(max, entry.len), 0);
    const PRIME32 = 2654435761n;
    const PRIME64 = 11400714785074694797n;
    const MASK64 = (1n << 64n) - 1n;
    let byteGen = PRIME32;
    const buffer = new Uint8Array(maxLen);
    for (let i = 0; i < maxLen; i++) {
      buffer[i] = Number((byteGen >> 56n) & 0xffn);
      byteGen = (byteGen * PRIME64) & MASK64;
    }

    vectors.forEach((entry) => {
      const seed = Number(BigInt(entry.seed)) >>> 0;
      const expected = Number(BigInt(entry.result)) >>> 0;
      const got = xxh32(buffer.subarray(0, entry.len), seed);
      expect(got).toBe(expected);
    });
  });
});
