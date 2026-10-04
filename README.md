# COBS 字节封装与分块流帧还原后端

纯本地后端：TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生编译依赖）。只做 COBS 编解码与分块流帧解析，提供 HTTP API 与 CLI。**不连接串口、不实现 UDP 可靠传输、不附加 CRC 或其他校验码。**

## 概念与约定

- **载荷（payload）**：任意原始字节。
- **编码片段（fragment）**：COBS 编码结果，保证不含 `0x00`。
- **线缆字节串（wire）**：`fragment + 0x00`，`0x00` 是帧结束分隔符。
- **分隔符 `0x00` 只属于帧边界，不是载荷内容**；流中两个分隔符之间即一个编码片段。
- **COBS 本身不检测任意比特损坏**：线缆上的比特错误可能解码出错误载荷而不报错，需要完整性保证时请在上层自行加校验（本项目不附加）。

### code 字节规则（规则版本 `cobs-canonical-v1`）

- code `0x01..0xFE`：后跟 `code-1` 个非零字节；若该段之后仍有编码段，载荷中补一个 `0x00`。
- code `0xFF`：后跟 254 个非零字节，**不**补零。
- 编码为确定的规范形式：顺序取最长不超过 254 的非零段。
- **边界公开说明**：载荷恰好以 254 个非零字节结尾时，最后一段为 `0xFF` 段，规范形式**不再追加** `0x01`；追加 `0x01` 是兼容的非规范形式，解码结果相同，再编码会回到规范形式。
- 空载荷标准编码为 `01`，完整帧为 `01 00`。

### 错误与限制

- 单片段解码拒绝：空片段（`EMPTY_FRAGMENT`）、零 code（`ZERO_CODE`）、段长超过剩余（`SEGMENT_OVERRUN`）、段内容含零（`ZERO_IN_SEGMENT`）。
- 错误位置为**零基字节偏移**，不是十六进制字符位置。
- 片段长度上限（`FRAGMENT_TOO_LONG`）与载荷长度上限（`PAYLOAD_TOO_LONG`）分别校验。
- 坏帧整体作废，**不会**把有效前缀作为成功载荷发布。
- 流解析：分隔符前保留未完成片段；连续两个 `0x00` 之间的空片段记为错误帧（`EMPTY_FRAGMENT`）后继续；流结束时残留片段报告截断（`TRUNCATED_FRAGMENT`），不自动补零；超过片段预算进入丢弃状态直到下一个分隔符（`FRAGMENT_TOO_LONG`），不无限累计内存，超长帧尾部不会被误认为新帧。
- 服务限制：流数量、块大小、历史返回数量均可配置（见 `src/server.ts` 的 `DEFAULT_CONFIG`）。

## 目录

- `src/cobs.ts` COBS 编解码核心（自实现，未使用任何现成 COBS 库）
- `src/stream.ts` 分块流帧还原状态机
- `src/db.ts` SQLite 持久化（流游标、待处理片段/丢弃状态、已完成帧、规则版本；追加原子提交）
- `src/server.ts` HTTP API；`src/cli.ts` 命令行；`src/demo.ts` 演示
- `test/cobs.test.cjs` 测试（人工向量 + 参考实现对照 + 流解析 + 重启续算）
- `samples/` 二进制样例；`data/` 运行期数据目录（派生数据全部留在项目内）

## 命令

```powershell
npm install        # 安装开发依赖（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务（默认自动选择空闲端口，127.0.0.1）
npm run demo       # 运行演示（空载荷、连续零、253/254/255 边界、好坏好帧流）
```

CLI（`node dist/cli.js <命令>`）：

```powershell
node dist/cli.js encode 110000220033              # 输出 payloadHex / fragmentHex / wireHex
node dist/cli.js encode @samples/payload-zeros.bin # 从项目内二进制文件导入
node dist/cli.js decode 02110102220233
node dist/cli.js stream-create                    # 创建解析流，返回 streamId
node dist/cli.js append 1 0668656c6c6f00          # 追加一个块（任意边界）
node dist/cli.js finish 1                         # 结束流（残留片段报告截断）
node dist/cli.js frames 1                         # 查看帧与诊断
node dist/cli.js export 1                         # 导出流与全部帧
node dist/cli.js serve 8080                       # 指定端口；省略则自动选空闲端口
```

环境变量：`COBS_PORT`（端口）、`COBS_DATA_DIR`（数据目录，默认 `./data`）。

## HTTP API

均返回 JSON；错误为 `{ "error": { "code", "message", "offset" } }`。

- `POST /api/encode` `{payloadHex}` 返回 `{payloadHex, fragmentHex, wireHex}`
- `POST /api/decode` `{fragmentHex}` 返回 `{fragmentHex, payloadHex, canonical}`
- `POST /api/streams` 返回 `{streamId}`；`GET /api/streams` 列表
- `POST /api/streams/:id/append` `{chunkHex}` 返回 `{frames}`（本次完成的帧）
- `POST /api/streams/:id/finish` 返回 `{tail}`（截断诊断或 null）
- `GET /api/streams/:id`、`GET /api/streams/:id/frames?limit=&offset=`、`GET /api/streams/:id/export`
- `GET /health`

SQLite 中保存流游标（`next_seq`）、待处理片段（`pending_hex`）、丢弃状态（`discarding`）与规则版本；每次追加在同一事务内写入帧并推进游标，**重启后继续追加与一次输入结果相同**（有测试覆盖）。

## 测试说明

- 人工列出的编码向量核对关键边界（空载荷、连续零、253/254/255 非零字节、恰好 254 结尾的规范形式），不是编码器解码器互相证明；随机短载荷另与独立的朴素参考解码实现对照。
- 流解析：所有切分位置与一次输入等价；空片段错误帧；坏帧不错位后续好帧；截断报告；超长帧丢弃与恢复。
- 持久化：重启续算、丢弃状态跨重启恢复。
