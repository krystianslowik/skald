import { describe, expect, it } from "bun:test";
import { SseParser } from "../src/sse";

describe("SseParser", () => {
  it("handles split chunks, comments and CRLF", () => {
    const p = new SseParser();
    expect(p.push(": ping\n\ndata: {\"seq\":1")).toEqual([]);
    expect(p.push("}\n\nid: 2\r\ndata: {\"seq\":2}\r\n\r\n")).toEqual(['{"seq":1}', '{"seq":2}']);
  });
});
