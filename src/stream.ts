import { decode, CobsError, DecodeOptions } from "./cobs";

export type FrameStatus = "ok" | "error";

export interface FrameRecord {
  seq: number; // 流内帧序号（含错误帧），从 0 开始
  status: FrameStatus;
  fragmentHex: string; // 原始编码片段（不含分隔符）
  payloadHex: string | null; // 成功时的载荷
  canonical: boolean | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorOffset: number | null; // 零基字节偏移
}

export interface StreamOptions extends DecodeOptions {
  maxFragmentLength: number; // 片段预算，超出进入丢弃状态
}

export interface AppendResult {
  frames: FrameRecord[]; // 本次追加完成的帧
}

type ParserState = "accumulating" | "discarding";

/** 分块流帧还原器：纯内存状态机，持久化由外层负责。 */
export class FrameParser {
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private state: ParserState = "accumulating";
  private seq = 0;
  private finished = false;

  constructor(private readonly opts: StreamOptions, startSeq = 0) {
    this.seq = startSeq;
  }

  get pendingFragment(): Buffer {
    return Buffer.concat(this.pending);
  }

  get discarding(): boolean {
    return this.state === "discarding";
  }

  get nextSeq(): number {
    return this.seq;
  }

  /** 追加一个任意边界的块，返回本块内完成的所有帧（含错误帧）。 */
  append(chunk: Buffer): AppendResult {
    if (this.finished) {
      throw new CobsError("STREAM_FINISHED", "流已结束，不能继续追加");
    }
    const frames: FrameRecord[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x00) continue;
      // 先收下分隔符之前的非零部分
      if (i > start) this.take(chunk.subarray(start, i));
      start = i + 1;
      if (this.state === "discarding") {
        // 超长帧结束：记录错误帧，恢复解析；尾部不会被误认为新帧
        frames.push(this.makeError("FRAGMENT_TOO_LONG", "编码片段超过长度预算，帧已丢弃", null, ""));
        this.state = "accumulating";
        this.pending = [];
        this.pendingLen = 0;
        continue;
      }
      const fragment = Buffer.concat(this.pending);
      this.pending = [];
      this.pendingLen = 0;
      frames.push(this.completeFragment(fragment));
    }
    if (start < chunk.length) this.take(chunk.subarray(start));
    return { frames };
  }

  private take(part: Buffer): void {
    if (this.state === "discarding") return;
    if (this.pendingLen + part.length > this.opts.maxFragmentLength) {
      // 超过片段预算：进入丢弃状态直到下一个分隔符，不无限累计内存
      this.state = "discarding";
      this.pending = [];
      this.pendingLen = 0;
      return;
    }
    this.pending.push(part);
    this.pendingLen += part.length;
  }

  private completeFragment(fragment: Buffer): FrameRecord {
    if (fragment.length === 0) {
      // 连续两个分隔符之间的空片段：明确记录为错误帧，不影响后续帧
      return this.makeError("EMPTY_FRAGMENT", "两个分隔符之间出现空编码片段", 0, "");
    }
    try {
      const { payload, canonical } = decode(fragment, this.opts);
      return {
        seq: this.seq++,
        status: "ok",
        fragmentHex: fragment.toString("hex"),
        payloadHex: payload.toString("hex"),
        canonical,
        errorCode: null,
        errorMessage: null,
        errorOffset: null,
      };
    } catch (e) {
      if (e instanceof CobsError) {
        // 坏帧整体作废：不会把有效前缀作为成功载荷发布
        return this.makeError(e.code, e.message, e.offset ?? null, fragment.toString("hex"));
      }
      throw e;
    }
  }

  private makeError(
    code: string,
    message: string,
    offset: number | null,
    fragmentHex: string
  ): FrameRecord {
    return {
      seq: this.seq++,
      status: "error",
      fragmentHex,
      payloadHex: null,
      canonical: null,
      errorCode: code,
      errorMessage: message,
      errorOffset: offset,
    };
  }

  /** 结束流：若仍有未终止片段，报告截断，不自动补零。 */
  finish(): FrameRecord | null {
    this.finished = true;
    if (this.state === "discarding") {
      this.state = "accumulating";
      return this.makeError("TRUNCATED_DISCARDED", "流结束时仍处于丢弃状态（超长帧未终止）", null, "");
    }
    if (this.pendingLen > 0) {
      const fragment = Buffer.concat(this.pending);
      this.pending = [];
      this.pendingLen = 0;
      return this.makeError(
        "TRUNCATED_FRAGMENT",
        "流结束时存在未以分隔符终止的片段（截断）",
        null,
        fragment.toString("hex")
      );
    }
    return null;
  }
}
