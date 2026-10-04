import { decode, frameWire, MAX_FRAGMENT_LEN } from "./cobs";
import { CobsError } from "./errors";

/** 单个输入块大小上限（字节） */
export const MAX_CHUNK_LEN = 1 << 20;

export type FrameEvent =
  | {
      type: "frame";
      frameIndex: number;
      streamOffset: number;
      fragment: Buffer;
      payload: Buffer;
      wire: Buffer;
      canonical: boolean;
    }
  | {
      type: "error";
      frameIndex: number;
      streamOffset: number;
      code: string;
      message: string;
      byteOffset: number;
      wire: Buffer;
    }
  | {
      type: "truncated";
      streamOffset: number;
      pending: Buffer;
      discarded: boolean;
    };

export interface ParserState {
  pending: Buffer;
  discarding: boolean;
  cursor: number;
  frameCount: number;
}

/**
 * 分块流解析器。状态可序列化，用于 SQLite 持久化与重启续算。
 *
 * - 0x00 为帧分隔符，不是载荷内容；
 * - 连续两个分隔符之间的空片段记录为 COBS_EMPTY_FRAGMENT 错误帧；
 * - 片段超过预算后进入丢弃状态，直到下一个分隔符恢复；
 * - finish 时残留未终止片段报告 STREAM_TRUNCATED，不自动补零。
 */
export class FrameParser {
  private pending: Buffer;
  private discarding: boolean;
  private cursor: number;
  private frameCount: number;

  constructor(state?: Partial<ParserState>) {
    this.pending = state?.pending ?? Buffer.alloc(0);
    this.discarding = state?.discarding ?? false;
    this.cursor = state?.cursor ?? 0;
    this.frameCount = state?.frameCount ?? 0;
  }

  getState(): ParserState {
    return {
      pending: this.pending,
      discarding: this.discarding,
      cursor: this.cursor,
      frameCount: this.frameCount,
    };
  }

  append(chunk: Buffer): FrameEvent[] {
    if (chunk.length > MAX_CHUNK_LEN) {
      throw new CobsError(
        "COBS_CHUNK_TOO_LARGE",
        `块大小 ${chunk.length} 超过上限 ${MAX_CHUNK_LEN}`
      );
    }
    const events: FrameEvent[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0) continue;
      const piece = chunk.subarray(start, i);
      // 帧起始偏移需减去上一块遗留下来的 pending 字节数
      const streamOffset = this.cursor + start - this.pending.length;
      if (this.discarding) {
        events.push({
          type: "error",
          frameIndex: this.frameCount++,
          streamOffset,
          code: "COBS_FRAGMENT_TOO_LONG",
          message: `编码片段超过上限 ${MAX_FRAGMENT_LEN}，已丢弃至分隔符`,
          byteOffset: MAX_FRAGMENT_LEN,
          wire: Buffer.from([0]),
        });
        this.discarding = false;
        this.pending = Buffer.alloc(0);
      } else {
        const fragment = Buffer.concat([this.pending, piece]);
        this.pending = Buffer.alloc(0);
        events.push(this.delimit(fragment, streamOffset));
      }
      start = i + 1;
    }
    const rest = chunk.subarray(start);
    if (rest.length > 0 && !this.discarding) {
      const next = Buffer.concat([this.pending, rest]);
      if (next.length > MAX_FRAGMENT_LEN) {
        this.discarding = true;
        this.pending = Buffer.alloc(0);
      } else {
        this.pending = next;
      }
    }
    this.cursor += chunk.length;
    return events;
  }

  private delimit(fragment: Buffer, streamOffset: number): FrameEvent {
    const frameIndex = this.frameCount++;
    const wire = frameWire(fragment);
    try {
      const { payload, canonical } = decode(fragment);
      return {
        type: "frame",
        frameIndex,
        streamOffset,
        fragment,
        payload,
        wire,
        canonical,
      };
    } catch (err) {
      const e = err as CobsError;
      return {
        type: "error",
        frameIndex,
        streamOffset,
        code: e.code ?? "BAD_REQUEST",
        message: e.message,
        byteOffset: e.byteOffset ?? -1,
        wire,
      };
    }
  }

  /** 结束流：残留未终止片段报告截断，不自动补零 */
  finish(): FrameEvent[] {
    const events: FrameEvent[] = [];
    if (this.pending.length > 0 || this.discarding) {
      events.push({
        type: "truncated",
        streamOffset: this.cursor - this.pending.length,
        pending: this.pending,
        discarded: this.discarding,
      });
      this.pending = Buffer.alloc(0);
      this.discarding = false;
    }
    return events;
  }
}
