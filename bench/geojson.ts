import { readFileSync } from "node:fs";
import { encode, tron, tronBytes as readTronBytes } from "../src/index";

type BenchCase = {
  bytesPerIter: number;
  fn: () => unknown;
};

type BenchPair = {
  name: string;
  tron: BenchCase;
  json: BenchCase;
};

const NS_PER_S = 1_000_000_000;
const MB = 1024 * 1024;

const nowNs = (): bigint => process.hrtime.bigint();

const fixtureUrl = new URL("../tron-shared/shared/testdata/geojson_large.json", import.meta.url);
const baseJsonText = readFileSync(fixtureUrl, "utf8");
const baseValue = JSON.parse(baseJsonText) as any;
const scale = Number(process.env.TRON_BENCH_SCALE ?? "10");
let jsonValue = baseValue;
if (Number.isInteger(scale) && scale > 1) {
  const features = Array.isArray(baseValue?.features) ? baseValue.features : null;
  if (features) {
    const scaled = { ...baseValue, features: [] as unknown[] };
    for (let i = 0; i < scale; i++) {
      for (const feature of features) {
        const cloned =
          typeof structuredClone === "function"
            ? structuredClone(feature)
            : JSON.parse(JSON.stringify(feature));
        scaled.features.push(cloned);
      }
    }
    jsonValue = scaled;
  }
}
const jsonText = JSON.stringify(jsonValue);
const jsonBytes = new TextEncoder().encode(jsonText);

const tronBytes = encode(jsonValue as never);
const tronUpdatedBytes = (() => {
  const value = tron(tronBytes) as any;
  if (value?.features?.[0]?.properties) {
    value.features[0].properties.elevation = 1500;
  }
  return readTronBytes(value);
})();
const tronUpdateBytesLen = tronUpdatedBytes.length;
const tronUpdatedProxy = tron(tronUpdatedBytes) as {
  vacuum: () => Uint8Array;
  canonical: () => Uint8Array;
};
const tronVacuumBytes = tronUpdatedProxy.vacuum();
const tronCanonicalBytes = tronUpdatedProxy.canonical();

const jsonUpdate = (() => {
  const value = JSON.parse(jsonText) as any;
  if (value?.features?.[0]?.properties) {
    value.features[0].properties.elevation = 1500;
  }
  const updatedText = JSON.stringify(value);
  const updatedBytes = new TextEncoder().encode(updatedText);
  return { text: updatedText, bytes: updatedBytes };
})();
const jsonUpdateBytesLen = jsonUpdate.bytes.length;

const readPath = (value: any) => {
  const feature = value.features?.[0];
  const name = feature?.properties?.name;
  const status = feature?.properties?.status;
  const coords = feature?.geometry?.coordinates?.[0]?.[0]?.[0];
  return { name, status, coords };
};

let sink: unknown;

const benchPairs: BenchPair[] = [
  {
    name: "proxy + read",
    tron: {
      bytesPerIter: tronBytes.length,
      fn: () => {
        const value = tron(tronBytes);
        sink = readPath(value);
        return sink;
      },
    },
    json: {
      bytesPerIter: jsonBytes.length,
      fn: () => {
        const value = JSON.parse(jsonText);
        sink = readPath(value);
        return sink;
      },
    },
  },
  {
    name: "proxy update elevation",
    tron: {
      bytesPerIter: tronUpdateBytesLen,
      fn: () => {
        const value = tron(tronBytes) as any;
        if (value?.features?.[0]?.properties) {
          value.features[0].properties.elevation = 1500;
        }
        sink = readTronBytes(value);
        return sink;
      },
    },
    json: {
      bytesPerIter: jsonUpdateBytesLen,
      fn: () => {
        const value = JSON.parse(jsonText) as any;
        if (value?.features?.[0]?.properties) {
          value.features[0].properties.elevation = 1500;
        }
        sink = JSON.stringify(value);
        return sink;
      },
    },
  },
  {
    name: "vacuum (history-free bytes)",
    tron: {
      bytesPerIter: tronVacuumBytes.length,
      fn: () => {
        sink = tronUpdatedProxy.vacuum();
        return sink;
      },
    },
    json: {
      bytesPerIter: jsonUpdateBytesLen,
      fn: () => {
        const value = JSON.parse(jsonUpdate.text);
        sink = JSON.stringify(value);
        return sink;
      },
    },
  },
  {
    name: "canonical (spec bytes)",
    tron: {
      bytesPerIter: tronCanonicalBytes.length,
      fn: () => {
        sink = tronUpdatedProxy.canonical();
        return sink;
      },
    },
    json: {
      bytesPerIter: jsonUpdateBytesLen,
      fn: () => {
        const value = JSON.parse(jsonUpdate.text);
        sink = JSON.stringify(value);
        return sink;
      },
    },
  },
];

type BenchResult = {
  nsPerOp: number;
  mbPerSec: number;
  iterations: number;
};

const runBench = (bench: BenchCase): BenchResult => {
  for (let i = 0; i < 5; i++) {
    bench.fn();
  }

  let iterations = 0;
  const start = nowNs();
  let elapsed = 0n;
  const minIterations = 50;
  const targetNs = 750_000_000n;

  while (iterations < minIterations || elapsed < targetNs) {
    bench.fn();
    iterations++;
    elapsed = nowNs() - start;
  }

  const elapsedNs = Number(elapsed);
  const nsPerOp = elapsedNs / iterations;
  const totalBytes = bench.bytesPerIter * iterations;
  const mbPerSec = totalBytes / (elapsedNs / NS_PER_S) / MB;
  return { nsPerOp, mbPerSec, iterations };
};

const formatResult = (result: BenchResult): string =>
  `${Math.round(result.nsPerOp).toLocaleString()} ns/op, ${result.mbPerSec.toFixed(2)} MB/s (${
    result.iterations
  } iters)`;

console.log("GeoJSON benchmark fixture:");
console.log(`- Scale: ${scale}x`);
console.log(`- JSON bytes: ${jsonBytes.length}`);
console.log(`- TRON bytes: ${tronBytes.length}`);
console.log("");

for (const pair of benchPairs) {
  const tronResult = runBench(pair.tron);
  const jsonResult = runBench(pair.json);
  console.log(`${pair.name}:`);
  console.log(`  TRON: ${formatResult(tronResult)}`);
  console.log(`  JSON: ${formatResult(jsonResult)}`);
}
