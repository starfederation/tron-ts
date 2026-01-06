import { encode, tron } from "../src/index";

const makeTron = (value: unknown) => tron(encode(value as never));

describe("tron proxy behavior", () => {
  test("scalars pass through", () => {
    expect(makeTron(3)).toBe(3);
    expect(makeTron("hi")).toBe("hi");
    expect(makeTron(true)).toBe(true);
    expect(makeTron(null)).toBeNull();
    const bytes = new Uint8Array([1, 2, 3]);
    expect(makeTron(bytes)).toBeInstanceOf(Uint8Array);
  });

  test("object and array access", () => {
    const value = { a: { b: 1 }, arr: [{ c: 2 }, 3] };
    const proxy = makeTron(value);
    expect(proxy.a.b).toBe(1);
    expect(proxy.arr[0].c).toBe(2);
    expect(Array.isArray(proxy.arr)).toBe(true);
  });

  test("identity is stable for nested proxies", () => {
    const proxy = makeTron({ nested: { x: 1 }, arr: [{ y: 2 }] });
    expect(proxy.nested).toBe(proxy.nested);
    expect(proxy.arr[0]).toBe(proxy.arr[0]);
  });

  test("enumeration and iteration behave normally", () => {
    const value = { a: 1, b: 2, c: [3] };
    const proxy = makeTron(value);
    expect(Object.keys(proxy).sort()).toEqual(["a", "b", "c"]);
    expect("b" in proxy).toBe(true);
    const seen: string[] = [];
    for (const key in proxy) seen.push(key);
    expect(seen.sort()).toEqual(["a", "b", "c"]);
    const iter = [...proxy.c];
    expect(iter[0]).toBe(3);
    expect(JSON.parse(JSON.stringify(proxy))).toEqual(value);
  });

  test("array keys and length behave normally", () => {
    const proxy = makeTron([10, 20, 30]);
    expect(proxy.length).toBe(3);
    expect(Object.keys(proxy)).toEqual(["0", "1", "2"]);
    expect(1 in proxy).toBe(true);
  });
});
