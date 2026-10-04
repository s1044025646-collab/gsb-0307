import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { FrameParser, FrameRecord, StreamOptions } from "./stream";
import { RULES_VERSION } from "./cobs";

export interface StreamRow {
  id: number;
  state: "open" | "finished";
  next_seq: number;
  pending_hex: string;
  discarding: number;
  rules_version: string;
  max_fragment_length: number;
  max_payload_length: number | null;
  created_at: string;
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
        state TEXT NOT NULL DEFAULT 'open',
        next_seq INTEGER NOT NULL DEFAULT 0,
        pending_hex TEXT NOT NULL DEFAULT '',
        discarding INTEGER NOT NULL DEFAULT 0,
        rules_version TEXT NOT NULL,
        max_fragment_length INTEGER NOT NULL,
        max_payload_length INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id INTEGER NOT NULL REFERENCES streams(id),
        seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        fragment_hex TEXT NOT NULL,
        payload_hex TEXT,
        canonical INTEGER,
        error_code TEXT,
        error_message TEXT,
        error_offset INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(stream_id, seq)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  countStreams(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM streams").get() as { n: number };
    return r.n;
  }

  createStream(opts: StreamOptions): number {
    const r = this.db
      .prepare(
        "INSERT INTO streams (rules_version, max_fragment_length, max_payload_length) VALUES (?, ?, ?)"
      )
      .run(RULES_VERSION, opts.maxFragmentLength, opts.maxPayloadLength ?? null);
    return Number(r.lastInsertRowid);
  }

  getStream(id: number): StreamRow | null {
    const r = this.db.prepare("SELECT * FROM streams WHERE id = ?").get(id);
    return r ? (r as unknown as StreamRow) : null;
  }

  listStreams(limit: number): StreamRow[] {
    return this.db
      .prepare("SELECT * FROM streams ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as StreamRow[];
  }

  /** 原子提交：追加块、写入完成帧、推进游标与待处理状态，同一事务。 */
  append(streamId: number, chunk: Buffer): { frames: FrameRecord[] } {
    const row = this.mustGet(streamId);
    if (row.state !== "open") throw new Error(`流 ${streamId} 已结束，不能继续追加`);
    const parser = this.parserFromRow(row);
    const { frames } = parser.append(chunk);
    this.db.exec("BEGIN");
    try {
      const ins = this.db.prepare(
        `INSERT INTO frames (stream_id, seq, status, fragment_hex, payload_hex, canonical, error_code, error_message, error_offset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const f of frames) {
        ins.run(
          streamId, f.seq, f.status, f.fragmentHex, f.payloadHex,
          f.canonical === null ? null : f.canonical ? 1 : 0,
          f.errorCode, f.errorMessage, f.errorOffset
        );
      }
      this.db
        .prepare("UPDATE streams SET next_seq = ?, pending_hex = ?, discarding = ? WHERE id = ?")
        .run(parser.nextSeq, parser.pendingFragment.toString("hex"), parser.discarding ? 1 : 0, streamId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { frames };
  }

  finish(streamId: number): FrameRecord | null {
    const row = this.mustGet(streamId);
    if (row.state !== "open") return null;
    const parser = this.parserFromRow(row);
    const tail = parser.finish();
    this.db.exec("BEGIN");
    try {
      if (tail) {
        this.db
          .prepare(
            `INSERT INTO frames (stream_id, seq, status, fragment_hex, payload_hex, canonical, error_code, error_message, error_offset)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(streamId, tail.seq, tail.status, tail.fragmentHex, tail.payloadHex, null, tail.errorCode, tail.errorMessage, tail.errorOffset);
      }
      this.db
        .prepare("UPDATE streams SET state = 'finished', next_seq = ?, pending_hex = '', discarding = 0 WHERE id = ?")
        .run(parser.nextSeq, streamId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return tail;
  }

  getFrames(streamId: number, limit: number, offset = 0): FrameRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM frames WHERE stream_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?")
      .all(streamId, limit, offset) as any[];
    return rows.map((r) => ({
      seq: r.seq,
      status: r.status,
      fragmentHex: r.fragment_hex,
      payloadHex: r.payload_hex,
      canonical: r.canonical === null ? null : !!r.canonical,
      errorCode: r.error_code,
      errorMessage: r.error_message,
      errorOffset: r.error_offset,
    }));
  }

  private parserFromRow(row: StreamRow): FrameParser {
    const parser = new FrameParser(
      {
        maxFragmentLength: row.max_fragment_length,
        maxPayloadLength: row.max_payload_length ?? undefined,
      },
      row.next_seq
    );
    // 恢复重启前状态：待处理片段与丢弃标志
    if (row.discarding) {
      // 通过内部状态恢复：追加一个超预算片段会进入丢弃态，这里直接构造
      (parser as any).state = "discarding";
    }
    if (row.pending_hex) {
      (parser as any).pending = [Buffer.from(row.pending_hex, "hex")];
      (parser as any).pendingLen = row.pending_hex.length / 2;
    }
    return parser;
  }

  private mustGet(id: number): StreamRow {
    const row = this.getStream(id);
    if (!row) throw new Error(`流 ${id} 不存在`);
    return row;
  }
}

