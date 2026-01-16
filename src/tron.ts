import { xxh32 } from "./xxh32";
import type { PathSegment, TronType, TronValue, ViewOptions } from "./codec";
import { canonical, detectType, setPath, vacuum } from "./codec";
import { stringifyJSONValue } from "./json";

export type TronProxy<T extends TronValue = TronValue> = T extends Uint8Array
  ? Uint8Array
  : T extends (infer U)[]
    ? (TronProxy<U>[] & {
        ToJSON: () => string;
        canonical: () => Uint8Array;
        vacuum: () => Uint8Array;
      })
    : T extends object
      ? ({
          [K in keyof T]: TronProxy<T[K]>;
        } & {
          ToJSON: () => string;
          canonical: () => Uint8Array;
          vacuum: () => Uint8Array;
        })
      : T;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const MAGIC = [0x54, 0x52, 0x4f, 0x4e]; // TRON
const HEADER_SIZE = 4;
const FOOTER_SIZE = 8;

enum ValueType {
  Nil = 0,
  Bit = 1,
  I64 = 2,
  F64 = 3,
  Txt = 4,
  Bin = 5,
  Arr = 6,
  Map = 7,
}

const MISSING = Symbol("missing");

type RootState = {
  tronBytes: Uint8Array;
  options: ViewOptions;
  version: number;
  proxyCache: Map<string, TronProxy>;
};

type ArrayState = {
  kind: "array";
  root: RootState;
  path: PathSegment[];
  cacheVersion: number;
  cache: Map<number, TronValue | typeof MISSING>;
  keysCache?: string[];
  lengthCache?: number;
  offsetCache?: number | null;
};

type MapState = {
  kind: "map";
  root: RootState;
  path: PathSegment[];
  cacheVersion: number;
  cache: Map<string, TronValue | typeof MISSING>;
  keyBytesCache: Map<string, Uint8Array>;
  keyHashCache: Map<string, number>;
  keysCache?: string[];
  offsetCache?: number | null;
};

const proxyState = new WeakMap<object, ArrayState | MapState>();

const readUint16LE = (buf: Uint8Array, offset: number): number =>
  buf[offset] | (buf[offset + 1] << 8);

const readUint32LE = (buf: Uint8Array, offset: number): number =>
  (buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    (buf[offset + 3] << 24)) >>> 0;

const popcount16 = (value: number): number => {
  let v = value & 0xffff;
  v = v - ((v >>> 1) & 0x5555);
  v = (v & 0x3333) + ((v >>> 2) & 0x3333);
  v = (v + (v >>> 4)) & 0x0f0f;
  v = v + (v >>> 8);
  return v & 0x1f;
};

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const toArrayIndex = (prop: string): number | null => {
  if (prop.length === 0) return null;
  const n = Number(prop);
  if (!Number.isInteger(n) || n < 0) return null;
  if (String(n) !== prop) return null;
  return n;
};

type NodeHeader = {
  type: ValueType.Arr | ValueType.Map;
  isLeaf: boolean;
  isRoot: boolean;
  nodeLen: number;
  headerSize: number;
};

const readNodeHeader = (tronBytes: Uint8Array, offset: number): NodeHeader => {
  if (offset >= tronBytes.length) throw new Error("tag");
  const tag = tronBytes[offset];
  const type = (tag & 0x07) as ValueType;
  if (type !== ValueType.Arr && type !== ValueType.Map) throw new Error("type");
  const lenBytes = ((tag >>> 4) & 0x03) + 1;
  const headerSize = 1 + lenBytes;
  if (offset + headerSize > tronBytes.length) throw new Error("short");
  let nodeLen = 0;
  for (let i = 0; i < lenBytes; i++) {
    nodeLen |= tronBytes[offset + 1 + i] << (8 * i);
  }
  if (nodeLen < headerSize) throw new Error("len");
  if (offset + nodeLen > tronBytes.length) throw new Error("short");
  return {
    type: type as ValueType.Arr | ValueType.Map,
    isLeaf: (tag & 0x08) !== 0,
    isRoot: type === ValueType.Arr ? (tag & 0x40) === 0 : false,
    nodeLen,
    headerSize,
  };
};

const readBytesLength = (
  tronBytes: Uint8Array,
  offset: number,
): { length: number; headerSize: number } => {
  if (offset >= tronBytes.length) throw new Error("tag");
  const tag = tronBytes[offset];
  const isPacked = (tag & 0x08) !== 0;
  const nibble = tag >>> 4;
  if (isPacked) return { length: nibble, headerSize: 1 };
  const n = nibble;
  if (n < 1 || n > 8) throw new Error("len");
  if (offset + 1 + n > tronBytes.length) throw new Error("short");
  let length = 0;
  for (let i = 0; i < n; i++) {
    length += tronBytes[offset + 1 + i] * 2 ** (8 * i);
  }
  if (!Number.isSafeInteger(length)) throw new Error("len");
  return { length, headerSize: 1 + n };
};

const readValueTypeAt = (tronBytes: Uint8Array, offset: number): ValueType => {
  if (offset >= tronBytes.length) throw new Error("tag");
  return (tronBytes[offset] & 0x07) as ValueType;
};

const readTxtBytesAt = (tronBytes: Uint8Array, offset: number): Uint8Array => {
  if (offset >= tronBytes.length) throw new Error("tag");
  const tag = tronBytes[offset];
  const type = (tag & 0x07) as ValueType;
  if (type !== ValueType.Txt) throw new Error("type");
  const { length, headerSize } = readBytesLength(tronBytes, offset);
  const start = offset + headerSize;
  const end = start + length;
  if (end > tronBytes.length) throw new Error("short");
  return tronBytes.subarray(start, end);
};

const ensureCacheFresh = (state: ArrayState | MapState): void => {
  if (state.cacheVersion === state.root.version) return;
  state.cacheVersion = state.root.version;
  state.cache.clear();
  state.keysCache = undefined;
  state.offsetCache = undefined;
  if (state.kind === "array") {
    state.lengthCache = undefined;
  }
};

const getRootOffset = (tronBytes: Uint8Array): number => {
  if (tronBytes.length < HEADER_SIZE + FOOTER_SIZE) throw new Error("short");
  for (let i = 0; i < MAGIC.length; i++) {
    if (tronBytes[i] !== MAGIC[i]) throw new Error("magic");
  }
  const footerStart = tronBytes.length - FOOTER_SIZE;
  const rootOffset = readUint32LE(tronBytes, footerStart);
  if (rootOffset < HEADER_SIZE || rootOffset >= footerStart) throw new Error("off");
  return rootOffset;
};

const getContainerOffset = (state: ArrayState | MapState): number | null => {
  ensureCacheFresh(state);
  if (state.offsetCache !== undefined) return state.offsetCache;
  const tronBytes = state.root.tronBytes;
  let offset = getRootOffset(tronBytes);
  if (state.path.length === 0) {
    const type = readValueTypeAt(tronBytes, offset);
    if (state.kind === "array" && type !== ValueType.Arr) {
      state.offsetCache = null;
      return null;
    }
    if (state.kind === "map" && type !== ValueType.Map) {
      state.offsetCache = null;
      return null;
    }
    state.offsetCache = offset;
    return state.offsetCache;
  }
  for (const segment of state.path) {
    const type = readValueTypeAt(tronBytes, offset);
    if (type === ValueType.Map) {
      if (typeof segment !== "string") {
        state.offsetCache = null;
        return null;
      }
      const keyBytes = textEncoder.encode(segment);
      const hash = xxh32(keyBytes, 0);
      const valueOffset = lookupMapValueOffsetAt(tronBytes, offset, keyBytes, hash, 0);
      if (valueOffset === undefined) {
        state.offsetCache = null;
        return null;
      }
      const nextType = readValueTypeAt(tronBytes, valueOffset);
      if (nextType !== ValueType.Arr && nextType !== ValueType.Map) {
        state.offsetCache = null;
        return null;
      }
      offset = valueOffset;
    } else if (type === ValueType.Arr) {
      if (typeof segment !== "number" || !Number.isInteger(segment) || segment < 0) {
        state.offsetCache = null;
        return null;
      }
      const valueOffset = lookupArrayValueOffsetAt(tronBytes, offset, segment);
      if (valueOffset === undefined) {
        state.offsetCache = null;
        return null;
      }
      const nextType = readValueTypeAt(tronBytes, valueOffset);
      if (nextType !== ValueType.Arr && nextType !== ValueType.Map) {
        state.offsetCache = null;
        return null;
      }
      offset = valueOffset;
    } else {
      state.offsetCache = null;
      return null;
    }
  }
  const finalType = readValueTypeAt(tronBytes, offset);
  if (state.kind === "array" && finalType !== ValueType.Arr) {
    state.offsetCache = null;
    return null;
  }
  if (state.kind === "map" && finalType !== ValueType.Map) {
    state.offsetCache = null;
    return null;
  }
  state.offsetCache = offset;
  return state.offsetCache;
};

const decodeValueAt = (
  tronBytes: Uint8Array,
  offset: number,
  root: RootState | null,
  pathPrefix: PathSegment[] | null,
  pathSegment: PathSegment | null,
): [TronValue, number] => {
  if (offset >= tronBytes.length) throw new Error("tag");
  const tag = tronBytes[offset];
  const typ = (tag & 0x07) as ValueType;

  switch (typ) {
    case ValueType.Nil:
      return [null, 1];
    case ValueType.Bit:
      return [(tag & 0x08) !== 0, 1];
    case ValueType.I64: {
      if (offset + 9 > tronBytes.length) throw new Error("short");
      const value = new DataView(
        tronBytes.buffer,
        tronBytes.byteOffset + offset + 1,
        8,
      ).getBigInt64(0, true);
      const mode = root?.options.i64 ?? "auto";
      if (mode === "bigint") {
        return [value, 9];
      }
      if (value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER) {
        if (mode === "number") {
          throw new Error("range");
        }
        return [value, 9];
      }
      return [Number(value), 9];
    }
    case ValueType.F64: {
      if (offset + 9 > tronBytes.length) throw new Error("short");
      return [
        new DataView(tronBytes.buffer, tronBytes.byteOffset + offset + 1, 8).getFloat64(0, true),
        9,
      ];
    }
    case ValueType.Txt:
    case ValueType.Bin: {
      const { length, headerSize } = readBytesLength(tronBytes, offset);
      const start = offset + headerSize;
      const end = start + length;
      if (end > tronBytes.length) throw new Error("short");
      const payload = tronBytes.subarray(start, end);
      if (typ === ValueType.Txt) {
        return [textDecoder.decode(payload), end - offset];
      }
      return [payload.slice(), end - offset];
    }
    case ValueType.Arr:
    case ValueType.Map: {
      const header = readNodeHeader(tronBytes, offset);
      if (!root || !pathPrefix || pathSegment === null) throw new Error("type");
      const kind = typ === ValueType.Arr ? "array" : "map";
      const nextPath = pathPrefix.length ? [...pathPrefix, pathSegment] : [pathSegment];
      const proxy = getProxyForPath(root, kind, nextPath, offset);
      return [proxy, header.nodeLen];
    }
    default:
      break;
  }
  throw new Error("type");
};

const arrayHasIndexAt = (tronBytes: Uint8Array, offset: number, index: number): boolean => {
  const header = readNodeHeader(tronBytes, offset);
  if (header.type !== ValueType.Arr) throw new Error("type");
  const payloadStart = offset + header.headerSize;
  const shift = tronBytes[payloadStart];
  const bitmap = readUint16LE(tronBytes, payloadStart + 1);
  const addressesStart = payloadStart + 3 + (header.isRoot ? 4 : 0);
  if (header.isLeaf) {
    const slot = index & 0x0f;
    return ((bitmap >>> slot) & 1) === 1;
  }
  const slot = (index >>> shift) & 0x0f;
  if (((bitmap >>> slot) & 1) === 0) return false;
  const rank = popcount16(bitmap & ((1 << slot) - 1));
  const childOffset = readUint32LE(tronBytes, addressesStart + rank * 4);
  return arrayHasIndexAt(tronBytes, childOffset, index);
};

const lookupArrayValueOffsetAt = (
  tronBytes: Uint8Array,
  offset: number,
  index: number,
): number | undefined => {
  const header = readNodeHeader(tronBytes, offset);
  if (header.type !== ValueType.Arr) throw new Error("type");
  const payloadStart = offset + header.headerSize;
  const shift = tronBytes[payloadStart];
  const bitmap = readUint16LE(tronBytes, payloadStart + 1);
  const addressesStart = payloadStart + 3 + (header.isRoot ? 4 : 0);
  if (header.isLeaf) {
    const slot = index & 0x0f;
    if (((bitmap >>> slot) & 1) === 0) return undefined;
    const rank = popcount16(bitmap & ((1 << slot) - 1));
    return readUint32LE(tronBytes, addressesStart + rank * 4);
  }
  const slot = (index >>> shift) & 0x0f;
  if (((bitmap >>> slot) & 1) === 0) return undefined;
  const rank = popcount16(bitmap & ((1 << slot) - 1));
  const childOffset = readUint32LE(tronBytes, addressesStart + rank * 4);
  return lookupArrayValueOffsetAt(tronBytes, childOffset, index);
};

const lookupArrayValueAt = (
  tronBytes: Uint8Array,
  offset: number,
  index: number,
  root: RootState,
  pathPrefix: PathSegment[],
  pathSegment: number,
): TronValue | undefined => {
  const valueOffset = lookupArrayValueOffsetAt(tronBytes, offset, index);
  if (valueOffset === undefined) return undefined;
  const [value] = decodeValueAt(tronBytes, valueOffset, root, pathPrefix, pathSegment);
  return value;
};

const mapHasKeyAt = (
  tronBytes: Uint8Array,
  offset: number,
  keyBytes: Uint8Array,
  hash: number,
  depth: number,
): boolean => {
  const header = readNodeHeader(tronBytes, offset);
  if (header.type !== ValueType.Map) throw new Error("type");
  const payloadStart = offset + header.headerSize;
  if (header.isLeaf) {
    const payloadLen = header.nodeLen - header.headerSize;
    if (payloadLen % 8 !== 0) throw new Error("len");
    const entryCount = payloadLen / 8;
    for (let i = 0; i < entryCount; i++) {
      const entryPos = payloadStart + i * 8;
      const keyOffset = readUint32LE(tronBytes, entryPos);
      const keyBytesAt = readTxtBytesAt(tronBytes, keyOffset);
      if (bytesEqual(keyBytesAt, keyBytes)) return true;
    }
    return false;
  }
  const bitmap = readUint32LE(tronBytes, payloadStart);
  const slot = (hash >>> (depth * 4)) & 0x0f;
  if (((bitmap >>> slot) & 1) === 0) return false;
  const rank = popcount16(bitmap & ((1 << slot) - 1));
  const childOffset = readUint32LE(tronBytes, payloadStart + 4 + rank * 4);
  return mapHasKeyAt(tronBytes, childOffset, keyBytes, hash, depth + 1);
};

const getKeyBytes = (state: MapState, key: string): Uint8Array => {
  const cached = state.keyBytesCache.get(key);
  if (cached) return cached;
  const bytes = textEncoder.encode(key);
  state.keyBytesCache.set(key, bytes);
  return bytes;
};

const getKeyHash = (state: MapState, key: string): number => {
  const cached = state.keyHashCache.get(key);
  if (cached !== undefined) return cached;
  const hash = xxh32(getKeyBytes(state, key), 0);
  state.keyHashCache.set(key, hash);
  return hash;
};

const lookupMapValueOffsetAt = (
  tronBytes: Uint8Array,
  offset: number,
  keyBytes: Uint8Array,
  hash: number,
  depth: number,
): number | undefined => {
  const header = readNodeHeader(tronBytes, offset);
  if (header.type !== ValueType.Map) throw new Error("type");
  const payloadStart = offset + header.headerSize;
  if (header.isLeaf) {
    const payloadLen = header.nodeLen - header.headerSize;
    if (payloadLen % 8 !== 0) throw new Error("len");
    const entryCount = payloadLen / 8;
    for (let i = 0; i < entryCount; i++) {
      const entryPos = payloadStart + i * 8;
      const keyOffset = readUint32LE(tronBytes, entryPos);
      const valueOffset = readUint32LE(tronBytes, entryPos + 4);
      const keyBytesAt = readTxtBytesAt(tronBytes, keyOffset);
      if (bytesEqual(keyBytesAt, keyBytes)) {
        return valueOffset;
      }
    }
    return undefined;
  }
  const bitmap = readUint32LE(tronBytes, payloadStart);
  const slot = (hash >>> (depth * 4)) & 0x0f;
  if (((bitmap >>> slot) & 1) === 0) return undefined;
  const rank = popcount16(bitmap & ((1 << slot) - 1));
  const childOffset = readUint32LE(tronBytes, payloadStart + 4 + rank * 4);
  return lookupMapValueOffsetAt(tronBytes, childOffset, keyBytes, hash, depth + 1);
};

const lookupMapValueAt = (
  tronBytes: Uint8Array,
  offset: number,
  keyBytes: Uint8Array,
  hash: number,
  depth: number,
  root: RootState,
  pathPrefix: PathSegment[],
  pathSegment: string,
): TronValue | undefined => {
  const valueOffset = lookupMapValueOffsetAt(tronBytes, offset, keyBytes, hash, depth);
  if (valueOffset === undefined) return undefined;
  const [value] = decodeValueAt(tronBytes, valueOffset, root, pathPrefix, pathSegment);
  return value;
};

const collectArrayIndices = (
  tronBytes: Uint8Array,
  offset: number,
  baseIndex: number,
  out: number[],
): void => {
  const header = readNodeHeader(tronBytes, offset);
  if (header.type !== ValueType.Arr) throw new Error("type");
  const payloadStart = offset + header.headerSize;
  const shift = tronBytes[payloadStart];
  const bitmap = readUint16LE(tronBytes, payloadStart + 1);
  const addressesStart = payloadStart + 3 + (header.isRoot ? 4 : 0);
  if (header.isLeaf) {
    for (let slot = 0; slot < 16; slot++) {
      if (((bitmap >>> slot) & 1) === 0) continue;
      out.push(baseIndex + slot);
    }
    return;
  }
  let p = addressesStart;
  for (let slot = 0; slot < 16; slot++) {
    if (((bitmap >>> slot) & 1) === 0) continue;
    const childOffset = readUint32LE(tronBytes, p);
    p += 4;
    const childBase = baseIndex + slot * (1 << shift);
    collectArrayIndices(tronBytes, childOffset, childBase, out);
  }
};

const collectMapKeys = (tronBytes: Uint8Array, offset: number, out: string[]): void => {
  const header = readNodeHeader(tronBytes, offset);
  if (header.type !== ValueType.Map) throw new Error("type");
  const payloadStart = offset + header.headerSize;
  if (header.isLeaf) {
    const payloadLen = header.nodeLen - header.headerSize;
    if (payloadLen % 8 !== 0) throw new Error("len");
    const entryCount = payloadLen / 8;
    for (let i = 0; i < entryCount; i++) {
      const entryPos = payloadStart + i * 8;
      const keyOffset = readUint32LE(tronBytes, entryPos);
      const keyBytes = readTxtBytesAt(tronBytes, keyOffset);
      out.push(textDecoder.decode(keyBytes));
    }
    return;
  }
  const bitmap = readUint32LE(tronBytes, payloadStart);
  let p = payloadStart + 4;
  for (let slot = 0; slot < 16; slot++) {
    if (((bitmap >>> slot) & 1) === 0) continue;
    const childOffset = readUint32LE(tronBytes, p);
    p += 4;
    collectMapKeys(tronBytes, childOffset, out);
  }
};

const getArrayLength = (state: ArrayState): number => {
  ensureCacheFresh(state);
  if (state.lengthCache !== undefined) return state.lengthCache;
  const offset = getContainerOffset(state);
  if (offset === null) {
    state.lengthCache = 0;
    return 0;
  }
  const header = readNodeHeader(state.root.tronBytes, offset);
  if (header.type !== ValueType.Arr || !header.isRoot) throw new Error("type");
  const payloadStart = offset + header.headerSize;
  const length = readUint32LE(state.root.tronBytes, payloadStart + 3);
  state.lengthCache = length;
  return length;
};

const arrayHasIndex = (state: ArrayState, index: number): boolean => {
  ensureCacheFresh(state);
  if (index < 0) return false;
  const length = getArrayLength(state);
  if (index >= length) return false;
  const offset = getContainerOffset(state);
  if (offset === null) return false;
  return arrayHasIndexAt(state.root.tronBytes, offset, index);
};

const getArrayValue = (state: ArrayState, index: number): TronValue | undefined => {
  const cached = state.cache.get(index);
  if (cached === MISSING) return undefined;
  if (cached !== undefined) return cached;
  ensureCacheFresh(state);
  let value: TronValue | undefined;
  if (index < 0) {
    value = undefined;
  } else {
    const length = getArrayLength(state);
    if (index >= length) {
      value = undefined;
    } else {
      const offset = getContainerOffset(state);
      if (offset === null) {
        value = undefined;
      } else {
        value = lookupArrayValueAt(state.root.tronBytes, offset, index, state.root, state.path, index);
      }
    }
  }
  state.cache.set(index, value === undefined ? MISSING : value);
  return value;
};

const mapHasKey = (state: MapState, key: string): boolean => {
  ensureCacheFresh(state);
  const cached = state.cache.get(key);
  if (cached === MISSING) return false;
  if (cached !== undefined) return true;
  const keyBytes = getKeyBytes(state, key);
  const hash = getKeyHash(state, key);
  const offset = getContainerOffset(state);
  if (offset === null) return false;
  return mapHasKeyAt(state.root.tronBytes, offset, keyBytes, hash, 0);
};

const getMapValue = (
  state: MapState,
  key: string,
  receiver: object,
  fallbackTarget: Record<string, TronValue>,
): TronValue | undefined => {
  ensureCacheFresh(state);
  const cached = state.cache.get(key);
  if (cached === MISSING) {
    return Reflect.get(fallbackTarget, key, receiver) as TronValue;
  }
  if (cached !== undefined) return cached;
  const keyBytes = getKeyBytes(state, key);
  const hash = getKeyHash(state, key);
  const offset = getContainerOffset(state);
  const value =
    offset === null
      ? undefined
      : lookupMapValueAt(
          state.root.tronBytes,
          offset,
          keyBytes,
          hash,
          0,
          state.root,
          state.path,
          key,
        );
  if (value === undefined) {
    state.cache.set(key, MISSING);
    return Reflect.get(fallbackTarget, key, receiver) as TronValue;
  }
  state.cache.set(key, value);
  return value;
};

const updatePath = (root: RootState, path: PathSegment[], value: TronValue): void => {
  root.tronBytes = setPath(root.tronBytes, path, value);
  root.version += 1;
};

const getProxyForPath = (
  root: RootState,
  kind: "array" | "map",
  path: PathSegment[],
  offset?: number,
): TronProxy => {
  const key = `${kind}:${JSON.stringify(path)}`;
  const cached = root.proxyCache.get(key);
  if (cached) {
    const state = proxyState.get(cached as object);
    if (state) {
      ensureCacheFresh(state);
      if (offset !== undefined && state.cacheVersion === root.version) {
        state.offsetCache = offset;
      }
    }
    return cached;
  }
  let proxy: TronProxy;
  if (kind === "array") {
    const state: ArrayState = {
      kind: "array",
      root,
      path,
      cacheVersion: root.version,
      cache: new Map(),
      offsetCache: offset === undefined ? undefined : offset,
    };
    const target: TronValue[] = [];
    const handler: ProxyHandler<TronValue[]> = {
      get(_target, prop, receiver) {
        if (prop === "ToJSON") {
          return () => stringifyJSONValue(receiver);
        }
        if (prop === "canonical") {
          return () => canonical(state.root.tronBytes);
        }
        if (prop === "vacuum") {
          return () => vacuum(state.root.tronBytes);
        }
        if (prop === "length") return getArrayLength(state);
        if (prop === Symbol.iterator) {
          return function* () {
            const length = getArrayLength(state);
            for (let i = 0; i < length; i++) {
              yield getArrayValue(state, i);
            }
          };
        }
        if (typeof prop === "string") {
          const index = toArrayIndex(prop);
          if (index !== null) {
            return getArrayValue(state, index);
          }
        }
        return Reflect.get(target, prop, receiver);
      },
      has(_target, prop) {
        if (prop === "length") return true;
        if (typeof prop === "string") {
          const index = toArrayIndex(prop);
          if (index !== null) return arrayHasIndex(state, index);
        }
        return Reflect.has(target, prop);
      },
      ownKeys() {
        ensureCacheFresh(state);
        if (!state.keysCache) {
          const indices: number[] = [];
          const offset = getContainerOffset(state);
          if (offset !== null) {
            collectArrayIndices(state.root.tronBytes, offset, 0, indices);
            indices.sort((a, b) => a - b);
          }
          state.keysCache = indices.map((idx) => idx.toString());
        }
        return [...state.keysCache, "length"];
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (prop === "length") {
          return {
            value: getArrayLength(state),
            writable: true,
            enumerable: false,
            configurable: false,
          };
        }
        if (typeof prop === "string") {
          const index = toArrayIndex(prop);
          if (index !== null && arrayHasIndex(state, index)) {
            return {
              value: getArrayValue(state, index),
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
        }
        return undefined;
      },
      set(_target, prop, value, receiver) {
        if (prop === "length") {
          const nextLength = Number(value);
          if (!Number.isInteger(nextLength) || nextLength < 0) return false;
          const length = getArrayLength(state);
          if (nextLength < length) return false;
          return true;
        }
        if (typeof prop === "string") {
          const index = toArrayIndex(prop);
          if (index !== null) {
            updatePath(root, [...path, index], value as TronValue);
            return true;
          }
        }
        return Reflect.set(_target, prop, value, receiver);
      },
      defineProperty() {
        return false;
      },
      deleteProperty() {
        return false;
      },
    };
    proxy = new Proxy(target, handler) as TronProxy;
    proxyState.set(proxy as object, state);
  } else {
    const state: MapState = {
      kind: "map",
      root,
      path,
      cacheVersion: root.version,
      cache: new Map(),
      keyBytesCache: new Map(),
      keyHashCache: new Map(),
      offsetCache: offset === undefined ? undefined : offset,
    };
    const target: Record<string, TronValue> = {};
    const handler: ProxyHandler<Record<string, TronValue>> = {
      get(_target, prop, receiver) {
        if (prop === "ToJSON") {
          return () => stringifyJSONValue(receiver);
        }
        if (prop === "canonical") {
          return () => canonical(state.root.tronBytes);
        }
        if (prop === "vacuum") {
          return () => vacuum(state.root.tronBytes);
        }
        if (typeof prop === "string") {
          return getMapValue(state, prop, receiver, target);
        }
        return Reflect.get(target, prop, receiver);
      },
      has(_target, prop) {
        if (typeof prop === "string") {
          return mapHasKey(state, prop) || Reflect.has(target, prop);
        }
        return Reflect.has(target, prop);
      },
      ownKeys() {
        ensureCacheFresh(state);
        if (!state.keysCache) {
          const keys: string[] = [];
          const offset = getContainerOffset(state);
          if (offset !== null) {
            collectMapKeys(state.root.tronBytes, offset, keys);
          }
          const numeric: number[] = [];
          const other: string[] = [];
          for (const key of keys) {
            const index = toArrayIndex(key);
            if (index !== null && index < 2 ** 32 - 1) {
              numeric.push(index);
            } else {
              other.push(key);
            }
          }
          numeric.sort((a, b) => a - b);
          state.keysCache = [...numeric.map((value) => value.toString()), ...other];
        }
        return [...state.keysCache];
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (typeof prop === "string" && mapHasKey(state, prop)) {
          return {
            value: getMapValue(state, prop, _target, _target),
            writable: true,
            enumerable: true,
            configurable: true,
          };
        }
        return undefined;
      },
      set(_target, prop, value, receiver) {
        if (typeof prop === "string") {
          updatePath(root, [...path, prop], value as TronValue);
          return true;
        }
        return Reflect.set(_target, prop, value, receiver);
      },
      defineProperty() {
        return false;
      },
      deleteProperty() {
        return false;
      },
    };
    proxy = new Proxy(target, handler) as TronProxy;
    proxyState.set(proxy as object, state);
  }
  root.proxyCache.set(key, proxy);
  return proxy;
};

export const tron = (tronBytes: Uint8Array, options: ViewOptions = {}): TronProxy => {
  const tronType: TronType = detectType(tronBytes);
  const viewOptions: ViewOptions = { i64: options.i64 ?? "auto" };
  const rootState: RootState = {
    tronBytes,
    options: viewOptions,
    version: 0,
    proxyCache: new Map(),
  };
  const rootOffset = getRootOffset(tronBytes);

  if (tronType === "scalar") {
    const [value] = decodeValueAt(tronBytes, rootOffset, rootState, null, null);
    return value as TronProxy;
  }

  const type = readValueTypeAt(tronBytes, rootOffset);
  if (type === ValueType.Arr) {
    return getProxyForPath(rootState, "array", [], rootOffset);
  }
  if (type === ValueType.Map) {
    return getProxyForPath(rootState, "map", [], rootOffset);
  }
  throw new Error("type");
};

export const tronBytes = (value: unknown): Uint8Array => {
  if (value && (typeof value === "object" || typeof value === "function")) {
    const state = proxyState.get(value as object);
    if (state) return state.root.tronBytes;
  }
  throw new Error("proxy");
};
