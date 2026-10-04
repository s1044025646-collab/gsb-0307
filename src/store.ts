import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { FrameParser, FrameEvent } from "./stream";
import { RULES_VERSION } from "./cobs";
import { CobsError } from "./errors";

export const MAX_STREAMS = 1024;
export const MAX_HISTORY = 1000;

export interface FrameRow {
  frameIndex: number;
  type: "frame" | "error" | "truncated";
  streamOffset: number;
  payloadHex: string | null;
  fragmentHex: string | null;
  wireHex: string;
  canonical: number | null;
  errorCode: string | null;
  errorOffset: number | null;
  errorMessage: string | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS streams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cursor INTEGER NOT NULL DEFAULT 0,
        frame_count INTEGER NOT NULL DEFAULT 0,
        pending BLOB NOT NULL DEFAULT X'',
        discarding INTEGER NOT NULL DEFAULT 0,
        finished INTEGER NOT NULL DEFAULT 0,
        rules_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id INTEGER NOT NULL REFERENCES streams(id),
        frame_index INTEGER NOT NULL,
        type TEXT NOT NULL,
        stream_offset INTEGER NOT NULL,
        payload BLOB,
        fragment BLOB,
        wire BLOB NOT NULL,
        canonical INTEGER,
        error_code TEXT,
        error_offset INTEGER,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_frames_stream ON frames(stream_id, frame_index);
    `);
  }

  close() {
    this.db.close();
  }

  createStream(): { id: number } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM streams")
      .get() as { n: number };
    if (row.n >= MAX_STREAMS) {
      throw new CobsError(
        "STREAM_LIMIT_EXCEEDED",
        `流数量达到上限 ${MAX_STREAMS}`
      );
    }
    const info = this.db
      .prepare("INSERT INTO streams (rules_version) VALUES (?)")
      .run(RULES_VERSION);
    return { id: Number(info.lastInsertRowid) };
  }

  private loadStream(id: number) {
    const row = this.db
      .prepare("SELECT * FROM streams WHERE id = ?")
      .get(id) as
      | {
          id: number;
          cursor: number;
          frame_count: number;
          pending: Buffer;
          discarding: number;
          finished: number;
          rules_version: string;
        }
      | undefined;
    if (!row) throw new CobsError("STREAM_NOT_FOUND", `流 ${id} 不存在`);
    return row;
  }

  getStream(id: number) {
    const row = this.loadStream(id);
    return {
      id: row.id,
      cursor: row.cursor,
      frameCount: row.frame_count,
      pendingHex: Buffer.from(row.pending).toString("hex"),
      discarding: !!row.discarding,
      finished: !!row.finished,
      rulesVersion: row.rules_version,
    };
  }

  /** 原子提交：解析块 + 写入帧 + 更新流游标，全部在一个事务中 */
  append(id: number, chunk: Buffer): FrameEvent[] {
    const row = this.loadStream(id);
    if (row.finished) {
      throw new CobsError("STREAM_ALREADY_FINISHED", `流 ${id} 已结束`);
    }
    const parser = new FrameParser({
      pending: Buffer.from(row.pending),
      discarding: !!row.discarding,
      cursor: row.cursor,
      frameCount: row.frame_count,
    });
    const events = parser.append(chunk);
    this.commit(id, parser, events);
    return events;
  }

  finish(id: number): FrameEvent[] {
    const row = this.loadStream(id);
    if (row.finished) {
      throw new CobsError("STREAM_ALREADY_FINISHED", `流 ${id} 已结束`);
    }
    const parser = new FrameParser({
      pending: Buffer.from(row.pending),
      discarding: !!row.discarding,
      cursor: row.cursor,
      frameCount: row.frame_count,
    });
    const events = parser.finish();
    this.commit(id, parser, events, true);
    return events;
  }

  private commit(
    id: number,
    parser: FrameParser,
    events: FrameEvent[],
    finished = false
  ) {
    const state = parser.getState();
    this.db.exec("BEGIN");
    try {
      const insertFrame = this.db.prepare(`
        INSERT INTO frames
          (stream_id, frame_index, type, stream_offset, payload, fragment, wire,
           canonical, error_code, error_offset, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ev of events) {
        if (ev.type === "frame") {
          insertFrame.run(
            id, ev.frameIndex, "frame", ev.streamOffset,
            ev.payload, ev.fragment, ev.wire,
            ev.canonical ? 1 : 0, null, null, null
          );
        } else if (ev.type === "error") {
          insertFrame.run(
            id, ev.frameIndex, "error", ev.streamOffset,
            null, null, ev.wire,
            null, ev.code, ev.byteOffset, ev.message
          );
        } else {
          insertFrame.run(
            id, -1, "truncated", ev.streamOffset,
            null, ev.pending, Buffer.alloc(0),
            null, "STREAM_TRUNCATED", null,
            ev.discarded
              ? "流结束时仍处于丢弃状态（超长帧未终止）"
              : "流结束时存在未终止的片段"
          );
        }
      }
      this.db
        .prepare(
          `UPDATE streams SET cursor = ?, frame_count = ?, pending = ?,
             discarding = ?, finished = ? WHERE id = ?`
        )
        .run(
          state.cursor,
          state.frameCount,
          state.pending,
          state.discarding ? 1 : 0,
          finished ? 1 : 0,
          id
        );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  frames(id: number, limit = 100, offset = 0): FrameRow[] {
    this.loadStream(id);
    if (limit > MAX_HISTORY) {
      throw new CobsError(
        "HISTORY_LIMIT_EXCEEDED",
        `历史查询数量 ${limit} 超过上限 ${MAX_HISTORY}`
      );
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM frames WHERE stream_id = ?
         ORDER BY id LIMIT ? OFFSET ?`
      )
      .all(id, limit, offset) as unknown as Array<{
      frame_index: number;
      type: string;
      stream_offset: number;
      payload: Buffer | null;
      fragment: Buffer | null;
      wire: Buffer;
      canonical: number | null;
      error_code: string | null;
      error_offset: number | null;
      error_message: string | null;
    }>;
    return rows.map((r) => ({
      frameIndex: r.frame_index,
      type: r.type as FrameRow["type"],
      streamOffset: r.stream_offset,
      payloadHex: r.payload ? Buffer.from(r.payload).toString("hex") : null,
      fragmentHex: r.fragment ? Buffer.from(r.fragment).toString("hex") : null,
      wireHex: Buffer.from(r.wire).toString("hex"),
      canonical: r.canonical,
      errorCode: r.error_code,
      errorOffset: r.error_offset,
      errorMessage: r.error_message,
    }));
  }

  listStreams() {
    const rows = this.db
      .prepare(
        `SELECT id, cursor, frame_count, discarding, finished, rules_version, created_at
         FROM streams ORDER BY id`
      )
      .all() as unknown as Array<{
      id: number;
      cursor: number;
      frame_count: number;
      discarding: number;
      finished: number;
      rules_version: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      cursor: r.cursor,
      frameCount: r.frame_count,
      discarding: !!r.discarding,
      finished: !!r.finished,
      rulesVersion: r.rules_version,
      createdAt: r.created_at,
    }));
  }

  /** 导出流为 JSON（帧历史 + 状态） */
  exportStream(id: number) {
    return {
      stream: this.getStream(id),
      frames: this.frames(id, MAX_HISTORY),
    };
  }
}
