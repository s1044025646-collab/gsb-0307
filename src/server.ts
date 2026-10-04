import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { encode, decode, frameWire, fromHex, toHex } from "./cobs";
import { Store } from "./store";
import { CobsError } from "./errors";
import { FrameEvent } from "./stream";

function eventToJson(ev: FrameEvent) {
  if (ev.type === "frame") {
    return {
      type: "frame",
      frameIndex: ev.frameIndex,
      streamOffset: ev.streamOffset,
      payloadHex: toHex(ev.payload),
      fragmentHex: toHex(ev.fragment),
      wireHex: toHex(ev.wire),
      canonical: ev.canonical,
    };
  }
  if (ev.type === "error") {
    return {
      type: "error",
      frameIndex: ev.frameIndex,
      streamOffset: ev.streamOffset,
      code: ev.code,
      message: ev.message,
      byteOffset: ev.byteOffset,
      wireHex: toHex(ev.wire),
    };
  }
  return {
    type: "truncated",
    streamOffset: ev.streamOffset,
    pendingHex: toHex(ev.pending),
    discarded: ev.discarded,
    code: "STREAM_TRUNCATED",
  };
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8 << 20) throw new CobsError("BAD_REQUEST", "请求体过大");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CobsError("BAD_REQUEST", "请求体不是合法 JSON");
  }
}

function field(obj: unknown, name: string): unknown {
  if (typeof obj !== "object" || obj === null || !(name in obj)) {
    throw new CobsError("BAD_REQUEST", `缺少字段 ${name}`);
  }
  return (obj as Record<string, unknown>)[name];
}

function hexField(obj: unknown, name: string): Buffer {
  const v = field(obj, name);
  if (typeof v !== "string") {
    throw new CobsError("BAD_REQUEST", `字段 ${name} 必须是十六进制字符串`);
  }
  return fromHex(v);
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const data = JSON.stringify(body, null, 2);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(data);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      const body = req.method === "POST" ? await readBody(req) : {};

      if (req.method === "POST" && p === "/encode") {
        const payload = hexField(body, "payloadHex");
        const fragment = encode(payload);
        return send(200, {
          payloadHex: toHex(payload),
          fragmentHex: toHex(fragment),
          wireHex: toHex(frameWire(fragment)),
        });
      }
      if (req.method === "POST" && p === "/decode") {
        const fragment = hexField(body, "fragmentHex");
        const r = decode(fragment);
        return send(200, {
          payloadHex: toHex(r.payload),
          fragmentHex: toHex(fragment),
          reencodedHex: toHex(r.reencoded),
          canonical: r.canonical,
        });
      }
      if (req.method === "POST" && p === "/streams") {
        return send(201, store.createStream());
      }
      const m = p.match(/^\/streams\/(\d+)(\/(append|finish|frames|export))?$/);
      if (m) {
        const id = Number(m[1]);
        const action = m[3];
        if (req.method === "POST" && action === "append") {
          const chunk = hexField(body, "chunkHex");
          const events = store.append(id, chunk);
          return send(200, { events: events.map(eventToJson), stream: store.getStream(id) });
        }
        if (req.method === "POST" && action === "finish") {
          const events = store.finish(id);
          return send(200, { events: events.map(eventToJson), stream: store.getStream(id) });
        }
        if (req.method === "GET" && action === "frames") {
          const limit = Number(url.searchParams.get("limit") ?? 100);
          const offset = Number(url.searchParams.get("offset") ?? 0);
          return send(200, { frames: store.frames(id, limit, offset) });
        }
        if (req.method === "GET" && action === "export") {
          return send(200, store.exportStream(id));
        }
        if (req.method === "GET" && !action) {
          return send(200, store.getStream(id));
        }
      }
      if (req.method === "GET" && p === "/streams") {
        return send(200, { streams: store.listStreams() });
      }
      throw new CobsError("NOT_FOUND", `未知路由 ${req.method} ${p}`);
    } catch (err) {
      if (err instanceof CobsError) {
        return send(err.code === "NOT_FOUND" || err.code === "STREAM_NOT_FOUND" ? 404 : 400, {
          error: err.toJSON(),
        });
      }
      return send(500, { error: { code: "INTERNAL", message: String(err) } });
    }
  });
}

/** 选择一个空闲端口 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

export async function startServer(dbPath: string, port?: number) {
  const store = new Store(dbPath);
  const server = createServer(store);
  const actualPort = port ?? (await pickFreePort());
  await new Promise<void>((resolve) =>
    server.listen(actualPort, "127.0.0.1", resolve)
  );
  return { server, store, port: actualPort };
}

export const DEFAULT_DB = path.join("data", "cobs.db");
