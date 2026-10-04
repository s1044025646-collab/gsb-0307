import { encode, encodeFrame } from "./cobs";
import { Store } from "./db";
import * as path from "node:path";
import * as fs from "node:fs";

/** 演示：空载荷、连续零、253/254/255 非零字节边界、好坏好帧流。 */
export async function runDemo(): Promise<void> {
  const show = (name: string, payload: Buffer) => {
    console.log(`\n== ${name} ==`);
    console.log(`载荷     payloadHex : ${payload.toString("hex") || "(空)"} (${payload.length} 字节)`);
    console.log(`编码片段 fragmentHex: ${encode(payload).toString("hex")}`);
    console.log(`线缆字节 wireHex   : ${encodeFrame(payload).toString("hex")}`);
  };

  show("空载荷", Buffer.alloc(0));
  show("含连续零", Buffer.from([0x11, 0x00, 0x00, 0x22, 0x00, 0x33]));
  show("253 个非零字节", Buffer.alloc(253, 0xaa));
  show("254 个非零字节（恰好整段，规范形式不追加 0x01）", Buffer.alloc(254, 0xbb));
  show("255 个非零字节", Buffer.alloc(255, 0xcc));

  // 好帧、坏帧、好帧相连的流（流中 0x00 只会是分隔符，坏帧为段长越界）
  const good1 = encodeFrame(Buffer.from("hello"));
  const bad = Buffer.from([0x03, 0x41, 0x00, 0x42]); // 坏帧：段声明长度超过剩余片段
  const good2 = encodeFrame(Buffer.from("world"));
  const wire = Buffer.concat([good1, bad, Buffer.from([0x00]), good2]);

  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, "demo.db");
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  const db = new Store(dbFile);
  const id = db.createStream({ maxFragmentLength: 4096 });
  console.log(`\n== 流解析（好帧 + 坏帧 + 好帧，分两块追加）==`);
  console.log(`线缆字节: ${wire.toString("hex")}`);
  const mid = good1.length + 2; // 任意边界切分
  const r1 = db.append(id, wire.subarray(0, mid));
  const r2 = db.append(id, wire.subarray(mid));
  const tail = db.finish(id);
  for (const f of [...r1.frames, ...r2.frames, ...(tail ? [tail] : [])]) {
    console.log(
      `帧#${f.seq} [${f.status}] fragment=${f.fragmentHex || "(无)"} payload=${f.payloadHex ?? "-"}` +
        (f.errorCode ? ` 错误=${f.errorCode}@${f.errorOffset ?? "?"}: ${f.errorMessage}` : "")
    );
  }
  db.close();
}

if (require.main === module) {
  runDemo();
}
