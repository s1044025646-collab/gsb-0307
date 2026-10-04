import * as http from "node:http";
import * as net from "node:net";
import { Store } from "./db";
import { encode, encodeFrame, decode, CobsError } from "./cobs";

export interface ServerConfig {
  port: number; // 0 表示自动选择空闲端口
  dataDir: string;
  maxStreams: number;
  maxChunkBytes: number;
  maxHistory: number;
  maxFragmentLength: number;
  maxPayloadLength: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  port: 0,
  dataDir: "data",
  maxStreams: 100,
  maxChunkBytes: 1 << 20,
  maxHistory: 500,
  maxFragmentLength: 4096,
  maxPayloadLength: 4096,
};

function parseHex(s: unknown, field: string): Buffer {
  if (typeof s !== "string" || !/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) {
    throw new CobsError("BAD_HEX", `字段 ${field} 必须是偶数长度的十六进制字符串`);
  }
  return Buffer.from(s, "hex");
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<any> {
  const chunks: Buffer[] = [];
  let len = 0;
  for await (const c of req) {
    len += (c as Buffer).length;
    if (len > limit) throw new CobsError("BODY_TOO_LARGE", "请求体过大");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CobsError("BAD_JSON", "请求体不是合法 JSON");
  }
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export async function startServer(cfg: Partial<ServerConfig> = {}) {
  const config: ServerConfig = { ...DEFAULT_CONFIG, ...cfg };
  if (config.port === 0) config.port = await findFreePort();
  const store = new Store(`${config.dataDir}/cobs.db`);

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const data = JSON.stringify(body, null, 2);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(data);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      const body = req.method === "POST" ? await readBody(req, config.maxChunkBytes * 2 + 1024) : {};
      const limits = {
        maxFragmentLength: config.maxFragmentLength,
        maxPayloadLength: config.maxPayloadLength,
      };

      if (p === "/health" && req.method === "GET") {
        return send(200, { ok: true });
      }
      if (p === "/api/encode" && req.method === "POST") {
        const payload = parseHex(body.payloadHex ?? body.hex, "payloadHex");
        const fragment = encode(payload, limits);
        return send(200, {
          payloadHex: payload.toString("hex"),
          fragmentHex: fragment.toString("hex"),
          wireHex: encodeFrame(payload, limits).toString("hex"),
        });
      }
      if (p === "/api/decode" && req.method === "POST") {
        const fragment = parseHex(body.fragmentHex ?? body.hex, "fragmentHex");
        const { payload, canonical } = decode(fragment, limits);
        return send(200, {
          fragmentHex: fragment.toString("hex"),
          payloadHex: payload.toString("hex"),
          canonical,
        });
      }
      if (p === "/api/streams" && req.method === "POST") {
        if (store.countStreams() >= config.maxStreams) {
          return send(429, { error: { code: "TOO_MANY_STREAMS", message: "流数量已达上限" } });
        }
        const id = store.createStream(limits);
        return send(201, { streamId: id });
      }
      if (p === "/api/streams" && req.method === "GET") {
        return send(200, { streams: store.listStreams(config.maxHistory) });
      }
      const m = p.match(/^\/api\/streams\/(\d+)(\/(append|finish|frames|export))?$/);
      if (m) {
        const id = Number(m[1]);
        const sub = m[3];
        const row = store.getStream(id);
        if (!row) return send(404, { error: { code: "NOT_FOUND", message: `流 ${id} 不存在` } });
        if (!sub && req.method === "GET") return send(200, { stream: row });
        if (sub === "append" && req.method === "POST") {
          const chunk = parseHex(body.chunkHex ?? body.hex, "chunkHex");
          if (chunk.length > config.maxChunkBytes) {
            return send(413, { error: { code: "CHUNK_TOO_LARGE", message: "块超过大小上限" } });
          }
          return send(200, store.append(id, chunk));
        }
        if (sub === "finish" && req.method === "POST") {
          return send(200, { tail: store.finish(id) });
        }
        if (sub === "frames" && req.method === "GET") {
          const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), config.maxHistory);
          const offset = Number(url.searchParams.get("offset") ?? 0);
          return send(200, { frames: store.getFrames(id, limit, offset) });
        }
        if (sub === "export" && req.method === "GET") {
          const frames = store.getFrames(id, config.maxHistory);
          return send(200, { stream: row, frames });
        }
      }
      return send(404, { error: { code: "NOT_FOUND", message: "未知路由" } });
    } catch (e) {
      if (e instanceof CobsError) {
        return send(400, { error: { code: e.code, message: e.message, offset: e.offset ?? null } });
      }
      return send(500, { error: { code: "INTERNAL", message: String((e as Error).message) } });
    }
  });

  await new Promise<void>((resolve) => server.listen(config.port, "127.0.0.1", resolve));
  return { server, store, config };
}
