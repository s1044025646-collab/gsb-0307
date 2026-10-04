import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encode, frameWire, toHex, MAX_FRAGMENT_LEN } from "../src/cobs";
import { FrameParser, FrameEvent } from "../src/stream";
import { Store } from "../src/store";

function collect(chunks: Buffer[]): FrameEvent[] {
  const p = new FrameParser();
  const events: FrameEvent[] = [];
  for (const c of chunks) events.push(...p.append(c));
  events.push(...p.finish());
  return events;
}

test("分隔符单独一块到达；一块含多帧", () => {
  const f1 = frameWire(encode(Buffer.from("ab")));
  const f2 = frameWire(encode(Buffer.from("cd")));
  // 分块：f1 片段 | f1 分隔符 + f2 全部
  const events = collect([
    f1.subarray(0, f1.length - 1),
    Buffer.concat([f1.subarray(f1.length - 1), f2]),
  ]);
  const frames = events.filter((e) => e.type === "frame");
  assert.equal(frames.length, 2);
  assert.equal(toHex((frames[0] as { payload: Buffer }).payload), toHex(Buffer.from("ab")));
  assert.equal(toHex((frames[1] as { payload: Buffer }).payload), toHex(Buffer.from("cd")));
});

test("所有分块位置与一次输入结果一致", () => {
  const payloads = [Buffer.from("hello"), Buffer.alloc(0), Buffer.from([1, 0, 2])];
  const wire = Buffer.concat(payloads.map((p) => frameWire(encode(p))));
  const baseline = collect([wire]).map((e) => JSON.stringify(e));
  for (let split = 0; split <= wire.length; split++) {
    const got = collect([wire.subarray(0, split), wire.subarray(split)]).map((e) =>
      JSON.stringify(e)
    );
    assert.deepEqual(got, baseline, `split=${split}`);
  }
  // 逐字节喂入
  const bytewise = collect([...wire].map((b) => Buffer.from([b]))).map((e) =>
    JSON.stringify(e)
  );
  assert.deepEqual(bytewise, baseline);
});

test("空片段（连续两个零）记录为错误帧，后续帧不错位", () => {
  const good = frameWire(encode(Buffer.from("ok")));
  const events = collect([Buffer.concat([Buffer.from([0]), good])]);
  assert.equal(events[0].type, "error");
  assert.equal((events[0] as { code: string }).code, "COBS_EMPTY_FRAGMENT");
  assert.equal(events[1].type, "frame");
  assert.equal((events[1] as { frameIndex: number }).frameIndex, 1);
});

test("坏帧不影响后续好帧", () => {
  const bad = Buffer.from([0x05, 0x10, 0x00]); // 段长越界
  const good = frameWire(encode(Buffer.from("fine")));
  const events = collect([Buffer.concat([bad, good])]);
  assert.equal(events[0].type, "error");
  assert.equal((events[0] as { code: string }).code, "COBS_SEGMENT_OVERRUN");
  assert.equal(events[1].type, "frame");
  assert.ok(
    (events[1] as { payload: Buffer }).payload.equals(Buffer.from("fine"))
  );
});

test("流结束残留片段报告截断，不自动补零", () => {
  const events = collect([Buffer.from([0x02, 0x41])]);
  const trunc = events.find((e) => e.type === "truncated");
  assert.ok(trunc);
  assert.equal(toHex((trunc as { pending: Buffer }).pending), "0241");
  assert.equal(events.filter((e) => e.type === "frame").length, 0);
});

test("超长片段进入丢弃状态，分隔符后恢复，尾部不误认作新帧", () => {
  const oversized = Buffer.alloc(MAX_FRAGMENT_LEN + 100, 0x61);
  const good = frameWire(encode(Buffer.from("after")));
  const events = collect([
    oversized.subarray(0, MAX_FRAGMENT_LEN),
    oversized.subarray(MAX_FRAGMENT_LEN),
    Buffer.concat([Buffer.from([0]), good]),
  ]);
  assert.equal(events[0].type, "error");
  assert.equal((events[0] as { code: string }).code, "COBS_FRAGMENT_TOO_LONG");
  assert.equal(events[1].type, "frame");
  assert.ok((events[1] as { payload: Buffer }).payload.equals(Buffer.from("after")));
  assert.equal(events.length, 2);
});

test("丢弃状态跨块持续", () => {
  const half = Buffer.alloc(MAX_FRAGMENT_LEN, 0x61);
  const p = new FrameParser();
  assert.equal(p.append(half).length, 0);
  assert.equal(p.append(Buffer.alloc(500, 0x62)).length, 0); // 触发丢弃
  assert.equal(p.append(Buffer.alloc(500, 0x63)).length, 0); // 仍在丢弃
  const ev = p.append(Buffer.from([0x00]));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "error");
});

test("SQLite 持久化：重启续算与一次输入相同", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cobs-test-"));
  const db = path.join(dir, "t.db");
  const f1 = frameWire(encode(Buffer.from("persist")));
  const f2 = frameWire(encode(Buffer.from("ok")));
  const wire = Buffer.concat([f1, f2]);
  const split = f1.length - 1; // 分隔符跨重启边界

  const store1 = new Store(db);
  const { id } = store1.createStream();
  store1.append(id, wire.subarray(0, split));
  store1.close();

  // 模拟重启：重新打开数据库继续追加
  const store2 = new Store(db);
  store2.append(id, wire.subarray(split));
  store2.finish(id);
  const frames = store2.frames(id);
  store2.close();

  assert.equal(frames.length, 2);
  assert.equal(frames[0].payloadHex, toHex(Buffer.from("persist")));
  assert.equal(frames[1].payloadHex, toHex(Buffer.from("ok")));
  assert.equal(frames[0].streamOffset, 0);
  assert.equal(frames[1].streamOffset, f1.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("结束后拒绝继续追加；历史查询数量受限", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cobs-test-"));
  const store = new Store(path.join(dir, "t.db"));
  const { id } = store.createStream();
  store.append(id, frameWire(encode(Buffer.from("x"))));
  store.finish(id);
  assert.throws(() => store.append(id, Buffer.from([1])), /已结束/);
  assert.throws(() => store.frames(id, 1001), /超过上限/);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
