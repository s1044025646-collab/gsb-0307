import { encode, decode, frameWire, toHex } from "./cobs";
import { FrameParser } from "./stream";

function show(label: string, payload: Buffer) {
  const fragment = encode(payload);
  const wire = frameWire(fragment);
  const back = decode(fragment);
  console.log(`\n== ${label} ==`);
  console.log(`载荷   (${payload.length} 字节): ${toHex(payload) || "(空)"}`);
  console.log(`片段   (${fragment.length} 字节): ${toHex(fragment)}`);
  console.log(`线缆   (${wire.length} 字节): ${toHex(wire)}`);
  console.log(`往返一致: ${back.payload.equals(payload)}`);
}

export function runDemo(): void {
  console.log("=== COBS 单次编解码演示 ===");
  show("空载荷", Buffer.alloc(0));
  show("含连续零", Buffer.from([0x01, 0x00, 0x00, 0x02, 0x00, 0x03]));
  show("253 个非零字节", Buffer.alloc(253, 0xaa));
  show("254 个非零字节", Buffer.alloc(254, 0xbb));
  show("255 个非零字节", Buffer.alloc(255, 0xcc));
  show("254 个非零字节后跟一个零", Buffer.concat([Buffer.alloc(254, 0xdd), Buffer.from([0])]));

  console.log("\n=== 分块流演示：好帧、坏帧、好帧 ===");
  const good1 = frameWire(encode(Buffer.from("hello")));
  const bad = Buffer.from([0x05, 0x10, 0x00]); // 段长 4 但只有 1 个数据字节 -> 坏帧
  const good2 = frameWire(encode(Buffer.from("world")));
  const streamBytes = Buffer.concat([good1, bad, good2]);
  console.log(`线缆字节串: ${toHex(streamBytes)}`);

  // 用多种分块方式喂入，验证结果一致
  for (const splitAt of [1, 3, 7, streamBytes.length]) {
    const parser = new FrameParser();
    const events = [
      ...parser.append(streamBytes.subarray(0, splitAt)),
      ...parser.append(streamBytes.subarray(splitAt)),
    ];
    console.log(`\n-- 分块点 ${splitAt} --`);
    for (const ev of events) {
      if (ev.type === "frame") {
        console.log(
          `帧 #${ev.frameIndex} OK  载荷=${toHex(ev.payload)} 片段=${toHex(ev.fragment)} 线缆=${toHex(ev.wire)}`
        );
      } else if (ev.type === "error") {
        console.log(
          `帧 #${ev.frameIndex} 错误 ${ev.code} @字节偏移${ev.byteOffset}: ${ev.message}`
        );
      }
    }
  }

  console.log("\n=== 截断演示（流结束时残留未终止片段） ===");
  const p2 = new FrameParser();
  p2.append(Buffer.from([0x02, 0x41]));
  for (const ev of p2.finish()) {
    if (ev.type === "truncated") {
      console.log(`STREAM_TRUNCATED 残留片段=${toHex(ev.pending)}（不自动补零）`);
    }
  }
}

if (require.main === module) runDemo();
