import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode, frameWire, fromHex, toHex } from "../src/cobs";
import { CobsError } from "../src/errors";

// 人工列出的编码向量（来源：COBS 论文/维基百科经典示例 + 手工边界推导）
const VECTORS: Array<[string, string]> = [
  ["", "01"],
  ["00", "0101"],
  ["0000", "010101"],
  ["45", "0245"],
  ["4562", "034562"],
  ["450062", "02450262"],
  ["45000062", "0245010262"],
  ["4500000062", "024501010262"],
  ["0102030405", "060102030405"],
  ["01000203", "0201030203"], // 01 00 02 03 -> 02 01 | 03 02 03
];

test("人工向量：编码", () => {
  for (const [payload, fragment] of VECTORS) {
    assert.equal(
      toHex(encode(fromHex(payload))),
      fragment,
      `encode(${payload})`
    );
  }
});

test("人工向量：解码", () => {
  for (const [payload, fragment] of VECTORS) {
    assert.equal(
      toHex(decode(fromHex(fragment)).payload),
      payload,
      `decode(${fragment})`
    );
  }
});

test("空载荷帧为 01 00", () => {
  assert.equal(toHex(frameWire(encode(Buffer.alloc(0)))), "0100");
});

test("边界：253/254/255 个非零字节", () => {
  const p253 = Buffer.alloc(253, 0xaa);
  const f253 = encode(p253);
  assert.equal(f253[0], 0xfe); // code = 254
  assert.equal(f253.length, 254);

  const p254 = Buffer.alloc(254, 0xbb);
  const f254 = encode(p254);
  assert.equal(f254[0], 0xff);
  assert.equal(f254.length, 255); // 恰好 254 个非零字节：0xFF 段，不追加 0x01

  const p255 = Buffer.alloc(255, 0xcc);
  const f255 = encode(p255);
  assert.equal(f255[0], 0xff);
  assert.equal(f255.length, 257); // 0xFF 段 + 一个 0x02 段
  assert.equal(f255[255], 0x02);

  // 254 个非零字节后跟一个零：0xFF 段 + 01 段 + 末尾终止 01 段
  const p254z = Buffer.concat([Buffer.alloc(254, 0xdd), Buffer.from([0])]);
  const f254z = encode(p254z);
  assert.equal(f254z.length, 257);
  assert.equal(f254z[255], 0x01);
  assert.equal(f254z[256], 0x01);

  for (const p of [p253, p254, p255, p254z]) {
    assert.ok(decode(encode(p)).payload.equals(p));
  }
});

test("解码拒绝非法片段，偏移为零基字节偏移", () => {
  assert.throws(() => decode(Buffer.alloc(0)), (e: CobsError) => e.code === "COBS_EMPTY_FRAGMENT");
  assert.throws(
    () => decode(fromHex("00")),
    (e: CobsError) => e.code === "COBS_ZERO_CODE" && e.byteOffset === 0
  );
  assert.throws(
    () => decode(fromHex("0510")), // 需要 4 个数据字节但只有 1 个
    (e: CobsError) => e.code === "COBS_SEGMENT_OVERRUN" && e.byteOffset === 0
  );
  assert.throws(
    () => decode(fromHex("034100")), // 段内容偏移 2 处出现零
    (e: CobsError) => e.code === "COBS_ZERO_IN_SEGMENT" && e.byteOffset === 2
  );
});

test("兼容非规范片段，重编码产生规范形式", () => {
  // 0xFF 段后多跟一个 0x01 段（非规范；规范形式不含尾部 0x01）
  const nonCanonical = Buffer.concat([
    Buffer.from([0xff]),
    Buffer.alloc(254, 0x77),
    Buffer.from([0x01]),
  ]);
  const r = decode(nonCanonical);
  assert.equal(r.payload.length, 254);
  assert.equal(r.canonical, false);
  assert.equal(r.reencoded[0], 0xff);
  assert.equal(r.reencoded.length, 255);
});

test("随机短载荷往返 + 与朴素参考实现对照", () => {
  // 朴素参考解码器（独立逻辑，避免编解码器互相证明）
  function refDecode(frag: Buffer): Buffer {
    const out: number[] = [];
    let i = 0;
    while (i < frag.length) {
      const code = frag[i];
      for (let j = 1; j < code && j <= 254; j++) out.push(frag[i + j]);
      i += code === 0xff ? 255 : code;
      if (code < 0xff && i < frag.length) out.push(0);
    }
    return Buffer.from(out);
  }
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let t = 0; t < 2000; t++) {
    const len = rand() % 40;
    const payload = Buffer.from(
      Array.from({ length: len }, () => (rand() % 4 === 0 ? 0 : rand() % 255 + 1))
    );
    const frag = encode(payload);
    assert.ok(!frag.includes(0), "编码片段不得含零字节");
    assert.ok(decode(frag).payload.equals(payload));
    assert.ok(refDecode(frag).equals(payload), `参考实现不一致: ${toHex(payload)}`);
  }
});

test("载荷长度上限校验", () => {
  const big = Buffer.alloc((1 << 20) + 1, 1);
  assert.throws(() => encode(big), (e: CobsError) => e.code === "COBS_PAYLOAD_TOO_LONG");
});
