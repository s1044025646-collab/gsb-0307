import * as fs from "node:fs";
import * as path from "node:path";
import { encode, encodeFrame, decode } from "./cobs";
import { Store } from "./db";
import { startServer, DEFAULT_CONFIG } from "./server";

const DATA_DIR = process.env.COBS_DATA_DIR ?? path.join(process.cwd(), "data");

function parseHexArg(s: string): Buffer {
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) {
    throw new Error(`不是合法十六进制字符串: ${s.slice(0, 40)}`);
  }
  return Buffer.from(s, "hex");
}

function readInput(arg: string): Buffer {
  // 支持 0x 前缀 hex、纯 hex、@文件路径（项目内二进制样例）
  if (arg.startsWith("@")) {
    const p = path.resolve(process.cwd(), arg.slice(1));
    if (!p.startsWith(process.cwd())) throw new Error("文件必须位于项目目录内");
    return fs.readFileSync(p);
  }
  return parseHexArg(arg.startsWith("0x") ? arg.slice(2) : arg);
}

function store(): Store {
  return new Store(path.join(DATA_DIR, "cobs.db"));
}

const limits = () => ({
  maxFragmentLength: DEFAULT_CONFIG.maxFragmentLength,
  maxPayloadLength: DEFAULT_CONFIG.maxPayloadLength,
});

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));

  switch (cmd) {
    case "encode": {
      const payload = readInput(args[0] ?? "");
      out({
        payloadHex: payload.toString("hex"),
        fragmentHex: encode(payload, limits()).toString("hex"),
        wireHex: encodeFrame(payload, limits()).toString("hex"),
      });
      break;
    }
    case "decode": {
      const fragment = readInput(args[0] ?? "");
      const { payload, canonical } = decode(fragment, limits());
      out({ fragmentHex: fragment.toString("hex"), payloadHex: payload.toString("hex"), canonical });
      break;
    }
    case "stream-create": {
      const db = store();
      const id = db.createStream(limits());
      db.close();
      out({ streamId: id });
      break;
    }
    case "append": {
      const db = store();
      const chunk = readInput(args[1] ?? "");
      if (chunk.length > DEFAULT_CONFIG.maxChunkBytes) throw new Error("块超过大小上限");
      out(db.append(Number(args[0]), chunk));
      db.close();
      break;
    }
    case "finish": {
      const db = store();
      out({ tail: db.finish(Number(args[0])) });
      db.close();
      break;
    }
    case "frames": {
      const db = store();
      const limit = Math.min(Number(args[1] ?? 100), DEFAULT_CONFIG.maxHistory);
      out({ frames: db.getFrames(Number(args[0]), limit) });
      db.close();
      break;
    }
    case "export": {
      const db = store();
      const id = Number(args[0]);
      out({ stream: db.getStream(id), frames: db.getFrames(id, DEFAULT_CONFIG.maxHistory) });
      db.close();
      break;
    }
    case "serve": {
      const port = args[0] ? Number(args[0]) : Number(process.env.COBS_PORT ?? 0);
      const { config } = await startServer({ port, dataDir: DATA_DIR });
      console.log(`COBS 服务已启动: http://127.0.0.1:${config.port} (数据目录: ${path.resolve(DATA_DIR)})`);
      break;
    }
    case "demo": {
      const { runDemo } = await import("./demo");
      await runDemo();
      break;
    }
    default:
      console.log(`用法: node dist/cli.js <命令> [参数]
  encode <hex|@文件>          编码载荷，输出 payloadHex / fragmentHex / wireHex
  decode <hex|@文件>          解码单个编码片段
  stream-create               创建解析流
  append <streamId> <hex|@文件>  追加一个块
  finish <streamId>           结束流（报告截断）
  frames <streamId> [limit]   查看帧与诊断
  export <streamId>           导出流与全部帧
  serve [port]                启动 HTTP API（默认自动选空闲端口）
  demo                        运行演示`);
  }
}

main().catch((e) => {
  console.error(`错误: ${e.message}`);
  process.exit(1);
});
