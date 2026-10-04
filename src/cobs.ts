import { CobsError } from "./errors";

/** 编码片段长度上限（字节） */
export const MAX_FRAGMENT_LEN = 1 << 20;
/** 载荷长度上限（字节） */
export const MAX_PAYLOAD_LEN = 1 << 20;

export const RULES_VERSION = "cobs-r1";

/**
 * 规范 COBS 编码（不含帧分隔符 0x00）。
 *
 * 规范形式约定：
 * - 每段以 code 字节开头，code ∈ [1,254] 表示后跟 code-1 个非零字节，
 *   且若其后还有编码段，解码时补一个载荷零；
 * - code = 255 (0xFF) 表示后跟 254 个非零字节，且不补零；
 * - 载荷中恰好连续 254 个非零字节时总是用 0xFF 段，不在末尾追加多余的 0x01；
 *   即使 254 个非零字节后紧跟一个载荷零，也先输出 0xFF 段，再用一个 0x01 段表示该零；
 * - 空载荷编码为单个字节 0x01，完整线缆帧为 01 00。
 */
export function encode(payload: Buffer): Buffer {
  if (payload.length > MAX_PAYLOAD_LEN) {
    throw new CobsError(
      "COBS_PAYLOAD_TOO_LONG",
      `载荷长度 ${payload.length} 超过上限 ${MAX_PAYLOAD_LEN}`
    );
  }
  if (payload.length === 0) return Buffer.from([0x01]);

  const out: number[] = [];
  let i = 0;
  while (i < payload.length) {
    let runEnd = i;
    while (
      runEnd < payload.length &&
      payload[runEnd] !== 0 &&
      runEnd - i < 254
    ) {
      runEnd++;
    }
    const runLen = runEnd - i;
    if (runLen === 254) {
      // 254 个非零字节：0xFF 段，不消费可能存在的后续零
      out.push(0xff);
      for (let k = i; k < runEnd; k++) out.push(payload[k]);
      i = runEnd;
    } else {
      out.push(runLen + 1);
      for (let k = i; k < runEnd; k++) out.push(payload[k]);
      const zeroTerminated = runEnd < payload.length;
      i = runEnd + 1;
      // 载荷以零结尾时，末尾还需要一个空的 0x01 段作为终止
      if (zeroTerminated && i === payload.length) out.push(0x01);
    }
  }
  return Buffer.from(out);
}

export interface DecodeResult {
  payload: Buffer;
  /** 对解码载荷再次规范编码的结果 */
  reencoded: Buffer;
  /** 输入片段本身是否为规范形式 */
  canonical: boolean;
}

/**
 * 解码单个编码片段（不含分隔符 0x00）。
 * 兼容非规范片段（如尾部多余 0x01、可用 0xFF 却用了短码等），
 * 但拒绝：空片段、零 code、段长超过剩余字节、段内容中出现零。
 * 所有错误偏移均为片段内零基字节偏移。
 */
export function decode(fragment: Buffer): DecodeResult {
  if (fragment.length === 0) {
    throw new CobsError("COBS_EMPTY_FRAGMENT", "编码片段为空", 0);
  }
  if (fragment.length > MAX_FRAGMENT_LEN) {
    throw new CobsError(
      "COBS_FRAGMENT_TOO_LONG",
      `编码片段长度 ${fragment.length} 超过上限 ${MAX_FRAGMENT_LEN}`
    );
  }

  const out: number[] = [];
  let i = 0;
  while (i < fragment.length) {
    const code = fragment[i];
    if (code === 0) {
      throw new CobsError("COBS_ZERO_CODE", "code 字节不允许为 0", i);
    }
    const n = code === 0xff ? 254 : code - 1;
    if (i + 1 + n > fragment.length) {
      throw new CobsError(
        "COBS_SEGMENT_OVERRUN",
        `偏移 ${i} 处的段需要 ${n} 个数据字节，但片段仅剩 ${fragment.length - i - 1} 个`,
        i
      );
    }
    for (let j = 1; j <= n; j++) {
      if (fragment[i + j] === 0) {
        throw new CobsError(
          "COBS_ZERO_IN_SEGMENT",
          "段内容中出现零字节",
          i + j
        );
      }
      out.push(fragment[i + j]);
    }
    // code < 0xFF 且后面还有编码段时补一个载荷零
    if (code !== 0xff && i + 1 + n < fragment.length) out.push(0);
    i = i + 1 + n;
  }

  const payload = Buffer.from(out);
  if (payload.length > MAX_PAYLOAD_LEN) {
    throw new CobsError(
      "COBS_PAYLOAD_TOO_LONG",
      `解码载荷长度 ${payload.length} 超过上限 ${MAX_PAYLOAD_LEN}`
    );
  }
  const reencoded = encode(payload);
  return { payload, reencoded, canonical: reencoded.equals(fragment) };
}

/** 完整线缆字节串 = 编码片段 + 0x00 分隔符 */
export function frameWire(fragment: Buffer): Buffer {
  return Buffer.concat([fragment, Buffer.from([0x00])]);
}

export function toHex(buf: Buffer): string {
  return buf.toString("hex");
}

export function fromHex(hex: string): Buffer {
  const clean = hex.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new CobsError("BAD_HEX", "非法十六进制字符串");
  }
  return Buffer.from(clean, "hex");
}
