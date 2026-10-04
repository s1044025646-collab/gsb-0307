# COBS 字节封装与分块流帧还原后端

纯本地运行的 COBS（Consistent Overhead Byte Stuffing）编解码与分块流帧还原服务。
技术栈：TypeScript + Node.js（内置 `node:http` 与 `node:sqlite`，无任何第三方运行时依赖），
不需要 Docker / WSL / 外部在线服务。

只做本地编解码与流解析：**不连接串口、不实现 UDP 可靠传输、不附加 CRC 或其他校验码**。

## 环境要求

- Windows 本地，Node.js ≥ 22.5（使用了内置 `node:sqlite`，开发用的是 Node 25）
- 首次使用：`npm install`（仅安装 TypeScript 与类型定义等开发依赖）

## 常用命令

```powershell
npm run build    # 编译 TypeScript 到 dist/
npm test         # 构建并运行全部测试（node:test）
npm run demo     # 运行内置演示（空载荷、连续零、253/254/255 边界、好/坏/好帧流、截断）
npm start        # 启动 HTTP API（默认自动选择空闲端口）
```

指定端口与数据库位置：

```powershell
node dist/src/cli.js serve --port 8080 --db data/cobs.db
```

## 核心概念

三种字节串在 API/CLI 输出中始终明确区分：

- **载荷（payload）**：原始任意字节，可以含 0x00。
- **编码片段（fragment）**：COBS 编码结果，保证不含 0x00。
- **线缆字节串（wire）**：`fragment + 0x00`，即完整一帧在线路上的字节。

**0x00 是帧分隔符，不是载荷内容。** 载荷中的零全部通过 code 字节计数表达，
线缆上出现的 0x00 永远只表示“一帧结束”。

**COBS 本身不检测任意比特损坏**：它只保证帧内无零字节，不提供完整性校验。
线路噪声造成的比特翻转可能被解码成“合法但错误”的载荷，需要可靠性请在上层自行加校验。

## 编码规则（规范形式，规则版本 `cobs-r1`）

- code ∈ [1, 254]：后跟 `code - 1` 个非零字节；若其后还有编码段，解码时补一个载荷零。
- code = 255 (0xFF)：后跟 254 个非零字节，**不补零**。
- 空载荷编码为单个字节 `01`，完整帧为 `01 00`。
- 载荷中恰好连续 254 个非零字节时总是输出 `0xFF` 段，**不**在末尾追加多余的 `0x01`。
  即使这 254 个非零字节后紧跟一个载荷零，也先输出 `0xFF` 段，再用 `01 01` 表达该零
  （前一个 `01` 表示被零终止的空段，后一个 `01` 是载荷末尾零的终止段）。
- 载荷以零结尾时，末尾会多一个 `01` 终止段（例如载荷 `45 00` → 片段 `02 45 01`）。

## 解码规则

单片段解码拒绝以下情况（错误偏移一律为**片段内零基字节偏移**，不是十六进制字符位置）：

| 错误码 | 含义 |
| --- | --- |
| `COBS_EMPTY_FRAGMENT` | 空编码片段 |
| `COBS_ZERO_CODE` | code 字节为 0 |
| `COBS_SEGMENT_OVERRUN` | 段长超过片段剩余字节 |
| `COBS_ZERO_IN_SEGMENT` | 段内容中出现零字节 |
| `COBS_FRAGMENT_TOO_LONG` | 片段超过长度上限（默认 1 MiB） |
| `COBS_PAYLOAD_TOO_LONG` | 载荷超过长度上限（默认 1 MiB） |

解码兼容**非规范**片段（例如 `0xFF` 段后多跟一个 `0x01`），解码成功但
`canonical=false`，`reencodedHex` 给出规范重编码结果。
坏片段**不会**把有效前缀当作成功载荷发布——要么整段成功，要么整段报错。

## 分块流解析

- 分隔符（0x00）可以单独一块到达；一个块里可以有多帧；帧可以跨任意多块。
- 连续两个 0x00 之间的空片段记录为 `COBS_EMPTY_FRAGMENT` **错误帧**，随后继续解析，
  坏帧不会使后续好帧错位。
- 流结束（finish）时残留未终止片段报告 `STREAM_TRUNCATED`，**不自动补零**。
- 片段超过预算（1 MiB）后进入**丢弃状态**：丢弃直到下一个分隔符，
  记录 `COBS_FRAGMENT_TOO_LONG` 错误帧后恢复解析。不会无限累计内存，
  超长帧尾部也不会被误认作新帧。
- 每帧记录：帧序号、流内字节偏移、载荷、片段、线缆字节、是否规范、错误码与字节偏移。

## 持久化与重启续算

SQLite（默认 `data/cobs.db`，WAL 模式）保存：

- 流游标（已消费字节数）、待处理片段、丢弃状态、已完成帧、规则版本；
- 每次 `append` 在一个事务中原子提交（解析 + 写帧 + 更新游标）；
- 进程重启后重新打开数据库继续追加，结果与一次连续输入完全相同（有测试覆盖）。

限制：流数量 ≤ 1024，单块 ≤ 1 MiB，历史查询单次 ≤ 1000 条。

## HTTP API

`npm start` 启动（默认自动选择空闲端口并打印）。所有字节均以十六进制字符串传输。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/encode` | `{payloadHex}` → `{payloadHex, fragmentHex, wireHex}` |
| POST | `/decode` | `{fragmentHex}` → `{payloadHex, reencodedHex, canonical}` |
| POST | `/streams` | 创建解析流 → `{id}` |
| POST | `/streams/:id/append` | `{chunkHex}` → 本次产生的帧/错误事件 + 流状态 |
| POST | `/streams/:id/finish` | 结束流，报告截断 |
| GET | `/streams/:id` | 流状态（游标、待处理片段、丢弃标志、规则版本） |
| GET | `/streams/:id/frames?limit=&offset=` | 帧历史 |
| GET | `/streams/:id/export` | 导出流状态 + 全部帧（JSON） |
| GET | `/streams` | 列出所有流 |

错误响应统一为 `{ "error": { "code", "message", "byteOffset" } }`。

## CLI

```powershell
node dist/src/cli.js encode --payload 450062
node dist/src/cli.js encode --payloadFile samples/payload-zeros.bin
node dist/src/cli.js decode --fragment 02450262
node dist/src/cli.js stream-create
node dist/src/cli.js stream-append --stream 1 --chunk 02616200
node dist/src/cli.js stream-finish --stream 1
node dist/src/cli.js stream-frames --stream 1 --limit 100
node dist/src/cli.js stream-export --stream 1
node dist/src/cli.js serve --port 8080
```

输入文件（`--payloadFile` / `--chunkFile`）必须位于项目目录内，文件保持原样不被修改；
所有派生数据（SQLite 数据库）都在项目内 `data/` 目录。

## 测试说明

`npm test` 覆盖：

- 人工列出的编码向量（空载荷、单个/连续零、经典示例）；
- 253 / 254 / 255 个非零字节及“254 非零 + 零”的边界；
- 非法片段的四种拒绝与零基字节偏移；
- 非规范片段的兼容解码与规范重编码；
- 随机短载荷往返，并与一个独立的朴素参考解码器对照（不是编解码器互相证明）；
- 所有分块位置与逐字节喂入的流解析一致性；
- 空片段错误帧、坏帧后恢复、截断报告、超长帧丢弃与恢复；
- SQLite 重启续算与一次输入结果一致。

## 已知限制

- 仅本地回环（127.0.0.1）HTTP 服务，无认证，不要暴露到网络。
- `node:sqlite` 在 Node 25 仍标记为实验特性（启动时有 ExperimentalWarning），
  如需长期稳定可换成 `better-sqlite3`，接口层已隔离在 `src/store.ts`。
- 不做 CRC/校验和，不检测任意比特损坏（见上文“核心概念”）。
