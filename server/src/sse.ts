/**
 * Incremental text/event-stream parser. Feed it decoded chunks; it returns the
 * `data` payload of every completed event. Comments (`: ping`) are dropped.
 */
export class SseParser {
  private buf = "";

  push(chunk: string): string[] {
    this.buf += chunk.replace(/\r\n?/g, "\n");
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length > 0) out.push(data.join("\n"));
    }
    return out;
  }
}
