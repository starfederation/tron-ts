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

const SCALAR_MAGIC = [0x4e, 0x4f, 0x52, 0x54]; // NORT
const TRAILER_SIZE = 12;

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

enum NodeKind {
  Branch = 0,
  Leaf = 1,
}

enum KeyType {
  Arr = 0,
  Map = 1,
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
  nodeLen: number;
  kind: NodeKind;
  keyType: KeyType;
  entryCount: number;
};

const readNodeHeader = (tronBytes: Uint8Array, offset: number): NodeHeader => {
  if (offset + 8 > tronBytes.length) throw new Error("short");
  const raw = readUint32LE(tronBytes, offset);
  const kind = (raw & 0x1) as NodeKind;
  const keyType = ((raw >>> 1) & 0x1) as KeyType;
  const nodeLen = raw & ~0x3;
  if (nodeLen < 8 || nodeLen % 4 !== 0) throw new Error("len");
  const entryCount = readUint32LE(tronBytes, offset + 4);
  if (offset + nodeLen > tronBytes.length) throw new Error("short");
  return { nodeLen, kind, keyType, entryCount };
};

const readLength = (
  tronBytes: Uint8Array,
  offset: number,
): { length: number; headerSize: number } => {
  const tag = tronBytes[offset];
  if ((tag & 0x10) !== 0) {
    return { length: tag & 0x0f, headerSize: 1 };
  }
  const n = tag & 0x0f;
  if (n < 1 || n > 8) throw new Error("len");
  if (offset + 1 + n > tronBytes.length) throw new Error("short");
  let length = 0;
  for (let i = 0; i < n; i++) {
    length += tronBytes[offset + 1 + i] * 2 ** (8 * i);
  }
  if (!Number.isSafeInteger(length)) throw new Error("len");
  return { length, headerSize: 1 + n };
};

const skipValueAt = (tronBytes: Uint8Array, offset: number): number => {
  if (offset >= tronBytes.length) throw new Error("tag");
  const tag = tronBytes[offset];
  const typ = ((tag >>> 5) & 0x07) as ValueType;
  switch (typ) {
    case ValueType.Nil:
    case ValueType.Bit:
      return 1;
    case ValueType.I64:
    case ValueType.F64:
      return 9;
    case ValueType.Txt:
    case ValueType.Bin:
    case ValueType.Arr:
    case ValueType.Map: {
      const { length, headerSize } = readLength(tronBytes, offset);
      const end = offset + headerSize + length;
      if (end > tronBytes.length) throw new Error("short");
      return headerSize + length;
    }
    default:
      throw new Error("type");
  }
};

type EncodedValue = {
  type: ValueType;
  bool?: boolean;
  i64?: bigint;
  f64?: number;
  bytes?: Uint8Array;
  offset?: number;
};

const readEncodedValue = (
  tronBytes: Uint8Array,
  offset: number,
): [EncodedValue, number] => {
  if (offset >= tronBytes.length) throw new Error("tag");
  const tag = tronBytes[offset];
  const typ = ((tag >>> 5) & 0x07) as ValueType;
  switch (typ) {
    case ValueType.Nil:
      return [{ type: ValueType.Nil }, 1];
    case ValueType.Bit:
      return [{ type: ValueType.Bit, bool: (tag & 0x01) === 1 }, 1];
    case ValueType.I64: {
      if (offset + 9 > tronBytes.length) throw new Error("short");
      const i64 = new DataView(
        tronBytes.buffer,
        tronBytes.byteOffset + offset + 1,
        8,
      ).getBigInt64(0, true);
      return [{ type: ValueType.I64, i64 }, 9];
    }
    case ValueType.F64: {
      if (offset + 9 > tronBytes.length) throw new Error("short");
      const f64 = new DataView(
        tronBytes.buffer,
        tronBytes.byteOffset + offset + 1,
        8,
      ).getFloat64(0, true);
      return [{ type: ValueType.F64, f64 }, 9];
    }
    case ValueType.Txt:
    case ValueType.Bin:
    case ValueType.Arr:
    case ValueType.Map: {
      const { length, headerSize } = readLength(tronBytes, offset);
      const start = offset + headerSize;
      const end = start + length;
      if (end > tronBytes.length) throw new Error("short");
      const payload = tronBytes.subarray(start, end);
      if (typ === ValueType.Txt || typ === ValueType.Bin) {
        return [{ type: typ, bytes: payload }, headerSize + length];
      }
      if (length === 0 || length > 4) throw new Error("off");
      let off = 0;
      for (let i = 0; i < length; i++) {
        off |= payload[i] << (8 * i);
      }
      return [{ type: typ, offset: off >>> 0 }, headerSize + length];
    }
    default:
      break;
  }
  throw new Error("type");
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
  const start = tronBytes.length - TRAILER_SIZE;
  return readUint32LE(tronBytes, start);
};

const getContainerOffset = (state: ArrayState | MapState): number | null => {
  ensureCacheFresh(state);
  if (state.offsetCache !== undefined) return state.offsetCache;
  const tronBytes = state.root.tronBytes;
  let offset = getRootOffset(tronBytes);
  let header = readNodeHeader(tronBytes, offset);
  if (state.path.length === 0) {
    if (state.kind === "array" && header.keyType !== KeyType.Arr) {
      state.offsetCache = null;
      return null;
    }
    if (state.kind === "map" && header.keyType !== KeyType.Map) {
      state.offsetCache = null;
      return null;
    }
    state.offsetCache = offset;
    return state.offsetCache;
  }
  for (const segment of state.path) {
    if (header.keyType === KeyType.Map) {
      if (typeof segment !== "string") {
        state.offsetCache = null;
        return null;
      }
      const keyBytes = textEncoder.encode(segment);
      const hash = xxh32(keyBytes, 0);
      const encoded = lookupMapEncodedAt(tronBytes, offset, keyBytes, hash, 0);
      if (!encoded || encoded.offset === undefined) {
        state.offsetCache = null;
        return null;
      }
      if (encoded.type !== ValueType.Arr && encoded.type !== ValueType.Map) {
        state.offsetCache = null;
        return null;
      }
      offset = encoded.offset;
    } else if (header.keyType === KeyType.Arr) {
      if (typeof segment !== "number" || !Number.isInteger(segment) || segment < 0) {
        state.offsetCache = null;
        return null;
      }
      const encoded = lookupArrayEncodedAt(tronBytes, offset, segment);
      if (!encoded || encoded.offset === undefined) {
        state.offsetCache = null;
        return null;
      }
      if (encoded.type !== ValueType.Arr && encoded.type !== ValueType.Map) {
        state.offsetCache = null;
        return null;
      }
      offset = encoded.offset;
    } else {
      state.offsetCache = null;
      return null;
    }
    header = readNodeHeader(tronBytes, offset);
  }
  if (state.kind === "array" && header.keyType !== KeyType.Arr) {
    state.offsetCache = null;
    return null;
  }
  if (state.kind === "map" && header.keyType !== KeyType.Map) {
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
  const typ = ((tag >>> 5) & 0x07) as ValueType;

  switch (typ) {
    case ValueType.Nil:
      return [null, 1];
    case ValueType.Bit:
      return [(tag & 0x01) === 1, 1];
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
        new DataView(tronBytes.buffer, tronBytes.byteOffset + offset + 1, 8).getFloat64(
          0,
          true,
        ),
        9,
      ];
    }
    case ValueType.Txt:
    case ValueType.Bin:
    case ValueType.Arr:
    case ValueType.Map: {
      const { length, headerSize } = readLength(tronBytes, offset);
      const start = offset + headerSize;
      const end = start + length;
      if (end > tronBytes.length) throw new Error("short");
      const payload = tronBytes.subarray(start, end);
      switch (typ) {
        case ValueType.Txt:
          return [textDecoder.decode(payload), end - offset];
        case ValueType.Bin:
          return [payload.slice(), end - offset];
        case ValueType.Arr:
        case ValueType.Map: {
          if (!root || !pathPrefix || pathSegment === null) throw new Error("type");
          if (length === 0 || length > 4) throw new Error("off");
          let nodeOffset = 0;
          for (let i = 0; i < length; i++) {
            nodeOffset |= payload[i] << (8 * i);
          }
          const kind = typ === ValueType.Arr ? "array" : "map";
          const nextPath = pathPrefix.length
            ? [...pathPrefix, pathSegment]
            : [pathSegment];
          const proxy = getProxyForPath(root, kind, nextPath, nodeOffset >>> 0);
          return [proxy, end - offset];
        }
      }
      break;
    }
    default:
      break;
  }
  throw new Error("type");
};

const arrayHasIndexAt = (tronBytes: Uint8Array, offset: number, index: number): boolean => {
  const header = readNodeHeader(tronBytes, offset);
  if (header.keyType !== KeyType.Arr) throw new Error("type");
  const nodeStart = offset + 8;
  const shift = tronBytes[nodeStart];
  const bitmap = readUint16LE(tronBytes, nodeStart + 2);
  if (header.kind === NodeKind.Leaf) {
    const slot = index & 0x0f;
    return ((bitmap >>> slot) & 1) === 1;
  }
  const slot = (index >>> shift) & 0x0f;
  if (((bitmap >>> slot) & 1) === 0) return false;
  const rank = popcount16(bitmap & ((1 << slot) - 1));
  const childOffset = readUint32LE(tronBytes, nodeStart + 8 + rank * 4);
  return arrayHasIndexAt(tronBytes, childOffset, index);
};

const lookupArrayEncodedAt = (
  tronBytes: Uint8Array,
  offset: number,
  index: number,
): EncodedValue | undefined => {
  const header = readNodeHeader(tronBytes, offset);
  if (header.keyType !== KeyType.Arr) throw new Error("type");
  const nodeStart = offset + 8;
  const shift = tronBytes[nodeStart];
  const bitmap = readUint16LE(tronBytes, nodeStart + 2);
  if (header.kind === NodeKind.Leaf) {
    const slot = index & 0x0f;
    if (((bitmap >>> slot) & 1) === 0) return undefined;
    const rank = popcount16(bitmap & ((1 << slot) - 1));
    let p = nodeStart + 8;
    for (let i = 0; i < rank; i++) {
      p += skipValueAt(tronBytes, p);
    }
    const [value] = readEncodedValue(tronBytes, p);
    return value;
  }
  const slot = (index >>> shift) & 0x0f;
  if (((bitmap >>> slot) & 1) === 0) return undefined;
  const rank = popcount16(bitmap & ((1 << slot) - 1));
  const childOffset = readUint32LE(tronBytes, nodeStart + 8 + rank * 4);
  return lookupArrayEncodedAt(tronBytes, childOffset, index);
};

const lookupArrayValueAt = (
  tronBytes: Uint8Array,
  offset: number,
  index: number,
  root: RootState,
  pathPrefix: PathSegment[],
  pathSegment: number,
): TronValue | undefined => {
  const header = readNodeHeader(tronBytes, offset);
  if (header.keyType !== KeyType.Arr) throw new Error("type");
  const nodeStart = offset + 8;
  const shift = tronBytes[nodeStart];
  const bitmap = readUint16LE(tronBytes, nodeStart + 2);
  if (header.kind === NodeKind.Leaf) {
    const slot = index & 0x0f;
    if (((bitmap >>> slot) & 1) === 0) return undefined;
    const rank = popcount16(bitmap & ((1 << slot) - 1));
    let p = nodeStart + 8;
    for (let i = 0; i < rank; i++) {
      p += skipValueAt(tronBytes, p);
    }
    const [value] = decodeValueAt(tronBytes, p, root, pathPrefix, pathSegment);
    return value;
  }
  const slot = (index >>> shift) & 0x0f;
  if (((bitmap >>> slot) & 1) === 0) return undefined;
  const rank = popcount16(bitmap & ((1 << slot) - 1));
  const childOffset = readUint32LE(tronBytes, nodeStart + 8 + rank * 4);
  return lookupArrayValueAt(tronBytes, childOffset, index, root, pathPrefix, pathSegment);
};

const mapHasKeyAt = (
  tronBytes: Uint8Array,
  offset: number,
  keyBytes: Uint8Array,
  hash: number,
  depth: number,
): boolean => {
  const header = readNodeHeader(tronBytes, offset);
  if (header.keyType !== KeyType.Map) throw new Error("type");
  const nodeStart = offset + 8;
  if (header.kind === NodeKind.Leaf) {
    let p = nodeStart;
    for (let i = 0; i < header.entryCount; i++) {
      const [keyVal, keySize] = readEncodedValue(tronBytes, p);
      if (keyVal.type !== ValueType.Txt || !keyVal.bytes) throw new Error("type");
      p += keySize;
      if (bytesEqual(keyVal.bytes, keyBytes)) return true;
      p += skipValueAt(tronBytes, p);
    }
    return false;
  }
  const bitmap = readUint16LE(tronBytes, nodeStart);
  const slot = (hash >>> (depth * 4)) & 0x0f;
  if (((bitmap >>> slot) & 1) === 0) return false;
  const rank = popcount16(bitmap & ((1 << slot) - 1));
  const childOffset = readUint32LE(tronBytes, nodeStart + 4 + rank * 4);
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

const lookupMapEncodedAt = (
  tronBytes: Uint8Array,
  offset: number,
  keyBytes: Uint8Array,
  hash: number,
  depth: number,
): EncodedValue | undefined => {
  const header = readNodeHeader(tronBytes, offset);
  if (header.keyType !== KeyType.Map) throw new Error("type");
  const nodeStart = offset + 8;
  if (header.kind === NodeKind.Leaf) {
    let p = nodeStart;
    for (let i = 0; i < header.entryCount; i++) {
      const [keyVal, keySize] = readEncodedValue(tronBytes, p);
      if (keyVal.type !== ValueType.Txt || !keyVal.bytes) throw new Error("type");
      p += keySize;
      const [value, valueSize] = readEncodedValue(tronBytes, p);
      p += valueSize;
      if (bytesEqual(keyVal.bytes, keyBytes)) {
        return value;
      }
    }
    return undefined;
  }
  const bitmap = readUint16LE(tronBytes, nodeStart);
  const slot = (hash >>> (depth * 4)) & 0x0f;
  if (((bitmap >>> slot) & 1) === 0) return undefined;
  const rank = popcount16(bitmap & ((1 << slot) - 1));
  const childOffset = readUint32LE(tronBytes, nodeStart + 4 + rank * 4);
  return lookupMapEncodedAt(tronBytes, childOffset, keyBytes, hash, depth + 1);
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
  const header = readNodeHeader(tronBytes, offset);
  if (header.keyType !== KeyType.Map) throw new Error("type");
  const nodeStart = offset + 8;
  if (header.kind === NodeKind.Leaf) {
    let p = nodeStart;
    for (let i = 0; i < header.entryCount; i++) {
      const [keyVal, keySize] = readEncodedValue(tronBytes, p);
      if (keyVal.type !== ValueType.Txt || !keyVal.bytes) throw new Error("type");
      p += keySize;
      if (bytesEqual(keyVal.bytes, keyBytes)) {
        const [value] = decodeValueAt(tronBytes, p, root, pathPrefix, pathSegment);
        return value;
      }
      p += skipValueAt(tronBytes, p);
    }
    return undefined;
  }
  const bitmap = readUint16LE(tronBytes, nodeStart);
  const slot = (hash >>> (depth * 4)) & 0x0f;
  if (((bitmap >>> slot) & 1) === 0) return undefined;
  const rank = popcount16(bitmap & ((1 << slot) - 1));
  const childOffset = readUint32LE(tronBytes, nodeStart + 4 + rank * 4);
  return lookupMapValueAt(
    tronBytes,
    childOffset,
    keyBytes,
    hash,
    depth + 1,
    root,
    pathPrefix,
    pathSegment,
  );
};

const collectArrayIndices = (
  tronBytes: Uint8Array,
  offset: number,
  baseIndex: number,
  out: number[],
): void => {
  const header = readNodeHeader(tronBytes, offset);
  if (header.keyType !== KeyType.Arr) throw new Error("type");
  const nodeStart = offset + 8;
  const shift = tronBytes[nodeStart];
  const bitmap = readUint16LE(tronBytes, nodeStart + 2);
  if (header.kind === NodeKind.Leaf) {
    for (let slot = 0; slot < 16; slot++) {
      if (((bitmap >>> slot) & 1) === 0) continue;
      out.push(baseIndex + slot);
    }
    return;
  }
  let p = nodeStart + 8;
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
  if (header.keyType !== KeyType.Map) throw new Error("type");
  const nodeStart = offset + 8;
  if (header.kind === NodeKind.Leaf) {
    let p = nodeStart;
    for (let i = 0; i < header.entryCount; i++) {
      if (p >= tronBytes.length) throw new Error("tag");
      const tag = tronBytes[p];
      const typ = ((tag >>> 5) & 0x07) as ValueType;
      if (typ !== ValueType.Txt) throw new Error("type");
      const { length, headerSize } = readLength(tronBytes, p);
      const start = p + headerSize;
      const end = start + length;
      if (end > tronBytes.length) throw new Error("short");
      out.push(textDecoder.decode(tronBytes.subarray(start, end)));
      p = end;
      p += skipValueAt(tronBytes, p);
    }
    return;
  }
  const bitmap = readUint16LE(tronBytes, nodeStart);
  let p = nodeStart + 4;
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
  if (header.keyType !== KeyType.Arr) throw new Error("type");
  const nodeStart = offset + 8;
  const length = readUint32LE(state.root.tronBytes, nodeStart + 4);
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
        value = lookupArrayValueAt(
          state.root.tronBytes,
          offset,
          index,
          state.root,
          state.path,
          index,
        );
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
  if (tronType === "scalar") {
    if (tronBytes.length < 4) throw new Error("short");
    const tail = tronBytes.subarray(tronBytes.length - 4);
    if (
      tail[0] !== SCALAR_MAGIC[0] ||
      tail[1] !== SCALAR_MAGIC[1] ||
      tail[2] !== SCALAR_MAGIC[2] ||
      tail[3] !== SCALAR_MAGIC[3]
    ) {
      throw new Error("type");
    }
    const payload = tronBytes.subarray(0, tronBytes.length - 4);
    const root: RootState = { tronBytes, options: viewOptions, version: 0, proxyCache: new Map() };
    const [value, size] = decodeValueAt(payload, 0, root, null, null);
    if (size !== payload.length) throw new Error("extra");
    return value as TronProxy;
  }

  const rootState: RootState = {
    tronBytes,
    options: viewOptions,
    version: 0,
    proxyCache: new Map(),
  };

  const rootOffset = getRootOffset(tronBytes);
  const header = readNodeHeader(tronBytes, rootOffset);
  if (header.keyType === KeyType.Arr) {
    return getProxyForPath(rootState, "array", [], rootOffset);
  }
  if (header.keyType === KeyType.Map) {
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
