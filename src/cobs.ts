/** COBS 核心编解码（自实现，不使用任何现成 COBS 库）。
 *
 * 规则（规则版本 RULES_VERSION）：
 * - code 字节 0x01..0xFE：后跟 code-1 个非零字节；若该段之后仍有编码段，载荷中补一个 0x00。
 * - code 字节 0xFF：后跟 254 个非零字节，不补零。
 * - 编码采用规范形式：按顺序取最长不超过 254 的非零段；
 *   载荷以 0x00 分隔；空载荷编码为单个 0x01。
 * - 边界公开说明：当载荷恰好以 254 个非零字节结尾时，最后一段为 0xFF 段，
 *   规范形式【不】再追加额外的 0x01 段（追加 0x01 是兼容的非规范形式，解码结果相同）。
 * - 分隔符 0x00 只出现在帧边界，不属于编码片段，也不属于载荷。
 */

export const RULES_VERSION = "cobs-canonical-v1";

export const MAX_CODE = 0xff;
export const MAX_BLOCK_DATA = 254; // 0xFF 段携带的非零字节数

export class CobsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly offset?: number // 零基字节偏移（不是十六进制字符位置）
  ) {
    super(message);
    this.name = "CobsError";
  }
}

export interface EncodeOptions {
  maxPayloadLength?: number; // 载荷长度上限（字节）
}

export interface DecodeOptions {
  maxFragmentLength?: number; // 编码片段长度上限（字节）
  maxPayloadLength?: number; // 解码后载荷长度上限（字节）
}

/** 规范 COBS 编码：输入任意载荷，输出不含 0x00 的编码片段（不含分隔符）。 */
export function encode(payload: Buffer, opts: EncodeOptions = {}): Buffer {
  if (opts.maxPayloadLength !== undefined && payload.length > opts.maxPayloadLength) {
    throw new CobsError(
      "PAYLOAD_TOO_LONG",
      `载荷长度 ${payload.length} 超过上限 ${opts.maxPayloadLength}`,
      opts.maxPayloadLength
    );
  }
  const out: number[] = [];
  let codeIndex = 0; // 当前段 code 字节在 out 中的位置
  out.push(0); // 占位
  let blockLen = 0;
  for (let i = 0; i < payload.length; i++) {
    const b = payload[i];
    if (b !== 0x00) {
      out.push(b);
      blockLen++;
      if (blockLen === MAX_BLOCK_DATA) {
        out[codeIndex] = MAX_CODE; // 0xFF 段，不补零
        codeIndex = out.length;
        out.push(0);
        blockLen = 0;
      }
    } else {
      out[codeIndex] = blockLen + 1;
      codeIndex = out.length;
      out.push(0);
      blockLen = 0;
    }
  }
  out[codeIndex] = blockLen + 1;
  // 规范形式：若最后一个 0xFF 段之后没有任何数据（占位 code 为 0x01 且位于末尾），去掉多余的 0x01。
  // 即载荷恰好以 254 个非零字节结尾时，不以额外 0x01 收尾。
  if (out.length > 1 && out[out.length - 1] === 0x01 && out[codeIndex - MAX_BLOCK_DATA - 1] === MAX_CODE) {
    out.pop();
  }
  return Buffer.from(out);
}

/** 编码 + 帧分隔符：完整线缆字节串 = 编码片段 + 0x00。 */
export function encodeFrame(payload: Buffer, opts: EncodeOptions = {}): Buffer {
  return Buffer.concat([encode(payload, opts), Buffer.from([0x00])]);
}

export interface DecodeResult {
  payload: Buffer;
  canonical: boolean; // 该片段是否已是规范形式（再编码应逐字节一致）
}

/** 单片段解码。片段中不得包含 0x00。允许兼容的非规范片段。 */
export function decode(fragment: Buffer, opts: DecodeOptions = {}): DecodeResult {
  if (fragment.length === 0) {
    throw new CobsError("EMPTY_FRAGMENT", "编码片段为空", 0);
  }
  if (opts.maxFragmentLength !== undefined && fragment.length > opts.maxFragmentLength) {
    throw new CobsError(
      "FRAGMENT_TOO_LONG",
      `编码片段长度 ${fragment.length} 超过上限 ${opts.maxFragmentLength}`,
      opts.maxFragmentLength
    );
  }
  const out: number[] = [];
  let i = 0;
  while (i < fragment.length) {
    const code = fragment[i];
    if (code === 0x00) {
      throw new CobsError("ZERO_CODE", "code 字节为 0x00（片段中不允许出现零字节）", i);
    }
    const dataLen = code === MAX_CODE ? MAX_BLOCK_DATA : code - 1;
    if (i + 1 + dataLen > fragment.length) {
      throw new CobsError(
        "SEGMENT_OVERRUN",
        `段声明长度 ${dataLen} 超过剩余片段长度 ${fragment.length - i - 1}`,
        i
      );
    }
    for (let j = 0; j < dataLen; j++) {
      const b = fragment[i + 1 + j];
      if (b === 0x00) {
        throw new CobsError("ZERO_IN_SEGMENT", "段内容中出现 0x00 字节", i + 1 + j);
      }
      out.push(b);
    }
    i += 1 + dataLen;
    const isLast = i === fragment.length;
    if (code !== MAX_CODE && !isLast) {
      out.push(0x00); // 后续仍有编码段，补一个载荷零
    }
    if (opts.maxPayloadLength !== undefined && out.length > opts.maxPayloadLength) {
      throw new CobsError(
        "PAYLOAD_TOO_LONG",
        `解码载荷长度超过上限 ${opts.maxPayloadLength}`,
        i
      );
    }
  }
  const payload = Buffer.from(out);
  const canonical = encode(payload).equals(fragment);
  return { payload, canonical };
}
