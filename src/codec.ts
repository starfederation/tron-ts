import { xxh32 } from "./xxh32";

export type TronValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | TronValue[]
  | { [key: string]: TronValue };

export type TronType = "scalar" | "tree";

export type ViewOptions = {
  i64?: "number" | "bigint" | "auto";
};

export type PathSegment = string | number;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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

enum NodeKind {
  Branch = 0,
  Leaf = 1,
}

type EncodedValue = {
  type: ValueType;
  bool?: boolean;
  i64?: bigint;
  f64?: number;
  bytes?: Uint8Array;
  offset?: number;
  node?: MapNode | ArrayNode;
};

type MapEntry = {
  key: Uint8Array;
  value: EncodedValue;
  hash: number;
};

type MapNode = {
  kind: NodeKind;
  bitmap: number;
  entries?: MapEntry[];
  children?: MapNode[];
};

type ArrayEntry = {
  index: number;
  value: EncodedValue;
};

type ArrayNode = {
  kind: NodeKind;
  shift: number;
  bitmap: number;
  length: number;
  values?: EncodedValue[];
  children?: ArrayNode[];
};

type ByteWriter = {
  buf: Uint8Array;
  length: number;
};

const ensureCapacity = (writer: ByteWriter, additional: number): void => {
  const required = writer.length + additional;
  if (required <= writer.buf.length) return;
  let nextCap = writer.buf.length === 0 ? 64 : writer.buf.length * 2;
  if (nextCap < required) nextCap = required;
  const next = new Uint8Array(nextCap);
  next.set(writer.buf.subarray(0, writer.length));
  writer.buf = next;
};

const writeUint16LE = (buf: Uint8Array, offset: number, value: number): void => {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
};

const writeUint32LE = (buf: Uint8Array, offset: number, value: number): void => {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
};

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

const lengthBytesU32 = (value: number): number => {
  if (value <= 0xff) return 1;
  if (value <= 0xffff) return 2;
  if (value <= 0xffffff) return 3;
  return 4;
};

const lengthBytesU64 = (length: number): number => {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("len");
  }
  const l = BigInt(length);
  if (l <= 0xffn) return 1;
  if (l <= 0xffffn) return 2;
  if (l <= 0xffffffn) return 3;
  if (l <= 0xffffffffn) return 4;
  if (l <= 0xffffffffffn) return 5;
  if (l <= 0xffffffffffffn) return 6;
  if (l <= 0xffffffffffffffn) return 7;
  if (l <= 0xffffffffffffffffn) return 8;
  throw new Error("len");
};

const computeNodeLen = (payloadLen: number): { nodeLen: number; lenBytes: number } => {
  if (payloadLen < 0) throw new Error("len");
  let lenBytes = 1;
  while (true) {
    const nodeLen = 1 + lenBytes + payloadLen;
    if (nodeLen > 0xffffffff) throw new Error("len");
    const needed = lengthBytesU32(nodeLen);
    if (needed === lenBytes) return { nodeLen, lenBytes };
    lenBytes = needed;
  }
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

const appendBytes = (builder: ByteWriter, size: number): number => {
  if (builder.length + size > 0xffffffff) throw new Error("len");
  ensureCapacity(builder, size);
  const offset = builder.length;
  builder.length += size;
  return offset;
};

const encodeBytesNode = (
  builder: ByteWriter,
  type: ValueType.Txt | ValueType.Bin,
  bytes: Uint8Array,
): number => {
  const length = bytes.length;
  if (length <= 15) {
    const offset = appendBytes(builder, 1 + length);
    builder.buf[offset] = ((length & 0x0f) << 4) | 0x08 | type;
    builder.buf.set(bytes, offset + 1);
    return offset;
  }
  const lenBytes = lengthBytesU64(length);
  const offset = appendBytes(builder, 1 + lenBytes + length);
  builder.buf[offset] = ((lenBytes & 0x0f) << 4) | type;
  let remaining = BigInt(length);
  for (let i = 0; i < lenBytes; i++) {
    builder.buf[offset + 1 + i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  builder.buf.set(bytes, offset + 1 + lenBytes);
  return offset;
};

const encodeValueNode = (builder: ByteWriter, value: EncodedValue): number => {
  if (value.offset !== undefined) return value.offset;
  switch (value.type) {
    case ValueType.Nil: {
      const offset = appendBytes(builder, 1);
      builder.buf[offset] = 0x00;
      value.offset = offset;
      return offset;
    }
    case ValueType.Bit: {
      const offset = appendBytes(builder, 1);
      builder.buf[offset] = (value.bool ? 0x08 : 0x00) | 0x01;
      value.offset = offset;
      return offset;
    }
    case ValueType.I64: {
      const offset = appendBytes(builder, 9);
      builder.buf[offset] = 0x02;
      new DataView(builder.buf.buffer, builder.buf.byteOffset + offset + 1, 8).setBigInt64(
        0,
        value.i64 ?? 0n,
        true,
      );
      value.offset = offset;
      return offset;
    }
    case ValueType.F64: {
      const offset = appendBytes(builder, 9);
      builder.buf[offset] = 0x03;
      new DataView(builder.buf.buffer, builder.buf.byteOffset + offset + 1, 8).setFloat64(
        0,
        value.f64 ?? 0,
        true,
      );
      value.offset = offset;
      return offset;
    }
    case ValueType.Txt:
    case ValueType.Bin: {
      const offset = encodeBytesNode(builder, value.type, value.bytes ?? new Uint8Array());
      value.offset = offset;
      return offset;
    }
    case ValueType.Arr: {
      if (!value.node) throw new Error("node");
      const offset = encodeArrayNode(builder, value.node as ArrayNode, true);
      value.offset = offset;
      return offset;
    }
    case ValueType.Map: {
      if (!value.node) throw new Error("node");
      const offset = encodeMapNode(builder, value.node as MapNode);
      value.offset = offset;
      return offset;
    }
    default:
      break;
  }
  throw new Error("type");
};

const encodeMapNode = (builder: ByteWriter, node: MapNode): number => {
  if (node.kind === NodeKind.Leaf) {
    const entries = node.entries ?? [];
    const keyOffsets: number[] = new Array(entries.length);
    const valueOffsets: number[] = new Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      keyOffsets[i] = encodeBytesNode(builder, ValueType.Txt, entries[i].key);
      valueOffsets[i] = encodeValueNode(builder, entries[i].value);
    }
    const payloadLen = entries.length * 8;
    const { nodeLen, lenBytes } = computeNodeLen(payloadLen);
    const tag = ValueType.Map | ((lenBytes - 1) << 4) | 0x08;
    const offset = appendBytes(builder, nodeLen);
    builder.buf[offset] = tag;
    for (let i = 0; i < lenBytes; i++) {
      builder.buf[offset + 1 + i] = (nodeLen >>> (8 * i)) & 0xff;
    }
    let p = offset + 1 + lenBytes;
    for (let i = 0; i < entries.length; i++) {
      writeUint32LE(builder.buf, p, keyOffsets[i]);
      writeUint32LE(builder.buf, p + 4, valueOffsets[i]);
      p += 8;
    }
    return offset;
  }

  const children = node.children ?? [];
  const childOffsets = children.map((child) => encodeMapNode(builder, child));
  const payloadLen = 4 + 4 * childOffsets.length;
  const { nodeLen, lenBytes } = computeNodeLen(payloadLen);
  const tag = ValueType.Map | ((lenBytes - 1) << 4);
  const offset = appendBytes(builder, nodeLen);
  builder.buf[offset] = tag;
  for (let i = 0; i < lenBytes; i++) {
    builder.buf[offset + 1 + i] = (nodeLen >>> (8 * i)) & 0xff;
  }
  const payloadStart = offset + 1 + lenBytes;
  writeUint32LE(builder.buf, payloadStart, node.bitmap >>> 0);
  let p = payloadStart + 4;
  for (const childOffset of childOffsets) {
    writeUint32LE(builder.buf, p, childOffset);
    p += 4;
  }
  return offset;
};

const encodeArrayNode = (builder: ByteWriter, node: ArrayNode, isRoot: boolean): number => {
  if (node.kind === NodeKind.Leaf) {
    const values = node.values ?? [];
    const valueOffsets = values.map((value) => encodeValueNode(builder, value));
    const payloadLen = 1 + 2 + (isRoot ? 4 : 0) + 4 * valueOffsets.length;
    const { nodeLen, lenBytes } = computeNodeLen(payloadLen);
    let tag = ValueType.Arr | ((lenBytes - 1) << 4) | 0x08;
    if (!isRoot) tag |= 0x40;
    const offset = appendBytes(builder, nodeLen);
    builder.buf[offset] = tag;
    for (let i = 0; i < lenBytes; i++) {
      builder.buf[offset + 1 + i] = (nodeLen >>> (8 * i)) & 0xff;
    }
    let p = offset + 1 + lenBytes;
    builder.buf[p] = node.shift & 0xff;
    p += 1;
    writeUint16LE(builder.buf, p, node.bitmap);
    p += 2;
    if (isRoot) {
      writeUint32LE(builder.buf, p, node.length >>> 0);
      p += 4;
    }
    for (const valueOffset of valueOffsets) {
      writeUint32LE(builder.buf, p, valueOffset);
      p += 4;
    }
    return offset;
  }

  const children = node.children ?? [];
  const childOffsets = children.map((child) => encodeArrayNode(builder, child, false));
  const payloadLen = 1 + 2 + (isRoot ? 4 : 0) + 4 * childOffsets.length;
  const { nodeLen, lenBytes } = computeNodeLen(payloadLen);
  let tag = ValueType.Arr | ((lenBytes - 1) << 4);
  if (!isRoot) tag |= 0x40;
  const offset = appendBytes(builder, nodeLen);
  builder.buf[offset] = tag;
  for (let i = 0; i < lenBytes; i++) {
    builder.buf[offset + 1 + i] = (nodeLen >>> (8 * i)) & 0xff;
  }
  let p = offset + 1 + lenBytes;
  builder.buf[p] = node.shift & 0xff;
  p += 1;
  writeUint16LE(builder.buf, p, node.bitmap);
  p += 2;
  if (isRoot) {
    writeUint32LE(builder.buf, p, node.length >>> 0);
    p += 4;
  }
  for (const childOffset of childOffsets) {
    writeUint32LE(builder.buf, p, childOffset);
    p += 4;
  }
  return offset;
};

const maxDepth32 = 7;

const buildMapNode = (entries: MapEntry[], depth: number): MapNode => {
  if (entries.length === 0) {
    return { kind: NodeKind.Leaf, bitmap: 0, entries: [] };
  }
  if (entries.length === 1) {
    return { kind: NodeKind.Leaf, bitmap: 0, entries };
  }
  if (depth >= maxDepth32) {
    const sorted = [...entries].sort((a, b) => {
      const len = Math.min(a.key.length, b.key.length);
      for (let i = 0; i < len; i++) {
        if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i] ? -1 : 1;
      }
      return a.key.length === b.key.length ? 0 : a.key.length < b.key.length ? -1 : 1;
    });
    return { kind: NodeKind.Leaf, bitmap: 0, entries: sorted };
  }

  const groups: MapEntry[][] = Array.from({ length: 16 }, () => []);
  for (const entry of entries) {
    const slot = (entry.hash >>> (depth * 4)) & 0x0f;
    groups[slot].push(entry);
  }

  const activeSlots = groups.reduce((count, group) => (group.length > 0 ? count + 1 : count), 0);
  if (activeSlots === 1) {
    const slot = groups.findIndex((group) => group.length > 0);
    const child = buildMapNode(groups[slot], depth + 1);
    return {
      kind: NodeKind.Branch,
      bitmap: 1 << slot,
      children: [child],
    };
  }

  const children: MapNode[] = [];
  let bitmap = 0;
  for (let slot = 0; slot < 16; slot++) {
    if (groups[slot].length === 0) continue;
    bitmap |= 1 << slot;
    children.push(buildMapNode(groups[slot], depth + 1));
  }

  return { kind: NodeKind.Branch, bitmap, children };
};

const buildArrayNode = (entries: ArrayEntry[], shift: number, length: number): ArrayNode => {
  if (entries.length === 0 && shift === 0) {
    return {
      kind: NodeKind.Leaf,
      shift: 0,
      bitmap: 0,
      length,
      values: [],
    };
  }

  if (shift === 0) {
    let bitmap = 0;
    const slotValues: EncodedValue[] = new Array(16);
    for (const entry of entries) {
      const slot = entry.index & 0x0f;
      bitmap |= 1 << slot;
      slotValues[slot] = entry.value;
    }
    let pop = bitmap & 0xffff;
    pop = pop - ((pop >>> 1) & 0x5555);
    pop = (pop & 0x3333) + ((pop >>> 2) & 0x3333);
    pop = (pop + (pop >>> 4)) & 0x0f0f;
    pop = pop + (pop >>> 8);
    const count = pop & 0x1f;
    const values: EncodedValue[] = new Array(count);
    let idx = 0;
    for (let slot = 0; slot < 16; slot++) {
      if (((bitmap >>> slot) & 1) === 0) continue;
      values[idx] = slotValues[slot];
      idx++;
    }
    return { kind: NodeKind.Leaf, shift: 0, bitmap, length, values };
  }

  const groups: ArrayEntry[][] = Array.from({ length: 16 }, () => []);
  for (const entry of entries) {
    const slot = (entry.index >>> shift) & 0x0f;
    groups[slot].push(entry);
  }

  const children: ArrayNode[] = [];
  let bitmap = 0;
  for (let slot = 0; slot < 16; slot++) {
    if (groups[slot].length === 0) continue;
    bitmap |= 1 << slot;
    children.push(buildArrayNode(groups[slot], shift - 4, 0));
  }

  return { kind: NodeKind.Branch, shift, bitmap, length, children };
};

const valueFromAny = (value: TronValue): EncodedValue => {
  if (value === null) return { type: ValueType.Nil };
  if (typeof value === "boolean") return { type: ValueType.Bit, bool: value };
  if (typeof value === "string") {
    return { type: ValueType.Txt, bytes: textEncoder.encode(value) };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("num");
    }
    if (Number.isSafeInteger(value)) {
      const asBigInt = BigInt(value);
      if (asBigInt >= -(1n << 63n) && asBigInt <= (1n << 63n) - 1n) {
        return { type: ValueType.I64, i64: asBigInt };
      }
    }
    return { type: ValueType.F64, f64: value };
  }
  if (typeof value === "bigint") {
    if (value < -(1n << 63n) || value > (1n << 63n) - 1n) {
      throw new Error("range");
    }
    return { type: ValueType.I64, i64: value };
  }
  if (value instanceof Uint8Array) {
    return { type: ValueType.Bin, bytes: value };
  }
  if (Array.isArray(value)) {
    const entries: ArrayEntry[] = value.map((entry, index) => ({
      index,
      value: valueFromAny(entry),
    }));
    const length = value.length;
    let shift = 0;
    if (length > 0) {
      let maxIndex = length - 1;
      while ((maxIndex >>> shift) > 0x0f) {
        shift += 4;
      }
    }
    const root = buildArrayNode(entries, shift, length);
    return { type: ValueType.Arr, node: root };
  }
  if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("type");
    }
    const keys = Object.keys(value);
    if (keys.length === 0) {
      const root: MapNode = { kind: NodeKind.Leaf, bitmap: 0, entries: [] };
      return { type: ValueType.Map, node: root };
    }
    const entries: MapEntry[] = [];
    for (const key of keys) {
      const val = valueFromAny(value[key]);
      const keyBytes = textEncoder.encode(key);
      entries.push({ key: keyBytes, value: val, hash: xxh32(keyBytes, 0) });
    }
    const root = buildMapNode(entries, 0);
    return { type: ValueType.Map, node: root };
  }

  throw new Error("type");
};

const readRootOffset = (tronBytes: Uint8Array): number => {
  if (tronBytes.length < HEADER_SIZE + FOOTER_SIZE) throw new Error("short");
  for (let i = 0; i < MAGIC.length; i++) {
    if (tronBytes[i] !== MAGIC[i]) throw new Error("magic");
  }
  const footerStart = tronBytes.length - FOOTER_SIZE;
  const rootOffset = readUint32LE(tronBytes, footerStart);
  if (rootOffset < HEADER_SIZE || rootOffset >= footerStart) throw new Error("off");
  return rootOffset;
};

const createEmptyContainer = (builder: ByteWriter, type: ValueType.Arr | ValueType.Map): number => {
  if (type === ValueType.Arr) {
    const node: ArrayNode = {
      kind: NodeKind.Leaf,
      shift: 0,
      bitmap: 0,
      length: 0,
      values: [],
    };
    return encodeArrayNode(builder, node, true);
  }
  const node: MapNode = { kind: NodeKind.Leaf, bitmap: 0, entries: [] };
  return encodeMapNode(builder, node);
};

const appendMapBranchNode = (
  builder: ByteWriter,
  bitmap: number,
  childOffsets: number[],
): number => {
  const payloadLen = 4 + 4 * childOffsets.length;
  const { nodeLen, lenBytes } = computeNodeLen(payloadLen);
  const tag = ValueType.Map | ((lenBytes - 1) << 4);
  const offset = appendBytes(builder, nodeLen);
  builder.buf[offset] = tag;
  for (let i = 0; i < lenBytes; i++) {
    builder.buf[offset + 1 + i] = (nodeLen >>> (8 * i)) & 0xff;
  }
  const payloadStart = offset + 1 + lenBytes;
  writeUint32LE(builder.buf, payloadStart, bitmap >>> 0);
  let p = payloadStart + 4;
  for (const childOffset of childOffsets) {
    writeUint32LE(builder.buf, p, childOffset);
    p += 4;
  }
  return offset;
};

const appendArrayBranchNode = (
  builder: ByteWriter,
  shift: number,
  bitmap: number,
  length: number,
  isRoot: boolean,
  childOffsets: number[],
): number => {
  const payloadLen = 1 + 2 + (isRoot ? 4 : 0) + 4 * childOffsets.length;
  const { nodeLen, lenBytes } = computeNodeLen(payloadLen);
  let tag = ValueType.Arr | ((lenBytes - 1) << 4);
  if (!isRoot) tag |= 0x40;
  const offset = appendBytes(builder, nodeLen);
  builder.buf[offset] = tag;
  for (let i = 0; i < lenBytes; i++) {
    builder.buf[offset + 1 + i] = (nodeLen >>> (8 * i)) & 0xff;
  }
  let p = offset + 1 + lenBytes;
  builder.buf[p] = shift & 0xff;
  p += 1;
  writeUint16LE(builder.buf, p, bitmap);
  p += 2;
  if (isRoot) {
    writeUint32LE(builder.buf, p, length >>> 0);
    p += 4;
  }
  for (const childOffset of childOffsets) {
    writeUint32LE(builder.buf, p, childOffset);
    p += 4;
  }
  return offset;
};

const setPathAt = (
  builder: ByteWriter,
  offset: number,
  path: PathSegment[],
  value: TronValue,
): number => {
  if (path.length === 0) {
    const encoded = valueFromAny(value);
    return encodeValueNode(builder, encoded);
  }
  const tronBytes = builder.buf.subarray(0, builder.length);
  const type = readValueTypeAt(tronBytes, offset);
  if (type === ValueType.Map) {
    const key = path[0];
    if (typeof key !== "string") throw new Error("path");
    const keyBytes = textEncoder.encode(key);
    const hash = xxh32(keyBytes, 0);
    return setMapPath(builder, offset, keyBytes, hash, path.slice(1), value, 0);
  }
  if (type === ValueType.Arr) {
    const index = path[0];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      throw new Error("path");
    }
    return setArrayPath(builder, offset, index, path.slice(1), value);
  }
  throw new Error("path");
};

const setMapPath = (
  builder: ByteWriter,
  offset: number,
  keyBytes: Uint8Array,
  hash: number,
  restPath: PathSegment[],
  value: TronValue,
  depth: number,
): number => {
  if (depth > maxDepth32) throw new Error("depth");
  const tronBytes = builder.buf.subarray(0, builder.length);
  const header = readNodeHeader(tronBytes, offset);
  if (header.type !== ValueType.Map) throw new Error("type");
  const payloadStart = offset + header.headerSize;

  if (header.isLeaf) {
    const payloadLen = header.nodeLen - header.headerSize;
    if (payloadLen % 8 !== 0) throw new Error("len");
    const entryCount = payloadLen / 8;
    const entries: MapEntry[] = new Array(entryCount);
    let foundIndex = -1;
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = payloadStart + i * 8;
      const keyOffset = readUint32LE(tronBytes, entryOffset);
      const valueOffset = readUint32LE(tronBytes, entryOffset + 4);
      const existingKeyBytes = readTxtBytesAt(tronBytes, keyOffset);
      if (bytesEqual(existingKeyBytes, keyBytes)) foundIndex = i;
      entries[i] = {
        key: existingKeyBytes,
        value: { type: readValueTypeAt(tronBytes, valueOffset), offset: valueOffset },
        hash: xxh32(existingKeyBytes, 0),
      };
    }

    let nextValue: EncodedValue;
    if (restPath.length === 0) {
      nextValue = valueFromAny(value);
    } else {
      const nextSegment = restPath[0];
      const containerType =
        typeof nextSegment === "number" ? ValueType.Arr : ValueType.Map;
      let childOffset: number;
      if (
        foundIndex >= 0 &&
        entries[foundIndex].value.type === containerType &&
        entries[foundIndex].value.offset !== undefined
      ) {
        childOffset = entries[foundIndex].value.offset ?? 0;
      } else {
        childOffset = createEmptyContainer(builder, containerType);
      }
      const updatedChild = setPathAt(builder, childOffset, restPath, value);
      nextValue = { type: containerType, offset: updatedChild };
    }

    if (foundIndex >= 0) {
      entries[foundIndex] = {
        key: entries[foundIndex].key,
        value: nextValue,
        hash: entries[foundIndex].hash,
      };
    } else {
      entries.push({ key: keyBytes, value: nextValue, hash });
    }

    const newNode = buildMapNode(entries, depth);
    return encodeMapNode(builder, newNode);
  }

  const bitmap = readUint32LE(tronBytes, payloadStart);
  const slot = (hash >>> (depth * 4)) & 0x0f;
  const mask = (1 << slot) - 1;
  const idx = popcount16(bitmap & mask);
  const hasChild = ((bitmap >>> slot) & 1) === 1;
  const children: number[] = [];
  let p = payloadStart + 4;
  for (let slotIndex = 0; slotIndex < 16; slotIndex++) {
    if (((bitmap >>> slotIndex) & 1) === 0) continue;
    children.push(readUint32LE(tronBytes, p));
    p += 4;
  }

  if (hasChild) {
    const childOffset = children[idx];
    const newChild = setMapPath(builder, childOffset, keyBytes, hash, restPath, value, depth + 1);
    children[idx] = newChild;
    return appendMapBranchNode(builder, bitmap, children);
  }

  let childValue: EncodedValue;
  if (restPath.length === 0) {
    childValue = valueFromAny(value);
  } else {
    const nextSegment = restPath[0];
    const containerType = typeof nextSegment === "number" ? ValueType.Arr : ValueType.Map;
    const childOffset = createEmptyContainer(builder, containerType);
    const updatedChild = setPathAt(builder, childOffset, restPath, value);
    childValue = { type: containerType, offset: updatedChild };
  }
  const newChildNode = buildMapNode([{ key: keyBytes, value: childValue, hash }], depth + 1);
  const newChildOffset = encodeMapNode(builder, newChildNode);
  const newBitmap = bitmap | (1 << slot);
  const newChildren = [...children.slice(0, idx), newChildOffset, ...children.slice(idx)];
  return appendMapBranchNode(builder, newBitmap, newChildren);
};

const setArrayPath = (
  builder: ByteWriter,
  offset: number,
  index: number,
  restPath: PathSegment[],
  value: TronValue,
): number => {
  const tronBytes = builder.buf.subarray(0, builder.length);
  const header = readNodeHeader(tronBytes, offset);
  if (header.type !== ValueType.Arr) throw new Error("type");
  const payloadStart = offset + header.headerSize;
  const shift = tronBytes[payloadStart];
  const bitmap = readUint16LE(tronBytes, payloadStart + 1);
  const length = header.isRoot ? readUint32LE(tronBytes, payloadStart + 3) : 0;
  const nextLength = header.isRoot ? Math.max(length, index + 1) : 0;
  const addressesStart = payloadStart + 3 + (header.isRoot ? 4 : 0);

  if (header.isLeaf) {
    const slotValues: Array<EncodedValue | undefined> = new Array(16);
    let p = addressesStart;
    for (let slot = 0; slot < 16; slot++) {
      if (((bitmap >>> slot) & 1) === 0) continue;
      const valueOffset = readUint32LE(tronBytes, p);
      p += 4;
      slotValues[slot] = { type: readValueTypeAt(tronBytes, valueOffset), offset: valueOffset };
    }

    let nextValue: EncodedValue;
    if (restPath.length === 0) {
      nextValue = valueFromAny(value);
    } else {
      const nextSegment = restPath[0];
      const containerType = typeof nextSegment === "number" ? ValueType.Arr : ValueType.Map;
      let childOffset = 0;
      const existing = slotValues[index & 0x0f];
      if (existing && existing.type === containerType && existing.offset !== undefined) {
        childOffset = existing.offset ?? 0;
      } else {
        childOffset = createEmptyContainer(builder, containerType);
      }
      const updatedChild = setPathAt(builder, childOffset, restPath, value);
      nextValue = { type: containerType, offset: updatedChild };
    }

    const slot = index & 0x0f;
    slotValues[slot] = nextValue;
    const newBitmap = bitmap | (1 << slot);
    const values: EncodedValue[] = [];
    for (let slotIndex = 0; slotIndex < 16; slotIndex++) {
      if (((newBitmap >>> slotIndex) & 1) === 0) continue;
      const entry = slotValues[slotIndex];
      if (!entry) throw new Error("slot");
      values.push(entry);
    }
    const node: ArrayNode = {
      kind: NodeKind.Leaf,
      shift,
      bitmap: newBitmap,
      length: header.isRoot ? nextLength : 0,
      values,
    };
    return encodeArrayNode(builder, node, header.isRoot);
  }

  const slot = (index >>> shift) & 0x0f;
  const mask = (1 << slot) - 1;
  const idx = popcount16(bitmap & mask);
  const hasChild = ((bitmap >>> slot) & 1) === 1;
  const children: number[] = [];
  let p = addressesStart;
  for (let slotIndex = 0; slotIndex < 16; slotIndex++) {
    if (((bitmap >>> slotIndex) & 1) === 0) continue;
    children.push(readUint32LE(tronBytes, p));
    p += 4;
  }

  if (hasChild) {
    const childOffset = children[idx];
    const newChild = setArrayPath(builder, childOffset, index, restPath, value);
    children[idx] = newChild;
    return appendArrayBranchNode(builder, shift, bitmap, nextLength, header.isRoot, children);
  }

  let childValue: EncodedValue;
  if (restPath.length === 0) {
    childValue = valueFromAny(value);
  } else {
    const nextSegment = restPath[0];
    const containerType = typeof nextSegment === "number" ? ValueType.Arr : ValueType.Map;
    const childOffset = createEmptyContainer(builder, containerType);
    const updatedChild = setPathAt(builder, childOffset, restPath, value);
    childValue = { type: containerType, offset: updatedChild };
  }
  const entry: ArrayEntry = { index, value: childValue };
  const newChildNode = buildArrayNode([entry], shift - 4, 0);
  const newChildOffset = encodeArrayNode(builder, newChildNode, false);
  const newBitmap = bitmap | (1 << slot);
  const newChildren = [...children.slice(0, idx), newChildOffset, ...children.slice(idx)];
  return appendArrayBranchNode(builder, shift, newBitmap, nextLength, header.isRoot, newChildren);
};

export const encode = (value: TronValue): Uint8Array => {
  const builder: ByteWriter = { buf: new Uint8Array(HEADER_SIZE), length: HEADER_SIZE };
  builder.buf.set(MAGIC, 0);
  const root = valueFromAny(value);
  const rootOffset = encodeValueNode(builder, root);
  const footerOffset = appendBytes(builder, FOOTER_SIZE);
  writeUint32LE(builder.buf, footerOffset, rootOffset);
  writeUint32LE(builder.buf, footerOffset + 4, 0);
  return builder.buf.slice(0, builder.length);
};

export const detectType = (tronBytes: Uint8Array): TronType => {
  const rootOffset = readRootOffset(tronBytes);
  const type = readValueTypeAt(tronBytes, rootOffset);
  return type === ValueType.Arr || type === ValueType.Map ? "tree" : "scalar";
};

export const setPath = (
  tronBytes: Uint8Array,
  path: PathSegment[],
  value: TronValue,
): Uint8Array => {
  const rootOffset = readRootOffset(tronBytes);
  const builder: ByteWriter = { buf: tronBytes.slice(), length: tronBytes.length };
  const newRoot = path.length === 0 ? encodeValueNode(builder, valueFromAny(value)) : setPathAt(builder, rootOffset, path, value);
  const footerOffset = appendBytes(builder, FOOTER_SIZE);
  writeUint32LE(builder.buf, footerOffset, newRoot);
  writeUint32LE(builder.buf, footerOffset + 4, rootOffset);
  return builder.buf.slice(0, builder.length);
};

export const vacuum = (tronBytes: Uint8Array): Uint8Array => {
  const rootOffset = readRootOffset(tronBytes);
  const builder: ByteWriter = { buf: new Uint8Array(HEADER_SIZE), length: HEADER_SIZE };
  builder.buf.set(MAGIC, 0);
  const offsets = new Map<number, number>();
  type Patch = { pos: number; value: number };

  const copyNode = (offset: number): number => {
    const cached = offsets.get(offset);
    if (cached !== undefined) return cached;
    if (offset >= tronBytes.length) throw new Error("short");
    const tag = tronBytes[offset];
    const type = (tag & 0x07) as ValueType;
    let nodeLen = 0;
    let patches: Patch[] = [];

    if (type === ValueType.Arr || type === ValueType.Map) {
      const header = readNodeHeader(tronBytes, offset);
      nodeLen = header.nodeLen;
      const payloadStart = offset + header.headerSize;

      if (type === ValueType.Arr) {
        const bitmap = readUint16LE(tronBytes, payloadStart + 1);
        const addressesStart = payloadStart + 3 + (header.isRoot ? 4 : 0);
        const entryCount = popcount16(bitmap);
        for (let i = 0; i < entryCount; i++) {
          const addrPos = addressesStart + i * 4;
          const childOffset = readUint32LE(tronBytes, addrPos);
          const newChild = copyNode(childOffset);
          patches.push({ pos: addrPos - offset, value: newChild });
        }
      } else {
        if (header.isLeaf) {
          const payloadLen = header.nodeLen - header.headerSize;
          if (payloadLen % 8 !== 0) throw new Error("len");
          const entryCount = payloadLen / 8;
          for (let i = 0; i < entryCount; i++) {
            const entryPos = payloadStart + i * 8;
            const keyOffset = readUint32LE(tronBytes, entryPos);
            const valueOffset = readUint32LE(tronBytes, entryPos + 4);
            const newKey = copyNode(keyOffset);
            const newValue = copyNode(valueOffset);
            patches.push({ pos: entryPos - offset, value: newKey });
            patches.push({ pos: entryPos + 4 - offset, value: newValue });
          }
        } else {
          const bitmap = readUint32LE(tronBytes, payloadStart);
          const entryCount = popcount16(bitmap);
          for (let i = 0; i < entryCount; i++) {
            const addrPos = payloadStart + 4 + i * 4;
            const childOffset = readUint32LE(tronBytes, addrPos);
            const newChild = copyNode(childOffset);
            patches.push({ pos: addrPos - offset, value: newChild });
          }
        }
      }
    } else {
      if (type === ValueType.Nil || type === ValueType.Bit) {
        nodeLen = 1;
      } else if (type === ValueType.I64 || type === ValueType.F64) {
        nodeLen = 9;
      } else if (type === ValueType.Txt || type === ValueType.Bin) {
        const { length, headerSize } = readBytesLength(tronBytes, offset);
        nodeLen = headerSize + length;
      } else {
        throw new Error("type");
      }
    }

    if (offset + nodeLen > tronBytes.length) throw new Error("short");
    const newOffset = appendBytes(builder, nodeLen);
    builder.buf.set(tronBytes.subarray(offset, offset + nodeLen), newOffset);
    for (const patch of patches) {
      const at = newOffset + patch.pos;
      const value = patch.value >>> 0;
      builder.buf[at] = value & 0xff;
      builder.buf[at + 1] = (value >>> 8) & 0xff;
      builder.buf[at + 2] = (value >>> 16) & 0xff;
      builder.buf[at + 3] = (value >>> 24) & 0xff;
    }
    offsets.set(offset, newOffset);
    return newOffset;
  };

  const newRootOffset = copyNode(rootOffset);
  const footerOffset = appendBytes(builder, FOOTER_SIZE);
  writeUint32LE(builder.buf, footerOffset, newRootOffset);
  writeUint32LE(builder.buf, footerOffset + 4, 0);
  return builder.buf.slice(0, builder.length);
};

export const canonical = (tronBytes: Uint8Array): Uint8Array => {
  const rootOffset = readRootOffset(tronBytes);

  const decodeValueAt = (offset: number): TronValue => {
    if (offset >= tronBytes.length) throw new Error("tag");
    const tag = tronBytes[offset];
    const type = (tag & 0x07) as ValueType;
    switch (type) {
      case ValueType.Nil:
        return null;
      case ValueType.Bit:
        return (tag & 0x08) !== 0;
      case ValueType.I64: {
        if (offset + 9 > tronBytes.length) throw new Error("short");
        const i64 = new DataView(
          tronBytes.buffer,
          tronBytes.byteOffset + offset + 1,
          8,
        ).getBigInt64(0, true);
        if (i64 < Number.MIN_SAFE_INTEGER || i64 > Number.MAX_SAFE_INTEGER) return i64;
        return Number(i64);
      }
      case ValueType.F64: {
        if (offset + 9 > tronBytes.length) throw new Error("short");
        const f64 = new DataView(
          tronBytes.buffer,
          tronBytes.byteOffset + offset + 1,
          8,
        ).getFloat64(0, true);
        if (!Number.isFinite(f64)) throw new Error("num");
        return f64;
      }
      case ValueType.Txt:
      case ValueType.Bin: {
        const { length, headerSize } = readBytesLength(tronBytes, offset);
        const start = offset + headerSize;
        const end = start + length;
        if (end > tronBytes.length) throw new Error("short");
        const payload = tronBytes.subarray(start, end);
        if (type === ValueType.Txt) return textDecoder.decode(payload);
        return payload.slice();
      }
      case ValueType.Arr:
        return decodeArrayAt(offset);
      case ValueType.Map:
        return decodeMapAt(offset);
      default:
        break;
    }
    throw new Error("type");
  };

  const decodeArrayAt = (offset: number): TronValue[] => {
    const header = readNodeHeader(tronBytes, offset);
    if (header.type !== ValueType.Arr || !header.isRoot) throw new Error("type");
    const payloadStart = offset + header.headerSize;
    const length = readUint32LE(tronBytes, payloadStart + 3);
    const values = new Map<number, TronValue>();

    const walk = (nodeOffset: number, baseIndex: number): void => {
      const nodeHeader = readNodeHeader(tronBytes, nodeOffset);
      if (nodeHeader.type !== ValueType.Arr) throw new Error("type");
      const start = nodeOffset + nodeHeader.headerSize;
      const nodeShift = tronBytes[start];
      const nodeBitmap = readUint16LE(tronBytes, start + 1);
      const addressesStart = start + 3 + (nodeHeader.isRoot ? 4 : 0);
      if (nodeHeader.isLeaf) {
        let p = addressesStart;
        for (let slot = 0; slot < 16; slot++) {
          if (((nodeBitmap >>> slot) & 1) === 0) continue;
          const valueOffset = readUint32LE(tronBytes, p);
          p += 4;
          values.set(baseIndex + slot, decodeValueAt(valueOffset));
        }
        return;
      }
      let p = addressesStart;
      for (let slot = 0; slot < 16; slot++) {
        if (((nodeBitmap >>> slot) & 1) === 0) continue;
        const childOffset = readUint32LE(tronBytes, p);
        p += 4;
        const childBase = baseIndex + slot * (1 << nodeShift);
        walk(childOffset, childBase);
      }
    };

    walk(offset, 0);
    for (const index of values.keys()) {
      if (index >= length) throw new Error("len");
    }
    const out: TronValue[] = new Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = values.get(i) ?? null;
    }
    return out;
  };

  const decodeMapAt = (offset: number): { [key: string]: TronValue } => {
    const out: { [key: string]: TronValue } = {};
    const walk = (nodeOffset: number): void => {
      const header = readNodeHeader(tronBytes, nodeOffset);
      if (header.type !== ValueType.Map) throw new Error("type");
      const payloadStart = nodeOffset + header.headerSize;
      if (header.isLeaf) {
        const payloadLen = header.nodeLen - header.headerSize;
        if (payloadLen % 8 !== 0) throw new Error("len");
        const entryCount = payloadLen / 8;
        for (let i = 0; i < entryCount; i++) {
          const entryPos = payloadStart + i * 8;
          const keyOffset = readUint32LE(tronBytes, entryPos);
          const valueOffset = readUint32LE(tronBytes, entryPos + 4);
          const keyBytes = readTxtBytesAt(tronBytes, keyOffset);
          const key = textDecoder.decode(keyBytes);
          out[key] = decodeValueAt(valueOffset);
        }
        return;
      }
      const bitmap = readUint32LE(tronBytes, payloadStart);
      let p = payloadStart + 4;
      for (let slot = 0; slot < 16; slot++) {
        if (((bitmap >>> slot) & 1) === 0) continue;
        const childOffset = readUint32LE(tronBytes, p);
        p += 4;
        walk(childOffset);
      }
    };
    walk(offset);
    return out;
  };

  const value = decodeValueAt(rootOffset);
  return encode(value);
};
