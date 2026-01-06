# TRON TypeScript implementation

This package provides a TypeScript implementation of the TRON encoder and lazy proxy
that works in browser, Bun, and Deno. It uses `Uint8Array` directly and avoids
Node-specific APIs.

## Install/use

Import from source (repo local):

```ts
import { encode, tron, tronBytes, detectType, fromJSON } from "./src/index";
```

## API

- `encode(value: TronValue): Uint8Array`
- `tron(tronBytes: Uint8Array, options?: ViewOptions): TronProxy`
- `tronBytes(proxy: TronProxy): Uint8Array`
- `detectType(tronBytes: Uint8Array): "scalar" | "tree"`
- `vacuum(tronBytes: Uint8Array): Uint8Array`
- `canonical(tronBytes: Uint8Array): Uint8Array`
- `setPath(tronBytes: Uint8Array, path: PathSegment[], value: TronValue): Uint8Array`
- `fromJSON(input: string | Uint8Array): Uint8Array`
- `proxy.ToJSON(): string`
- `proxy.vacuum(): Uint8Array`
- `proxy.canonical(): Uint8Array`

`TronValue` supports: `null`, `boolean`, `number`, `bigint`, `string`, `Uint8Array`, arrays, and objects.
`PathSegment` is a string (map key) or a number (array index).

`tron` returns a lazy, read/write proxy for TRON trees while leaving scalars as normal JS primitives.
`tron` only reads the nodes needed for the accessed path or keys.
`tronBytes` returns the current `Uint8Array` backing a proxy after updates.
`vacuum` drops history by copying the current root into history-free bytes without re-encoding.
`canonical` rebuilds canonical bytes (spec encoding) from the current root.
`setPath` performs copy-on-write updates by appending new nodes and a new trailer.
`proxy.ToJSON()` returns a JSON string using the TRON JSON mapping.

### Proxy examples

Wrap bytes, then access nested values lazily:

```ts
import { tron, tronBytes as readTronBytes } from "./src/index";

const tronBytes = /* Uint8Array */;
const proxy = tron(tronBytes);

// Property and index access
proxy.profile.name;
proxy.items[0].id;

// Updates write back to bytes (copy-on-write)
proxy.profile.name = "Ada";
const updatedTronBytes = readTronBytes(proxy);

// History-free and canonical bytes
const vacuumed = proxy.vacuum();
const canonicalBytes = proxy.canonical();

// Enumeration and JSON.stringify behave normally
Object.keys(proxy);
JSON.stringify(proxy);

// JSON mapping (b64: for bin values)
const json = proxy.ToJSON();
```

### GeoJSON example

Wrap GeoJSON and update a nested value without a full re-encode cycle:

```ts
import { fromJSON, tron, tronBytes as readTronBytes } from "./src/index";

const jsonText = await Bun.file("tron-shared/shared/testdata/geojson_large.json").text();
const tronBytes = fromJSON(jsonText);

const geo = tron(tronBytes);
const elevation = geo.features[0].properties.elevation;

geo.features[0].properties.elevation = 1500;
const updatedTronBytes = readTronBytes(geo);
const next = tron(updatedTronBytes);
const nextElevation = next.features[0].properties.elevation;
```

### i64 decoding

`ViewOptions.i64` controls how i64 values are returned:

- `"auto"` (default): number if safe, bigint otherwise
- `"number"`: number only (throws if unsafe)
- `"bigint"`: bigint only

## JSON mapping

The JSON helpers follow the spec and Go behavior:

- `bin` values are encoded as JSON strings with `b64:` prefix.
- If a JSON string starts with `b64:` and the remainder is valid base64,
  it decodes to `bin`; otherwise it remains `txt`.

Note: `fromJSON`/`proxy.ToJSON()` use `atob`/`btoa` for base64 and therefore require
an environment that provides them (browser, Bun, Deno).

## Tests

```sh
bun test
```

## Benchmarks

The GeoJSON fixture is shared with the Go implementation (`tron-shared/shared/testdata/geojson_large.json`).

```sh
bun run bench
```

Fixture sizes (scale 10x): JSON 12,071 bytes, TRON 25,656 bytes.
Large scale (~1MB): JSON 967,253 bytes, TRON 2,092,484 bytes.
Update benchmarks change `features[0].properties.elevation` to `1500`.
TRON updates use proxy assignment plus `tronBytes(proxy)`; JSON updates use parse + modify + stringify.
Vacuum/canonical benchmarks run against bytes after a single update (history present).
Set `TRON_BENCH_SCALE=1` to run against the base fixture size.

Sample results (bun 1.2.20, Linux x86_64):

| Test | TRON MB/s | JSON MB/s |
| --- | --- | --- |
| proxy + read | 3459.94 | 285.92 |
| proxy update elevation (12KB) | 1043.66 | 163.63 |
| proxy update elevation (1MB) | 2591.83 | 202.09 |
| vacuum (history-free bytes) | 155.98 | 169.02 |
| canonical (spec bytes) | 37.74 | 164.81 |

JSON column corresponds to parse + read, parse + modify + stringify, parse + modify + stringify (1MB),
parse + stringify (updated JSON), and parse + stringify (updated JSON).

Results vary by machine; rerun `bun run bench` to refresh.

## Bundle size

Bundle size depends on tree-shaking. Import only `encode`/`tron` if you want
minimal output. Measurements are taken with esbuild (ESM, minified, ES2020)
and brotli.
