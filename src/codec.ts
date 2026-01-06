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

const TRAILER_MAGIC = [0x54, 0x52, 0x4f, 0x4e]; // TRON
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

const TAG_NIL = 0x00;
const TAG_BIT_FALSE = 0x20;
const TAG_BIT_TRUE = 0x21;
const TAG_I64 = 0x40;
const TAG_F64 = 0x60;

enum NodeKind {
  Branch = 0,
  Leaf = 1,
}

enum KeyType {
  Arr = 0,
  Map = 1,
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

const lengthBytes = (length: number): number => {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("len");
  }
  if (length <= 15) return 0;
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

const writeLength = (
  buf: Uint8Array,
  offset: number,
  prefix: number,
  length: number,
): number => {
  const n = lengthBytes(length);
  if (n === 0) {
    buf[offset] = (prefix | 0x10 | length) & 0xff;
    return 1;
  }
  buf[offset] = (prefix | (n & 0x0f)) & 0xff;
  let remaining = BigInt(length);
  for (let i = 0; i < n; i++) {
    buf[offset + 1 + i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return 1 + n;
};

const offsetLength = (offset: number): number => {
  if (offset <= 0xff) return 1;
  if (offset <= 0xffff) return 2;
  if (offset <= 0xffffff) return 3;
  return 4;
};

const encodedBytesValueLen = (payloadLength: number): number =>
  1 + lengthBytes(payloadLength) + payloadLength;

const encodedValueLen = (value: EncodedValue): number => {
  switch (value.type) {
    case ValueType.Nil:
    case ValueType.Bit:
      return 1;
    case ValueType.I64:
    case ValueType.F64:
      return 9;
    case ValueType.Txt:
    case ValueType.Bin:
      return encodedBytesValueLen(value.bytes?.length ?? 0);
    case ValueType.Arr:
    case ValueType.Map:
      return 1 + offsetLength(value.offset ?? 0);
    default:
      throw new Error("type");
  }
};

const writeBytesValue = (
  buf: Uint8Array,
  offset: number,
  type: ValueType,
  payload: Uint8Array,
): number => {
  const prefix = (type << 5) & 0xe0;
  const n = writeLength(buf, offset, prefix, payload.length);
  buf.set(payload, offset + n);
  return n + payload.length;
};

const writeValue = (buf: Uint8Array, offset: number, value: EncodedValue): number => {
  switch (value.type) {
    case ValueType.Nil:
      buf[offset] = TAG_NIL;
      return 1;
    case ValueType.Bit:
      buf[offset] = value.bool ? TAG_BIT_TRUE : TAG_BIT_FALSE;
      return 1;
    case ValueType.I64:
      buf[offset] = TAG_I64;
      new DataView(buf.buffer, buf.byteOffset + offset + 1, 8).setBigInt64(
        0,
        value.i64 ?? 0n,
        true,
      );
      return 9;
    case ValueType.F64:
      buf[offset] = TAG_F64;
      new DataView(buf.buffer, buf.byteOffset + offset + 1, 8).setFloat64(
        0,
        value.f64 ?? 0,
        true,
      );
      return 9;
    case ValueType.Txt:
    case ValueType.Bin:
      return writeBytesValue(buf, offset, value.type, value.bytes ?? new Uint8Array());
    case ValueType.Arr:
    case ValueType.Map: {
      const valueOffset = value.offset ?? 0;
      const len = offsetLength(valueOffset);
      const prefix = (value.type << 5) & 0xe0;
      const n = writeLength(buf, offset, prefix, len);
      buf[offset + n] = valueOffset & 0xff;
      if (len > 1) buf[offset + n + 1] = (valueOffset >>> 8) & 0xff;
      if (len > 2) buf[offset + n + 2] = (valueOffset >>> 16) & 0xff;
      if (len > 3) buf[offset + n + 3] = (valueOffset >>> 24) & 0xff;
      return n + len;
    }
    default:
      throw new Error("type");
  }
};

const appendNodeWithBodyLen = (
  builder: ByteWriter,
  kind: NodeKind,
  key: KeyType,
  entryCount: number,
  bodyLen: number,
): { body: Uint8Array; offset: number } => {
  if (bodyLen < 0) throw new Error("len");
  let nodeLen = 8 + bodyLen;
  const pad = (4 - (nodeLen % 4)) % 4;
  nodeLen += pad;
  if (nodeLen > 0xffffffff) throw new Error("len");
  if (builder.length + nodeLen > 0xffffffff) throw new Error("len");
  ensureCapacity(builder, nodeLen);
  const offset = builder.length;
  builder.length += nodeLen;
  const node = builder.buf.subarray(offset, offset + nodeLen);
  const flags = (nodeLen | (kind & 0x1) | ((key & 0x1) << 1)) >>> 0;
  writeUint32LE(node, 0, flags);
  writeUint32LE(node, 4, entryCount >>> 0);
  if (pad !== 0) {
    node.fill(0, 8 + bodyLen, nodeLen);
  }
  return { body: node.subarray(8, 8 + bodyLen), offset };
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

const resolveValueOffset = (builder: ByteWriter, value: EncodedValue): void => {
  if (value.type !== ValueType.Arr && value.type !== ValueType.Map) return;
  if (value.offset !== undefined) return;
  if (!value.node) throw new Error("node");
  value.offset =
    value.type === ValueType.Arr
      ? encodeArrayNode(builder, value.node as ArrayNode)
      : encodeMapNode(builder, value.node as MapNode);
};

const encodeMapNode = (builder: ByteWriter, node: MapNode): number => {
  if (node.kind === NodeKind.Leaf) {
    const entries = node.entries ?? [];
    let bodyLen = 0;
    for (const entry of entries) {
      resolveValueOffset(builder, entry.value);
      bodyLen += encodedBytesValueLen(entry.key.length) + encodedValueLen(entry.value);
    }
    const { body, offset } = appendNodeWithBodyLen(
      builder,
      NodeKind.Leaf,
      KeyType.Map,
      entries.length,
      bodyLen,
    );
    let p = 0;
    for (const entry of entries) {
      p += writeBytesValue(body, p, ValueType.Txt, entry.key);
      p += writeValue(body, p, entry.value);
    }
    return offset;
  }

  const children = node.children ?? [];
  const childOffsets = children.map((child) => encodeMapNode(builder, child));
  const bodyLen = 4 + 4 * childOffsets.length;
  const { body, offset } = appendNodeWithBodyLen(
    builder,
    NodeKind.Branch,
    KeyType.Map,
    childOffsets.length,
    bodyLen,
  );
  writeUint16LE(body, 0, node.bitmap);
  body[2] = 0;
  body[3] = 0;
  let p = 4;
  for (const childOffset of childOffsets) {
    writeUint32LE(body, p, childOffset);
    p += 4;
  }
  return offset;
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

const encodeArrayNode = (builder: ByteWriter, node: ArrayNode): number => {
  if (node.kind === NodeKind.Leaf) {
    const values = node.values ?? [];
    let bodyLen = 8;
    for (const value of values) {
      resolveValueOffset(builder, value);
      bodyLen += encodedValueLen(value);
    }
    const { body, offset } = appendNodeWithBodyLen(
      builder,
      NodeKind.Leaf,
      KeyType.Arr,
      values.length,
      bodyLen,
    );
    body[0] = node.shift;
    body[1] = 0;
    writeUint16LE(body, 2, node.bitmap);
    writeUint32LE(body, 4, node.length >>> 0);
    let p = 8;
    for (const value of values) {
      p += writeValue(body, p, value);
    }
    return offset;
  }

  const children = node.children ?? [];
  const childOffsets = children.map((child) => encodeArrayNode(builder, child));
  const bodyLen = 8 + 4 * childOffsets.length;
  const { body, offset } = appendNodeWithBodyLen(
    builder,
    NodeKind.Branch,
    KeyType.Arr,
    childOffsets.length,
    bodyLen,
  );
  body[0] = node.shift;
  body[1] = 0;
  writeUint16LE(body, 2, node.bitmap);
  writeUint32LE(body, 4, node.length >>> 0);
  let p = 8;
  for (const childOffset of childOffsets) {
    writeUint32LE(body, p, childOffset);
    p += 4;
  }
  return offset;
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
      const root: MapNode = { kind: NodeKind.Leaf, bitmap: 0, entries: [], bodyLen: 0 };
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

export const encode = (value: TronValue): Uint8Array => {
  const builder: ByteWriter = { buf: new Uint8Array(0), length: 0 };
  const root = valueFromAny(value);
  if (root.type === ValueType.Arr || root.type === ValueType.Map) {
    resolveValueOffset(builder, root);
    const trailer = new Uint8Array(TRAILER_SIZE);
    writeUint32LE(trailer, 0, root.offset ?? 0);
    writeUint32LE(trailer, 4, 0);
    trailer.set(TRAILER_MAGIC, 8);
    ensureCapacity(builder, trailer.length);
    builder.buf.set(trailer, builder.length);
    builder.length += trailer.length;
    return builder.buf.slice(0, builder.length);
  }

  const encoded = new Uint8Array(encodedValueLen(root));
  writeValue(encoded, 0, root);
  const out = new Uint8Array(encoded.length + 4);
  out.set(encoded, 0);
  out.set(SCALAR_MAGIC, encoded.length);
  return out;
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

const popcount16 = (value: number): number => {
  let v = value & 0xffff;
  v = v - ((v >>> 1) & 0x5555);
  v = (v & 0x3333) + ((v >>> 2) & 0x3333);
  v = (v + (v >>> 4)) & 0x0f0f;
  v = v + (v >>> 8);
  return v & 0x1f;
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
      const i64 = new DataView(tronBytes.buffer, tronBytes.byteOffset + offset + 1, 8).getBigInt64(
        0,
        true,
      );
      return [{ type: ValueType.I64, i64 }, 9];
    }
    case ValueType.F64: {
      if (offset + 9 > tronBytes.length) throw new Error("short");
      const f64 = new DataView(tronBytes.buffer, tronBytes.byteOffset + offset + 1, 8).getFloat64(
        0,
        true,
      );
      return [{ type: ValueType.F64, f64 }, 9];
    }
    case ValueType.Txt:
    case ValueType.Bin:
    case ValueType.Arr:
    case ValueType.Map: {
      const tag = tronBytes[offset];
      if ((tag & 0x10) !== 0) {
        const length = tag & 0x0f;
        const headerSize = 1;
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
      const n = tag & 0x0f;
      if (n < 1 || n > 8) throw new Error("len");
      if (offset + 1 + n > tronBytes.length) throw new Error("short");
      let length = 0;
      for (let i = 0; i < n; i++) {
        length += tronBytes[offset + 1 + i] * 2 ** (8 * i);
      }
      if (!Number.isSafeInteger(length)) throw new Error("len");
      const headerSize = 1 + n;
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

const encodeValueForUpdate = (builder: ByteWriter, value: TronValue): EncodedValue => {
  const encoded = valueFromAny(value);
  resolveValueOffset(builder, encoded);
  return encoded;
};

const createEmptyContainer = (builder: ByteWriter, type: ValueType): number => {
  const emptyValue = type === ValueType.Arr ? ([] as TronValue[]) : ({} as TronValue);
  const encoded = valueFromAny(emptyValue);
  resolveValueOffset(builder, encoded);
  return encoded.offset ?? 0;
};

const appendMapBranchNode = (
  builder: ByteWriter,
  bitmap: number,
  childOffsets: number[],
): number => {
  const bodyLen = 4 + 4 * childOffsets.length;
  const { body, offset } = appendNodeWithBodyLen(
    builder,
    NodeKind.Branch,
    KeyType.Map,
    childOffsets.length,
    bodyLen,
  );
  writeUint16LE(body, 0, bitmap);
  body[2] = 0;
  body[3] = 0;
  let p = 4;
  for (const childOffset of childOffsets) {
    writeUint32LE(body, p, childOffset);
    p += 4;
  }
  return offset;
};

const appendArrayBranchNode = (
  builder: ByteWriter,
  shift: number,
  bitmap: number,
  length: number,
  childOffsets: number[],
): number => {
  const bodyLen = 8 + 4 * childOffsets.length;
  const { body, offset } = appendNodeWithBodyLen(
    builder,
    NodeKind.Branch,
    KeyType.Arr,
    childOffsets.length,
    bodyLen,
  );
  body[0] = shift & 0xff;
  body[1] = 0;
  writeUint16LE(body, 2, bitmap);
  writeUint32LE(body, 4, length >>> 0);
  let p = 8;
  for (const childOffset of childOffsets) {
    writeUint32LE(body, p, childOffset);
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
    const encoded = encodeValueForUpdate(builder, value);
    if (encoded.type === ValueType.Arr || encoded.type === ValueType.Map) {
      return encoded.offset ?? 0;
    }
    throw new Error("path");
  }
  const tronBytes = builder.buf.subarray(0, builder.length);
  const header = readNodeHeader(tronBytes, offset);
  if (header.keyType === KeyType.Map) {
    const key = path[0];
    if (typeof key !== "string") throw new Error("path");
    const keyBytes = textEncoder.encode(key);
    const hash = xxh32(keyBytes, 0);
    return setMapPath(builder, offset, keyBytes, hash, path.slice(1), value, 0);
  }
  if (header.keyType === KeyType.Arr) {
    const index = path[0];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      throw new Error("path");
    }
    return setArrayPath(builder, offset, index, path.slice(1), value, true);
  }
  throw new Error("type");
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
  if (header.keyType !== KeyType.Map) throw new Error("type");
  const nodeStart = offset + 8;

  if (header.kind === NodeKind.Leaf) {
    let p = nodeStart;
    const entries: MapEntry[] = new Array(header.entryCount);
    let foundIndex = -1;
    for (let i = 0; i < header.entryCount; i++) {
      const [keyValue, keySize] = readEncodedValue(tronBytes, p);
      if (keyValue.type !== ValueType.Txt || !keyValue.bytes) throw new Error("type");
      p += keySize;
      const [entryValue, valueSize] = readEncodedValue(tronBytes, p);
      p += valueSize;
      if (keyValue.bytes.length === keyBytes.length) {
        let matches = true;
        for (let j = 0; j < keyBytes.length; j++) {
          if (keyValue.bytes[j] !== keyBytes[j]) {
            matches = false;
            break;
          }
        }
        if (matches) foundIndex = i;
      }
      entries[i] = {
        key: keyValue.bytes,
        value: entryValue,
        hash: xxh32(keyValue.bytes, 0),
      };
    }

    let nextValue: EncodedValue;
    if (restPath.length === 0) {
      nextValue = encodeValueForUpdate(builder, value);
    } else {
      const nextSegment = restPath[0];
      const containerType = typeof nextSegment === "number" ? ValueType.Arr : ValueType.Map;
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

  const bitmap = readUint16LE(tronBytes, nodeStart);
  const slot = (hash >>> (depth * 4)) & 0x0f;
  const mask = (1 << slot) - 1;
  const idx = popcount16(bitmap & mask);
  const hasChild = ((bitmap >>> slot) & 1) === 1;
  const children: number[] = [];
  let p = nodeStart + 4;
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
    childValue = encodeValueForUpdate(builder, value);
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
  isRoot: boolean,
): number => {
  const tronBytes = builder.buf.subarray(0, builder.length);
  const header = readNodeHeader(tronBytes, offset);
  if (header.keyType !== KeyType.Arr) throw new Error("type");
  const nodeStart = offset + 8;
  const shift = tronBytes[nodeStart];
  const bitmap = readUint16LE(tronBytes, nodeStart + 2);
  const length = readUint32LE(tronBytes, nodeStart + 4);
  const nextLength = Math.max(length, index + 1);
  const nodeLength = isRoot || length !== 0 ? nextLength : length;

  if (header.kind === NodeKind.Leaf) {
    const slotValues: Array<EncodedValue | undefined> = new Array(16);
    let p = nodeStart + 8;
    for (let slot = 0; slot < 16; slot++) {
      if (((bitmap >>> slot) & 1) === 0) continue;
      const [entryValue, entrySize] = readEncodedValue(tronBytes, p);
      p += entrySize;
      slotValues[slot] = entryValue;
    }

    let nextValue: EncodedValue;
    if (restPath.length === 0) {
      nextValue = encodeValueForUpdate(builder, value);
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
      length: nodeLength,
      values,
    };
    return encodeArrayNode(builder, node);
  }

  const slot = (index >>> shift) & 0x0f;
  const mask = (1 << slot) - 1;
  const idx = popcount16(bitmap & mask);
  const hasChild = ((bitmap >>> slot) & 1) === 1;
  const children: number[] = [];
  let p = nodeStart + 8;
  for (let slotIndex = 0; slotIndex < 16; slotIndex++) {
    if (((bitmap >>> slotIndex) & 1) === 0) continue;
    children.push(readUint32LE(tronBytes, p));
    p += 4;
  }

  if (hasChild) {
    const childOffset = children[idx];
    const newChild = setArrayPath(builder, childOffset, index, restPath, value, false);
    children[idx] = newChild;
    return appendArrayBranchNode(builder, shift, bitmap, nodeLength, children);
  }

  let childValue: EncodedValue;
  if (restPath.length === 0) {
    childValue = encodeValueForUpdate(builder, value);
  } else {
    const nextSegment = restPath[0];
    const containerType = typeof nextSegment === "number" ? ValueType.Arr : ValueType.Map;
    const childOffset = createEmptyContainer(builder, containerType);
    const updatedChild = setPathAt(builder, childOffset, restPath, value);
    childValue = { type: containerType, offset: updatedChild };
  }
  const entry: ArrayEntry = { index, value: childValue };
  const newChildNode = buildArrayNode([entry], shift - 4, 0);
  const newChildOffset = encodeArrayNode(builder, newChildNode);
  const newBitmap = bitmap | (1 << slot);
  const newChildren = [...children.slice(0, idx), newChildOffset, ...children.slice(idx)];
  return appendArrayBranchNode(builder, shift, newBitmap, nodeLength, newChildren);
};

export const setPath = (
  tronBytes: Uint8Array,
  path: PathSegment[],
  value: TronValue,
): Uint8Array => {
  if (path.length === 0) return encode(value);
  const tronType = detectType(tronBytes);
  if (tronType !== "tree") throw new Error("type");
  const start = tronBytes.length - TRAILER_SIZE;
  const rootOffset = readUint32LE(tronBytes, start);
  const builder: ByteWriter = {
    buf: tronBytes.slice(0, tronBytes.length - TRAILER_SIZE),
    length: tronBytes.length - TRAILER_SIZE,
  };
  const newRoot = setPathAt(builder, rootOffset, path, value);
  const trailer = new Uint8Array(TRAILER_SIZE);
  writeUint32LE(trailer, 0, newRoot);
  writeUint32LE(trailer, 4, rootOffset);
  trailer.set(TRAILER_MAGIC, 8);
  ensureCapacity(builder, trailer.length);
  builder.buf.set(trailer, builder.length);
  builder.length += trailer.length;
  return builder.buf.slice(0, builder.length);
};

export const detectType = (tronBytes: Uint8Array): TronType => {
  if (tronBytes.length < 4) throw new Error("short");
  const tail = tronBytes.subarray(tronBytes.length - 4);
  if (
    tail[0] === SCALAR_MAGIC[0] &&
    tail[1] === SCALAR_MAGIC[1] &&
    tail[2] === SCALAR_MAGIC[2] &&
    tail[3] === SCALAR_MAGIC[3]
  ) {
    return "scalar";
  }
  if (
    tail[0] === TRAILER_MAGIC[0] &&
    tail[1] === TRAILER_MAGIC[1] &&
    tail[2] === TRAILER_MAGIC[2] &&
    tail[3] === TRAILER_MAGIC[3]
  ) {
    if (tronBytes.length < TRAILER_SIZE) throw new Error("short");
    return "tree";
  }
  throw new Error("type");
};

export const vacuum = (tronBytes: Uint8Array): Uint8Array => {
  const tronType = detectType(tronBytes);
  if (tronType === "scalar") {
    return tronBytes.slice();
  }
  if (tronBytes.length < TRAILER_SIZE) throw new Error("short");
  const start = tronBytes.length - TRAILER_SIZE;
  const rootOffset = readUint32LE(tronBytes, start);
  const magic = tronBytes.subarray(tronBytes.length - 4);
  if (
    magic[0] !== TRAILER_MAGIC[0] ||
    magic[1] !== TRAILER_MAGIC[1] ||
    magic[2] !== TRAILER_MAGIC[2] ||
    magic[3] !== TRAILER_MAGIC[3]
  ) {
    throw new Error("magic");
  }

  const builder: ByteWriter = { buf: new Uint8Array(0), length: 0 };
  const offsets = new Map<number, number>();
  type Patch = { pos: number; len: number; value: number };
  let copyNode: (offset: number) => number;

  const scanValueAt = (
    oldPos: number,
    nodeOffset: number,
    patchOffsets: boolean,
    patches: Patch[],
  ): number => {
    if (oldPos >= tronBytes.length) throw new Error("tag");
    const tag = tronBytes[oldPos];
    const typ = ((tag >>> 5) & 0x07) as ValueType;
    switch (typ) {
      case ValueType.Nil:
      case ValueType.Bit:
        return 1;
      case ValueType.I64:
      case ValueType.F64:
        if (oldPos + 9 > tronBytes.length) throw new Error("short");
        return 9;
      case ValueType.Txt:
      case ValueType.Bin:
      case ValueType.Arr:
      case ValueType.Map: {
        let length = 0;
        let headerSize = 1;
        if ((tag & 0x10) !== 0) {
          length = tag & 0x0f;
        } else {
          const n = tag & 0x0f;
          if (n < 1 || n > 8) throw new Error("len");
          if (oldPos + 1 + n > tronBytes.length) throw new Error("short");
          for (let i = 0; i < n; i++) {
            length += tronBytes[oldPos + 1 + i] * 2 ** (8 * i);
          }
          if (!Number.isSafeInteger(length)) throw new Error("len");
          headerSize = 1 + n;
        }
        const start = oldPos + headerSize;
        const end = start + length;
        if (end > tronBytes.length) throw new Error("short");
        if ((typ === ValueType.Arr || typ === ValueType.Map) && patchOffsets) {
          if (length === 0 || length > 4) throw new Error("off");
          let childOffset = 0;
          for (let i = 0; i < length; i++) {
            childOffset |= tronBytes[start + i] << (8 * i);
          }
          const newChildOffset = copyNode(childOffset >>> 0);
          patches.push({ pos: start - nodeOffset, len: length, value: newChildOffset });
        }
        return headerSize + length;
      }
      default:
        throw new Error("type");
    }
  };

  copyNode = (offset: number): number => {
    const cached = offsets.get(offset);
    if (cached !== undefined) return cached;
    if (offset + 8 > tronBytes.length) throw new Error("short");
    const raw = readUint32LE(tronBytes, offset);
    const kind = (raw & 0x1) as NodeKind;
    const keyType = ((raw >>> 1) & 0x1) as KeyType;
    const nodeLen = raw & ~0x3;
    const entryCount = readUint32LE(tronBytes, offset + 4);
    if (nodeLen < 8 || nodeLen % 4 !== 0) throw new Error("len");
    if (offset + nodeLen > tronBytes.length) throw new Error("short");

    const nodeStart = offset + 8;
    const patches: Patch[] = [];

    if (keyType === KeyType.Arr) {
      if (kind === NodeKind.Leaf) {
        const bitmap = readUint16LE(tronBytes, nodeStart + 2);
        let p = nodeStart + 8;
        for (let slot = 0; slot < 16; slot++) {
          if (((bitmap >>> slot) & 1) === 0) continue;
          const size = scanValueAt(p, offset, true, patches);
          p += size;
        }
      } else {
        let p = nodeStart + 8;
        for (let i = 0; i < entryCount; i++) {
          const childOffset = readUint32LE(tronBytes, p);
          const newChildOffset = copyNode(childOffset);
          patches.push({ pos: p - offset, len: 4, value: newChildOffset });
          p += 4;
        }
      }
    } else if (keyType === KeyType.Map) {
      if (kind === NodeKind.Leaf) {
        let p = nodeStart;
        for (let i = 0; i < entryCount; i++) {
          const keySize = scanValueAt(p, offset, false, patches);
          p += keySize;
          const valueSize = scanValueAt(p, offset, true, patches);
          p += valueSize;
        }
      } else {
        let p = nodeStart + 4;
        for (let i = 0; i < entryCount; i++) {
          const childOffset = readUint32LE(tronBytes, p);
          const newChildOffset = copyNode(childOffset);
          patches.push({ pos: p - offset, len: 4, value: newChildOffset });
          p += 4;
        }
      }
    } else {
      throw new Error("type");
    }

    ensureCapacity(builder, nodeLen);
    const newOffset = builder.length;
    builder.buf.set(tronBytes.subarray(offset, offset + nodeLen), newOffset);
    builder.length += nodeLen;

    for (const patch of patches) {
      const at = newOffset + patch.pos;
      const value = patch.value >>> 0;
      builder.buf[at] = value & 0xff;
      if (patch.len > 1) builder.buf[at + 1] = (value >>> 8) & 0xff;
      if (patch.len > 2) builder.buf[at + 2] = (value >>> 16) & 0xff;
      if (patch.len > 3) builder.buf[at + 3] = (value >>> 24) & 0xff;
    }

    offsets.set(offset, newOffset);
    return newOffset;
  };

  const newRootOffset = copyNode(rootOffset);
  const trailer = new Uint8Array(TRAILER_SIZE);
  writeUint32LE(trailer, 0, newRootOffset);
  writeUint32LE(trailer, 4, 0);
  trailer.set(TRAILER_MAGIC, 8);
  ensureCapacity(builder, trailer.length);
  builder.buf.set(trailer, builder.length);
  builder.length += trailer.length;
  return builder.buf.slice(0, builder.length);
};

export const canonical = (tronBytes: Uint8Array): Uint8Array => {
  const tronType = detectType(tronBytes);

  const decodeEncodedValueAt = (offset: number): [EncodedValue, number] => {
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
        const i64 = new DataView(tronBytes.buffer, tronBytes.byteOffset + offset + 1, 8).getBigInt64(
          0,
          true,
        );
        return [{ type: ValueType.I64, i64 }, 9];
      }
      case ValueType.F64: {
        if (offset + 9 > tronBytes.length) throw new Error("short");
        const f64 = new DataView(tronBytes.buffer, tronBytes.byteOffset + offset + 1, 8).getFloat64(
          0,
          true,
        );
        return [{ type: ValueType.F64, f64 }, 9];
      }
      case ValueType.Txt:
      case ValueType.Bin:
      case ValueType.Arr:
      case ValueType.Map: {
        let length = 0;
        let headerSize = 1;
        if ((tag & 0x10) !== 0) {
          length = tag & 0x0f;
        } else {
          const n = tag & 0x0f;
          if (n < 1 || n > 8) throw new Error("len");
          if (offset + 1 + n > tronBytes.length) throw new Error("short");
          for (let i = 0; i < n; i++) {
            length += tronBytes[offset + 1 + i] * 2 ** (8 * i);
          }
          if (!Number.isSafeInteger(length)) throw new Error("len");
          headerSize = 1 + n;
        }
        const start = offset + headerSize;
        const end = start + length;
        if (end > tronBytes.length) throw new Error("short");
        if (typ === ValueType.Txt || typ === ValueType.Bin) {
          return [{ type: typ, bytes: tronBytes.subarray(start, end) }, headerSize + length];
        }
        if (length === 0 || length > 4) throw new Error("off");
        let childOffset = 0;
        for (let i = 0; i < length; i++) {
          childOffset |= tronBytes[start + i] << (8 * i);
        }
        const treeValue = decodeTreeValueAt(childOffset >>> 0);
        if (treeValue.type !== typ || !treeValue.node) throw new Error("type");
        return [{ type: typ, node: treeValue.node }, headerSize + length];
      }
      default:
        throw new Error("type");
    }
  };

  const decodeTreeValueAt = (offset: number): EncodedValue => {
    const header = readNodeHeader(tronBytes, offset);
    if (header.keyType === KeyType.Arr) {
      const nodeStart = offset + 8;
      const length = readUint32LE(tronBytes, nodeStart + 4);
      const entriesByIndex = new Map<number, EncodedValue>();
      const collectArrayEntriesAt = (nodeOffset: number, baseIndex: number): void => {
        const nodeHeader = readNodeHeader(tronBytes, nodeOffset);
        if (nodeHeader.keyType !== KeyType.Arr) throw new Error("type");
        const start = nodeOffset + 8;
        const shift = tronBytes[start];
        const bitmap = readUint16LE(tronBytes, start + 2);
        if (nodeHeader.kind === NodeKind.Leaf) {
          let p = start + 8;
          for (let slot = 0; slot < 16; slot++) {
            if (((bitmap >>> slot) & 1) === 0) continue;
            const [value, size] = decodeEncodedValueAt(p);
            const index = baseIndex + slot;
            entriesByIndex.set(index, value);
            p += size;
          }
          return;
        }
        let p = start + 8;
        for (let slot = 0; slot < 16; slot++) {
          if (((bitmap >>> slot) & 1) === 0) continue;
          const childOffset = readUint32LE(tronBytes, p);
          p += 4;
          const childBase = baseIndex + slot * (1 << shift);
          collectArrayEntriesAt(childOffset, childBase);
        }
      };
      collectArrayEntriesAt(offset, 0);
      for (const index of entriesByIndex.keys()) {
        if (index >= length) throw new Error("len");
      }
      const entries: ArrayEntry[] = new Array(length);
      for (let i = 0; i < length; i++) {
        entries[i] = { index: i, value: entriesByIndex.get(i) ?? { type: ValueType.Nil } };
      }
      let shift = 0;
      if (length > 0) {
        let maxIndex = length - 1;
        while ((maxIndex >>> shift) > 0x0f) {
          shift += 4;
        }
      }
      const node = buildArrayNode(entries, shift, length);
      return { type: ValueType.Arr, node };
    }
    if (header.keyType === KeyType.Map) {
      const entries: MapEntry[] = [];
      const collectMapEntriesAt = (nodeOffset: number): void => {
        const nodeHeader = readNodeHeader(tronBytes, nodeOffset);
        if (nodeHeader.keyType !== KeyType.Map) throw new Error("type");
        const start = nodeOffset + 8;
        if (nodeHeader.kind === NodeKind.Leaf) {
          let p = start;
          for (let i = 0; i < nodeHeader.entryCount; i++) {
            const [keyValue, keySize] = decodeEncodedValueAt(p);
            if (keyValue.type !== ValueType.Txt) throw new Error("type");
            const keyBytes = keyValue.bytes ?? new Uint8Array();
            p += keySize;
            const [value, valueSize] = decodeEncodedValueAt(p);
            p += valueSize;
            entries.push({ key: keyBytes, value, hash: xxh32(keyBytes, 0) });
          }
          return;
        }
        const bitmap = readUint16LE(tronBytes, start);
        let p = start + 4;
        for (let slot = 0; slot < 16; slot++) {
          if (((bitmap >>> slot) & 1) === 0) continue;
          const childOffset = readUint32LE(tronBytes, p);
          p += 4;
          collectMapEntriesAt(childOffset);
        }
      };
      collectMapEntriesAt(offset);
      const node = buildMapNode(entries, 0);
      return { type: ValueType.Map, node };
    }
    throw new Error("type");
  };

  if (tronType === "scalar") {
    if (tronBytes.length < 4) throw new Error("short");
    const payload = tronBytes.subarray(0, tronBytes.length - 4);
    const [value, size] = decodeEncodedValueAt(0);
    if (value.type === ValueType.Arr || value.type === ValueType.Map) throw new Error("type");
    if (size !== payload.length) throw new Error("extra");
    const encoded = new Uint8Array(encodedValueLen(value));
    writeValue(encoded, 0, value);
    const out = new Uint8Array(encoded.length + 4);
    out.set(encoded, 0);
    out.set(SCALAR_MAGIC, encoded.length);
    return out;
  }

  if (tronBytes.length < TRAILER_SIZE) throw new Error("short");
  const start = tronBytes.length - TRAILER_SIZE;
  const rootOffset = readUint32LE(tronBytes, start);
  const magic = tronBytes.subarray(tronBytes.length - 4);
  if (
    magic[0] !== TRAILER_MAGIC[0] ||
    magic[1] !== TRAILER_MAGIC[1] ||
    magic[2] !== TRAILER_MAGIC[2] ||
    magic[3] !== TRAILER_MAGIC[3]
  ) {
    throw new Error("magic");
  }

  const rootValue = decodeTreeValueAt(rootOffset);
  const builder: ByteWriter = { buf: new Uint8Array(0), length: 0 };
  resolveValueOffset(builder, rootValue);
  const trailer = new Uint8Array(TRAILER_SIZE);
  writeUint32LE(trailer, 0, rootValue.offset ?? 0);
  writeUint32LE(trailer, 4, 0);
  trailer.set(TRAILER_MAGIC, 8);
  ensureCapacity(builder, trailer.length);
  builder.buf.set(trailer, builder.length);
  builder.length += trailer.length;
  return builder.buf.slice(0, builder.length);
};
