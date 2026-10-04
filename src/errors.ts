export type ErrorCode =
  | "COBS_ZERO_CODE"
  | "COBS_SEGMENT_OVERRUN"
  | "COBS_ZERO_IN_SEGMENT"
  | "COBS_EMPTY_FRAGMENT"
  | "COBS_FRAGMENT_TOO_LONG"
  | "COBS_PAYLOAD_TOO_LONG"
  | "COBS_CHUNK_TOO_LARGE"
  | "STREAM_TRUNCATED"
  | "STREAM_NOT_FOUND"
  | "STREAM_ALREADY_FINISHED"
  | "STREAM_LIMIT_EXCEEDED"
  | "HISTORY_LIMIT_EXCEEDED"
  | "BAD_HEX"
  | "BAD_REQUEST"
  | "NOT_FOUND";

export class CobsError extends Error {
  readonly code: ErrorCode;
  /** 零基字节偏移（不是十六进制字符位置），无位置信息时为 -1 */
  readonly byteOffset: number;

  constructor(code: ErrorCode, message: string, byteOffset = -1) {
    super(message);
    this.code = code;
    this.byteOffset = byteOffset;
  }

  toJSON() {
    return { code: this.code, message: this.message, byteOffset: this.byteOffset };
  }
}
