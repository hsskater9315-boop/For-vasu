import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, PublicUser, Room } from '../types/chat.ts';

const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const legacyDbPath = path.join(dataDir, 'varta.db');
const dbPath = path.join(dataDir, 'forvasu.db');
if (fs.existsSync(legacyDbPath) && !fs.existsSync(dbPath)) {
  fs.renameSync(legacyDbPath, dbPath);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(legacyDbPath + suffix)) {
      fs.renameSync(legacyDbPath + suffix, dbPath + suffix);
    }
  }
}
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('channel', 'dm')),
    created_by TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    sender_display_name TEXT NOT NULL,
    sender_color TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room_created
    ON messages (room_id, created_at);
`);

function seedDefaultChannels() {
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM rooms').get() as { cnt: number };
  if (countRow.cnt > 0) return;

  const insertRoom = db.prepare(`
    INSERT INTO rooms (id, name, slug, description, type, created_by, created_at)
    VALUES (?, ?, ?, ?, 'channel', NULL, ?)
  `);

  const now = Date.now();
  insertRoom.run(
    'channel-general',
    'general',
    'general',
    'Open room for everyone signed into ForVasu',
    now,
  );
  insertRoom.run(
    'channel-random',
    'random',
    'random',
    'Casual conversations, music, and quick links',
    now + 1,
  );
  insertRoom.run(
    'channel-introductions',
    'introductions',
    'introductions',
    'Say hello when you create your account',
    now + 2,
  );
}

seedDefaultChannels();
db.prepare(
  "UPDATE rooms SET description = 'Open room for everyone signed into ForVasu' WHERE id = 'channel-general' AND description = 'Open room for everyone signed into Varta'",
).run();

interface DbUserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  avatar_color: string;
  created_at: number;
}

interface DbRoomRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  type: 'channel' | 'dm';
  created_by: string | null;
  created_at: number;
}

interface DbMessageRow {
  id: string;
  room_id: string;
  sender_id: string;
  sender_name: string;
  sender_display_name: string;
  sender_color: string;
  content: string;
  created_at: number;
}

function mapPublicUser(row: DbUserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    createdAt: row.created_at,
  };
}

function mapMessage(row: DbMessageRow): ChatMessage {
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderDisplayName: row.sender_display_name,
    senderColor: row.sender_color,
    content: row.content,
    createdAt: row.created_at,
  };
}

export function findUserByUsername(username: string): DbUserRow | undefined {
  return db
    .prepare(
      'SELECT id, username, display_name, password_hash, avatar_color, created_at FROM users WHERE username = ?',
    )
    .get(username.toLowerCase()) as DbUserRow | undefined;
}

export function findPublicUserById(userId: string): PublicUser | null {
  const row = db
    .prepare(
      'SELECT id, username, display_name, password_hash, avatar_color, created_at FROM users WHERE id = ?',
    )
    .get(userId) as DbUserRow | undefined;
  return row ? mapPublicUser(row) : null;
}

export function listAllPublicUsers(): PublicUser[] {
  const rows = db
    .prepare(
      'SELECT id, username, display_name, password_hash, avatar_color, created_at FROM users ORDER BY display_name COLLATE NOCASE ASC',
    )
    .all() as unknown as DbUserRow[];
  return rows.map(mapPublicUser);
}

export function createUser(params: {
  username: string;
  displayName: string;
  passwordHash: string;
  avatarColor: string;
}): PublicUser {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, avatar_color, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.username,
    params.displayName,
    params.passwordHash,
    params.avatarColor,
    createdAt,
  );
  return {
    id,
    username: params.username,
    displayName: params.displayName,
    avatarColor: params.avatarColor,
    createdAt,
  };
}

export function listRoomsForUser(userId: string): Room[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.id, r.name, r.slug, r.description, r.type, r.created_by, r.created_at
       FROM rooms r
       LEFT JOIN room_members rm ON rm.room_id = r.id
       WHERE r.type = 'channel' OR rm.user_id = ?
       ORDER BY r.type ASC, r.created_at ASC`,
    )
    .all(userId) as unknown as DbRoomRow[];

  return rows.map((row) => {
    if (row.type === 'channel') {
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        type: 'channel',
        createdBy: row.created_by,
        createdAt: row.created_at,
      };
    }

    const memberRows = db
      .prepare('SELECT user_id FROM room_members WHERE room_id = ?')
      .all(row.id) as Array<{ user_id: string }>;
    const memberIds = memberRows.map((m) => m.user_id);
    const otherId = memberIds.find((id) => id !== userId) ?? userId;
    const otherUser = findPublicUserById(otherId);

    return {
      id: row.id,
      name: otherUser ? otherUser.displayName : row.name,
      slug: row.slug,
      description: otherUser ? `Direct message with @${otherUser.username}` : row.description,
      type: 'dm',
      createdBy: row.created_by,
      createdAt: row.created_at,
      memberIds,
      otherUser,
    };
  });
}

export function getRoomById(roomId: string): DbRoomRow | undefined {
  return db
    .prepare('SELECT id, name, slug, description, type, created_by, created_at FROM rooms WHERE id = ?')
    .get(roomId) as DbRoomRow | undefined;
}

export function canUserAccessRoom(roomId: string, userId: string): boolean {
  const room = getRoomById(roomId);
  if (!room) return false;
  if (room.type === 'channel') return true;
  const member = db
    .prepare('SELECT 1 as ok FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(roomId, userId) as { ok: number } | undefined;
  return Boolean(member);
}

export function getRoomMemberIds(roomId: string): string[] {
  const rows = db
    .prepare('SELECT user_id FROM room_members WHERE room_id = ?')
    .all(roomId) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}

export function createChannel(params: {
  name: string;
  description: string;
  createdBy: string;
}): { room?: Room; error?: string } {
  const cleanName = params.name.trim().replace(/^#+/, '');
  if (cleanName.length < 2 || cleanName.length > 32) {
    return { error: 'Channel name must be between 2 and 32 characters.' };
  }
  const slug = cleanName
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length < 2) {
    return { error: 'Channel name must include at least 2 letters or numbers.' };
  }

  const existing = db.prepare('SELECT id FROM rooms WHERE slug = ?').get(slug) as
    | { id: string }
    | undefined;
  if (existing) {
    return { error: `Channel #${slug} already exists.` };
  }

  const id = `channel-${crypto.randomUUID()}`;
  const createdAt = Date.now();
  const description = params.description.trim().slice(0, 140) || `Channel #${slug}`;

  db.prepare(
    `INSERT INTO rooms (id, name, slug, description, type, created_by, created_at)
     VALUES (?, ?, ?, ?, 'channel', ?, ?)`,
  ).run(id, slug, slug, description, params.createdBy, createdAt);

  return {
    room: {
      id,
      name: slug,
      slug,
      description,
      type: 'channel',
      createdBy: params.createdBy,
      createdAt,
    },
  };
}

export function getOrCreateDmRoom(currentUser: PublicUser, targetUser: PublicUser): {
  room: Room;
  created: boolean;
} {
  const pair = [currentUser.id, targetUser.id].sort();
  const slug = `dm:${pair[0]}:${pair[1]}`;

  const existing = db
    .prepare('SELECT id, name, slug, description, type, created_by, created_at FROM rooms WHERE slug = ?')
    .get(slug) as DbRoomRow | undefined;

  if (existing) {
    return {
      created: false,
      room: {
        id: existing.id,
        name: targetUser.displayName,
        slug: existing.slug,
        description: `Direct message with @${targetUser.username}`,
        type: 'dm',
        createdBy: existing.created_by,
        createdAt: existing.created_at,
        memberIds: pair,
        otherUser: targetUser,
      },
    };
  }

  const id = `dm-${crypto.randomUUID()}`;
  const createdAt = Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO rooms (id, name, slug, description, type, created_by, created_at)
       VALUES (?, ?, ?, ?, 'dm', ?, ?)`,
    ).run(id, targetUser.displayName, slug, 'Direct message', currentUser.id, createdAt);

    const insertMember = db.prepare('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)');
    insertMember.run(id, currentUser.id);
    if (targetUser.id !== currentUser.id) {
      insertMember.run(id, targetUser.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    created: true,
    room: {
      id,
      name: targetUser.displayName,
      slug,
      description: `Direct message with @${targetUser.username}`,
      type: 'dm',
      createdBy: currentUser.id,
      createdAt,
      memberIds: pair,
      otherUser: targetUser,
    },
  };
}

export function listMessagesForRoom(roomId: string, limit = 100): ChatMessage[] {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const rows = db
    .prepare(
      `SELECT id, room_id, sender_id, sender_name, sender_display_name, sender_color, content, created_at
       FROM (
         SELECT id, room_id, sender_id, sender_name, sender_display_name, sender_color, content, created_at
         FROM messages
         WHERE room_id = ?
         ORDER BY created_at DESC
         LIMIT ?
       )
       ORDER BY created_at ASC`,
    )
    .all(roomId, safeLimit) as unknown as DbMessageRow[];

  return rows.map(mapMessage);
}

export function createMessage(params: {
  roomId: string;
  sender: PublicUser;
  content: string;
}): ChatMessage {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO messages (id, room_id, sender_id, sender_name, sender_display_name, sender_color, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.roomId,
    params.sender.id,
    params.sender.username,
    params.sender.displayName,
    params.sender.avatarColor,
    params.content,
    createdAt,
  );

  return {
    id,
    roomId: params.roomId,
    senderId: params.sender.id,
    senderName: params.sender.username,
    senderDisplayName: params.sender.displayName,
    senderColor: params.sender.avatarColor,
    content: params.content,
    createdAt,
  };
}

export function deleteMessageByOwner(messageId: string, userId: string): {
  deleted: boolean;
  roomId?: string;
} {
  const row = db
    .prepare('SELECT id, room_id, sender_id FROM messages WHERE id = ?')
    .get(messageId) as { id: string; room_id: string; sender_id: string } | undefined;

  if (!row || row.sender_id !== userId) {
    return { deleted: false };
  }

  db.prepare('DELETE FROM messages WHERE id = ? AND sender_id = ?').run(messageId, userId);
  return { deleted: true, roomId: row.room_id };
}
