const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { encode, encodeFrame, decode, CobsError } = require("../dist/cobs");
const { FrameParser } = require("../dist/stream");
const { Store } = require("../dist/db");

const H = (s) => Buffer.from(s.replace(/\s+/g, ""), "hex");

// ---- 人工列出的编码向量（不依赖解码器） ----
const VECTORS = [
  ["", "01"],
  ["00", "0101"],
  ["0000", "010101"],
  ["11", "0211"],
  ["1122", "031122"],
  ["1100", "021101"],
  ["0011", "010211"],
  ["110022", "02110222"],
  ["110022 33".replace(" ",""), "0211032233"],
  ["4500002c4c79000040066f37", "024501042c4c79010540066f37"], // Wikipedia 经典向量
];

test("人工编码向量", () => {
  for (const [payloadHex, fragHex] of VECTORS) {
    assert.equal(encode(H(payloadHex)).toString("hex"), fragHex, `encode ${payloadHex}`);
    assert.equal(decode(H(fragHex)).payload.toString("hex"), payloadHex, `decode ${fragHex}`);
  }
});

test("空载荷标准编码为 01，完整帧为 0100", () => {
  assert.equal(encode(Buffer.alloc(0)).toString("hex"), "01");
  assert.equal(encodeFrame(Buffer.alloc(0)).toString("hex"), "0100");
});

test("253/254/255 非零字节边界", () => {
  const p253 = Buffer.alloc(253, 0xaa);
  const p254 = Buffer.alloc(254, 0xbb);
  const p255 = Buffer.alloc(255, 0xcc);
  const f253 = encode(p253);
  assert.equal(f253[0], 0xfe); // code = 254
  assert.equal(f253.length, 254);
  const f254 = encode(p254);
  assert.equal(f254[0], 0xff);
  assert.equal(f254.length, 255); // 规范形式：不追加 0x01
  const f255 = encode(p255);
  assert.equal(f255[0], 0xff);
  assert.equal(f255.length, 257); // FF 段 + 02 CC
  assert.equal(f255[255], 0x02);
  for (const p of [p253, p254, p255]) {
    assert.deepEqual(decode(encode(p)).payload, p);
  }
  // 载荷以 0x00 结尾再接 254 字节等组合
  const combo = Buffer.concat([H("00"), Buffer.alloc(254, 1), H("00")]);
  assert.deepEqual(decode(encode(combo)).payload, combo);
});

test("恰好以 254 个非零字节结尾：规范不追加 01，兼容形式可解码", () => {
  const p = Buffer.concat([H("00"), Buffer.alloc(254, 0x55)]);
  const canon = encode(p);
  assert.equal(canon.length, 1 + 255); // 01 + FF段
  assert.equal(canon[1], 0xff);
  // 非规范兼容形式：尾部多一个 01
  const nonCanon = Buffer.concat([canon, H("01")]);
  const d = decode(nonCanon);
  assert.deepEqual(d.payload, p);
  assert.equal(d.canonical, false);
  assert.ok(encode(d.payload).equals(canon)); // 再编码产生规范结果
});

test("解码拒绝非法片段", () => {
  assert.throws(() => decode(H("")), (e) => e.code === "EMPTY_FRAGMENT");
  assert.throws(() => decode(H("00")), (e) => e.code === "ZERO_CODE" && e.offset === 0);
  assert.throws(() => decode(H("0341")), (e) => e.code === "SEGMENT_OVERRUN" && e.offset === 0);
  assert.throws(() => decode(H("034100")), (e) => e.code === "ZERO_IN_SEGMENT" && e.offset === 2);
  assert.throws(() => decode(H("ff") ), (e) => e.code === "SEGMENT_OVERRUN");
});

test("片段与载荷长度上限分别校验", () => {
  assert.throws(() => decode(H("031122"), { maxFragmentLength: 2 }), (e) => e.code === "FRAGMENT_TOO_LONG");
  assert.throws(() => decode(encode(Buffer.alloc(10, 7)), { maxPayloadLength: 5 }), (e) => e.code === "PAYLOAD_TOO_LONG");
  assert.throws(() => encode(Buffer.alloc(10, 7), { maxPayloadLength: 5 }), (e) => e.code === "PAYLOAD_TOO_LONG");
});

test("短载荷全量往返（与朴素参考实现对照）", () => {
  // 朴素参考：按定义直接模拟，不共享编码器代码
  function refDecode(frag) {
    const out = [];
    let i = 0;
    while (i < frag.length) {
      const code = frag[i++];
      const n = code === 0xff ? 254 : code - 1;
      for (let j = 0; j < n; j++) out.push(frag[i++]);
      if (code !== 0xff && i < frag.length) out.push(0);
    }
    return Buffer.from(out);
  }
  let rng = 12345;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) % 256;
  for (let t = 0; t < 2000; t++) {
    const len = rand() % 40;
    const p = Buffer.from(Array.from({ length: len }, () => (rand() % 4 === 0 ? 0 : rand() % 255 + 1)));
    const frag = encode(p);
    assert.ok(!frag.includes(0));
    assert.deepEqual(refDecode(frag), p);
    assert.deepEqual(decode(frag).payload, p);
  }
});

// ---- 流解析 ----
const OPTS = { maxFragmentLength: 64 };

test("任意分块边界与一次输入等价", () => {
  const frames = [H("0100"), encodeFrame(H("deadbeef")), encodeFrame(Buffer.alloc(300, 9))];
  // 300 字节载荷超过 64 预算 -> 该帧应被丢弃；调整预算
  const bigOpts = { maxFragmentLength: 4096 };
  const wire = Buffer.concat(frames);
  const oneShot = new FrameParser(bigOpts);
  const expected = [...oneShot.append(wire).frames, ...(oneShot.finish() ? [oneShot.finish()] : [])];
  for (let cut = 0; cut <= wire.length; cut += 7) {
    const p = new FrameParser(bigOpts);
    const got = [];
    for (let i = 0; i < wire.length; i += cut || 1) {
      got.push(...p.append(wire.subarray(i, Math.min(i + (cut || 1), wire.length))).frames);
    }
    const tail = p.finish();
    if (tail) got.push(tail);
    assert.deepEqual(got, expected, `cut=${cut}`);
  }
});

test("空片段记为错误帧，坏帧不影响后续好帧", () => {
  const wire = Buffer.concat([encodeFrame(H("aa")), H("00"), encodeFrame(H("bb"))]); // 中间空片段
  const p = new FrameParser(OPTS);
  const frames = p.append(wire).frames;
  assert.equal(frames.length, 3);
  assert.equal(frames[0].status, "ok");
  assert.equal(frames[1].status, "error");
  assert.equal(frames[1].errorCode, "EMPTY_FRAGMENT");
  assert.equal(frames[2].status, "ok");
  assert.equal(frames[2].payloadHex, "bb");
});

test("坏帧不发布有效前缀", () => {
  const p = new FrameParser(OPTS);
  const frames = p.append(H("034100")).frames; // 0x00 是分隔符，片段 0341 段长越界
  assert.equal(frames[0].status, "error");
  assert.equal(frames[0].payloadHex, null);
  assert.equal(frames[0].errorCode, "SEGMENT_OVERRUN");
});

test("截断报告且不自动补零", () => {
  const p = new FrameParser(OPTS);
  assert.equal(p.append(H("0211")).frames.length, 0); // 无分隔符，保留
  const tail = p.finish();
  assert.equal(tail.errorCode, "TRUNCATED_FRAGMENT");
  assert.equal(tail.fragmentHex, "0211");
});

test("超长帧进入丢弃状态，尾部不误认为新帧", () => {
  const p = new FrameParser({ maxFragmentLength: 4 });
  const long = Buffer.alloc(100, 0x41); // 无分隔符的超长垃圾
  assert.equal(p.append(long).frames.length, 0);
  assert.ok(p.discarding);
  const frames = p.append(Buffer.concat([Buffer.alloc(50, 0x42), H("00"), encodeFrame(H("aa"))])).frames;
  assert.equal(frames[0].errorCode, "FRAGMENT_TOO_LONG");
  assert.equal(frames[1].status, "ok");
  assert.equal(frames[1].payloadHex, "aa");
});

// ---- SQLite 持久化与重启续算 ----
test("重启后继续追加与一次输入相同", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cobs-"));
  const dbPath = path.join(dir, "t.db");
  const wire = Buffer.concat([encodeFrame(H("010203")), encodeFrame(H("aabb")), encodeFrame(H("00"))]);
  const cut1 = 3, cut2 = 5;

  let db = new Store(dbPath);
  const id = db.createStream({ maxFragmentLength: 4096 });
  db.append(id, wire.subarray(0, cut1));
  db.close(); // 模拟重启

  db = new Store(dbPath);
  db.append(id, wire.subarray(cut1, cut2));
  db.close();

  db = new Store(dbPath);
  db.append(id, wire.subarray(cut2));
  db.finish(id);
  const frames = db.getFrames(id, 100);
  db.close();

  const p = new FrameParser({ maxFragmentLength: 4096 });
  const expected = p.append(wire).frames;
  assert.deepEqual(frames, expected);
});

test("丢弃状态跨重启恢复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cobs-"));
  const dbPath = path.join(dir, "t.db");
  let db = new Store(dbPath);
  const id = db.createStream({ maxFragmentLength: 4 });
  db.append(id, Buffer.alloc(10, 0x41)); // 进入丢弃
  db.close();
  db = new Store(dbPath);
  const r = db.append(id, Buffer.concat([H("00"), encodeFrame(H("aa"))]));
  assert.equal(r.frames[0].errorCode, "FRAGMENT_TOO_LONG");
  assert.equal(r.frames[1].payloadHex, "aa");
  db.close();
});
