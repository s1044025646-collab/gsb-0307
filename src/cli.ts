import * as fs from "node:fs";
import * as path from "node:path";
import { encode, decode, frameWire, fromHex, toHex } from "./cobs";
import { Store } from "./store";
import { startServer, DEFAULT_DB } from "./server";
import { CobsError } from "./errors";

function out(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

/** 输入来源：--hex <hex> 或 --file <项目内二进制文件> */
function readInput(args: Record<string, string>, key: string): Buffer {
  const hex = args[key];
  const file = args[`${key}File`];
  if (hex !== undefined) return fromHex(hex);
  if (file !== undefined) {
    const p = path.resolve(file);
    if (!p.startsWith(path.resolve("."))) {
      throw new CobsError("BAD_REQUEST", "输入文件必须位于项目目录内");
    }
    return fs.readFileSync(p);
  }
  throw new CobsError("BAD_REQUEST", `需要 --${key} <hex> 或 --${key}File <path>`);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      opts[argv[i].slice(2)] = argv[++i] ?? "";
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, opts };
}

const USAGE = `COBS 字节封装与分块流帧还原 CLI

用法: node dist/src/cli.js <命令> [选项]

单次编解码:
  encode --payload <hex> | --payloadFile <path>
  decode --fragment <hex> | --fragmentFile <path>

流解析（状态保存在 SQLite，可跨进程续算）:
  stream-create
  stream-append --stream <id> --chunk <hex> | --chunkFile <path>
  stream-finish --stream <id>
  stream-info --stream <id>
  stream-frames --stream <id> [--limit 100] [--offset 0]
  stream-export --stream <id>
  stream-list

服务与演示:
  serve [--port <n>] [--db <path>]     默认自动选择空闲端口
  demo                                  运行内置演示

通用选项: --db <path>（默认 data/cobs.db）
`;

export async function main(argv: string[]): Promise<void> {
  const { positional, opts } = parseArgs(argv);
  const cmd = positional[0];
  const dbPath = opts.db ?? DEFAULT_DB;

  switch (cmd) {
    case "encode": {
      const payload = readInput(opts, "payload");
      const fragment = encode(payload);
      return out({
        payloadHex: toHex(payload),
        fragmentHex: toHex(fragment),
        wireHex: toHex(frameWire(fragment)),
      });
    }
    case "decode": {
      const fragment = readInput(opts, "fragment");
      const r = decode(fragment);
      return out({
        payloadHex: toHex(r.payload),
        fragmentHex: toHex(fragment),
        reencodedHex: toHex(r.reencoded),
        canonical: r.canonical,
      });
    }
    case "stream-create":
      return out(new Store(dbPath).createStream());
    case "stream-append": {
      const store = new Store(dbPath);
      const id = Number(opts.stream);
      const chunk = readInput(opts, "chunk");
      const events = store.append(id, chunk);
      return out({ events: events.map(eventJson), stream: store.getStream(id) });
    }
    case "stream-finish": {
      const store = new Store(dbPath);
      const id = Number(opts.stream);
      const events = store.finish(id);
      return out({ events: events.map(eventJson), stream: store.getStream(id) });
    }
    case "stream-info":
      return out(new Store(dbPath).getStream(Number(opts.stream)));
    case "stream-frames":
      return out({
        frames: new Store(dbPath).frames(
          Number(opts.stream),
          opts.limit ? Number(opts.limit) : 100,
          opts.offset ? Number(opts.offset) : 0
        ),
      });
    case "stream-export":
      return out(new Store(dbPath).exportStream(Number(opts.stream)));
    case "stream-list":
      return out({ streams: new Store(dbPath).listStreams() });
    case "serve": {
      const port = opts.port ? Number(opts.port) : undefined;
      const { port: actual } = await startServer(dbPath, port);
      console.log(`COBS API 服务已启动: http://127.0.0.1:${actual} (数据库: ${dbPath})`);
      return;
    }
    case "demo": {
      const { runDemo } = await import("./demo");
      return runDemo();
    }
    default:
      console.log(USAGE);
      if (cmd) process.exitCode = 1;
  }
}

function eventJson(ev: import("./stream").FrameEvent) {
  const e = ev as Record<string, unknown>;
  const o: Record<string, unknown> = { ...e };
  for (const k of ["payload", "fragment", "wire", "pending"]) {
    if (Buffer.isBuffer(o[k])) o[`${k}Hex`] = toHex(o[k] as Buffer);
    delete o[k];
  }
  return o;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof CobsError) {
      console.error(JSON.stringify({ error: err.toJSON() }, null, 2));
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  });
}
