import { encode } from "./codec";
import type { TronValue } from "./codec";

const textDecoder = new TextDecoder();

const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;

const parseJSONValue = (value: unknown): TronValue => {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.startsWith("b64:")) {
      try {
        const bin = atob(value.slice(4));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
          out[i] = bin.charCodeAt(i);
        }
        return out;
      } catch {}
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("num");
    if (Number.isInteger(value)) {
      const asBigInt = BigInt(value);
      if (asBigInt >= MIN_I64 && asBigInt <= MAX_I64) {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => parseJSONValue(entry));
  }
  if (value && typeof value === "object") {
    const out: { [key: string]: TronValue } = {};
    for (const key of Object.keys(value)) {
      out[key] = parseJSONValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  throw new Error("type");
};

export const stringifyJSONValue = (value: unknown, undefinedAsNull = false): string => {
  if (value === undefined) {
    if (undefinedAsNull) return "null";
    throw new Error("type");
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("num");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Uint8Array) {
    let bin = "";
    for (let i = 0; i < value.length; i++) {
      bin += String.fromCharCode(value[i]);
    }
    return JSON.stringify(`b64:${btoa(bin)}`);
  }
  if (Array.isArray(value)) {
    const length = value.length >>> 0;
    let out = "[";
    for (let i = 0; i < length; i++) {
      if (i > 0) out += ",";
      out += stringifyJSONValue(value[i], true);
    }
    out += "]";
    return out;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    let out = "{";
    let first = true;
    for (const key of keys) {
      const entry = record[key];
      if (entry === undefined) continue;
      if (!first) out += ",";
      first = false;
      out += `${JSON.stringify(key)}:${stringifyJSONValue(entry)}`;
    }
    out += "}";
    return out;
  }
  throw new Error("type");
};

export const fromJSON = (input: string | Uint8Array): Uint8Array => {
  const jsonText = typeof input === "string" ? input : textDecoder.decode(input);
  const parsed = JSON.parse(jsonText) as unknown;
  const value = parseJSONValue(parsed);
  return encode(value);
};
