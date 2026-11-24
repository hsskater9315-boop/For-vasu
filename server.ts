import 'dotenv/config';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import {
  hashPassword,
  pickAvatarColor,
  signAuthToken,
  validatePassword,
  validateUsername,
  verifyAuthToken,
  verifyPassword,
} from './src/server/auth.ts';
import {
  canUserAccessRoom,
  createChannel,
  createMessage,
  createUser,
  deleteMessageByOwner,
  findPublicUserById,
  findUserByUsername,
  getOrCreateDmRoom,
  getRoomById,
  getRoomMemberIds,
  listAllPublicUsers,
  listMessagesForRoom,
  listRoomsForUser,
} from './src/server/db.ts';
import type { ClientWsEvent, PublicUser, Room, ServerWsEvent } from './src/types/chat.ts';

interface AuthenticatedRequest extends Request {
  user?: PublicUser;
}

interface ConnectedClient {
  ws: WebSocket;
  user: PublicUser;
  activeRoomId: string | null;
  isAlive: boolean;
}

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clients = new Map<WebSocket, ConnectedClient>();

function getOnlineUserIds(): string[] {
  const ids = new Set<string>();
  for (const client of clients.values()) {
    ids.add(client.user.id);
  }
  return Array.from(ids);
}

function sendEvent(ws: WebSocket, event: ServerWsEvent) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function broadcastAll(event: ServerWsEvent) {
  const payload = JSON.stringify(event);
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

function broadcastToRoom(roomId: string, event: ServerWsEvent, excludeWs?: WebSocket) {
  const room = getRoomById(roomId);
  if (!room) return;
  const memberSet = room.type === 'dm' ? new Set(getRoomMemberIds(roomId)) : null;
  const payload = JSON.stringify(event);

  for (const client of clients.values()) {
    if (excludeWs && client.ws === excludeWs) continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (memberSet && !memberSet.has(client.user.id)) continue;
    client.ws.send(payload);
  }
}

function broadcastPresence() {
  broadcastAll({
    type: 'presence:update',
    onlineUserIds: getOnlineUserIds(),
  });
}

function formatDmRoomForRecipient(room: Room, recipientId: string): Room {
  if (room.type !== 'dm' || !room.memberIds) return room;
  const otherId = room.memberIds.find((id) => id !== recipientId) ?? recipientId;
  const otherUser = findPublicUserById(otherId);
  return {
    ...room,
    name: otherUser ? otherUser.displayName : room.name,
    description: otherUser ? `Direct message with @${otherUser.username}` : room.description,
    otherUser,
  };
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const payload = verifyAuthToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    return;
  }

  const user = findPublicUserById(payload.userId);
  if (!user) {
    res.status(401).json({ error: 'Account not found.' });
    return;
  }

  req.user = user;
  next();
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const usernameCheck = validateUsername(req.body?.username);
    if (!usernameCheck.ok || !usernameCheck.username || !usernameCheck.displayName) {
      res.status(400).json({ error: usernameCheck.error });
      return;
    }

    const passwordCheck = validatePassword(req.body?.password);
    if (!passwordCheck.ok || !passwordCheck.password) {
      res.status(400).json({ error: passwordCheck.error });
      return;
    }

    const existing = findUserByUsername(usernameCheck.username);
    if (existing) {
      res.status(409).json({ error: 'That username is already taken. Try logging in or pick another.' });
      return;
    }

    const passwordHash = await hashPassword(passwordCheck.password);
    const avatarColor = pickAvatarColor(usernameCheck.username);
    const user = createUser({
      username: usernameCheck.username,
      displayName: usernameCheck.displayName,
      passwordHash,
      avatarColor,
    });

    const token = signAuthToken(user.id, user.username);
    broadcastAll({ type: 'user:registered', user });

    res.status(201).json({ token, user });
  } catch {
    res.status(500).json({ error: 'Could not create account. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const usernameCheck = validateUsername(req.body?.username);
    if (!usernameCheck.ok || !usernameCheck.username) {
      res.status(400).json({ error: 'Enter a valid username and password.' });
      return;
    }

    const passwordRaw = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!passwordRaw) {
      res.status(400).json({ error: 'Password is required.' });
      return;
    }

    const userRow = findUserByUsername(usernameCheck.username);
    if (!userRow) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    const matches = await verifyPassword(passwordRaw, userRow.password_hash);
    if (!matches) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    const user: PublicUser = {
      id: userRow.id,
      username: userRow.username,
      displayName: userRow.display_name,
      avatarColor: userRow.avatar_color,
      createdAt: userRow.created_at,
    };
    const token = signAuthToken(user.id, user.username);
    res.json({ token, user });
  } catch {
    res.status(500).json({ error: 'Could not sign in. Please try again.' });
  }
});

app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

app.get('/api/bootstrap', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const rooms = listRoomsForUser(user.id);
  const users = listAllPublicUsers();
  const onlineUserIds = getOnlineUserIds();
  res.json({ rooms, users, onlineUserIds });
});

app.get('/api/rooms/:roomId/messages', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const roomId = String(req.params.roomId || '');
  if (!canUserAccessRoom(roomId, user.id)) {
    res.status(403).json({ error: 'You do not have access to this conversation.' });
    return;
  }
  const messages = listMessagesForRoom(roomId, 100);
  res.json({ messages });
});

app.post('/api/rooms', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  const description = typeof req.body?.description === 'string' ? req.body.description : '';

  const result = createChannel({
    name,
    description,
    createdBy: user.id,
  });

  if (result.error || !result.room) {
    res.status(400).json({ error: result.error || 'Could not create channel.' });
    return;
  }

  broadcastAll({ type: 'room:created', room: result.room });
  res.status(201).json({ room: result.room });
});

app.post('/api/dm', requireAuth, (req: AuthenticatedRequest, res) => {
  const currentUser = req.user!;
  const targetUserId = typeof req.body?.targetUserId === 'string' ? req.body.targetUserId.trim() : '';
  if (!targetUserId) {
    res.status(400).json({ error: 'Target user is required.' });
    return;
  }

  const targetUser = findPublicUserById(targetUserId);
  if (!targetUser) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const { room, created } = getOrCreateDmRoom(currentUser, targetUser);
  if (created) {
    for (const client of clients.values()) {
      if (client.user.id === currentUser.id || client.user.id === targetUser.id) {
        sendEvent(client.ws, {
          type: 'room:created',
          room: formatDmRoomForRecipient(room, client.user.id),
        });
      }
    }
  }

  res.status(created ? 201 : 200).json({ room });
});

app.delete('/api/messages/:messageId', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  const messageId = String(req.params.messageId || '');
  const result = deleteMessageByOwner(messageId, user.id);
  if (!result.deleted || !result.roomId) {
    res.status(404).json({ error: 'Message not found or not authorized to delete.' });
    return;
  }
  broadcastToRoom(result.roomId, {
    type: 'message:deleted',
    roomId: result.roomId,
    messageId,
  });
  res.json({ deleted: true });
});

wss.on('connection', (ws) => {
  let authedClient: ConnectedClient | null = null;

  ws.on('pong', () => {
    if (authedClient) {
      authedClient.isAlive = true;
    }
  });

  ws.on('message', (rawData) => {
    let event: ClientWsEvent;
    try {
      event = JSON.parse(rawData.toString('utf8')) as ClientWsEvent;
    } catch {
      sendEvent(ws, { type: 'error', message: 'Malformed WebSocket message.' });
      return;
    }

    if (event.type === 'auth') {
      const payload = verifyAuthToken(event.token);
      if (!payload) {
        sendEvent(ws, { type: 'auth:error', message: 'Invalid or expired session.' });
        ws.close(4001, 'Unauthorized');
        return;
      }

      const user = findPublicUserById(payload.userId);
      if (!user) {
        sendEvent(ws, { type: 'auth:error', message: 'Account not found.' });
        ws.close(4001, 'Unauthorized');
        return;
      }

      authedClient = {
        ws,
        user,
        activeRoomId: null,
        isAlive: true,
      };
      clients.set(ws, authedClient);

      sendEvent(ws, {
        type: 'auth:ok',
        userId: user.id,
        onlineUserIds: getOnlineUserIds(),
      });
      broadcastPresence();
      return;
    }

    if (!authedClient) {
      sendEvent(ws, { type: 'auth:error', message: 'Authenticate before sending events.' });
      return;
    }

    if (event.type === 'room:join') {
      if (!canUserAccessRoom(event.roomId, authedClient.user.id)) {
        sendEvent(ws, { type: 'error', message: 'Access denied to this conversation.' });
        return;
      }
      authedClient.activeRoomId = event.roomId;
      const messages = listMessagesForRoom(event.roomId, 100);
      sendEvent(ws, { type: 'room:history', roomId: event.roomId, messages });
      return;
    }

    if (event.type === 'message:send') {
      const content = typeof event.content === 'string' ? event.content.trim() : '';
      if (!content || content.length > 2000) {
        sendEvent(ws, {
          type: 'error',
          message: 'Message must be between 1 and 2000 characters.',
        });
        return;
      }

      if (!canUserAccessRoom(event.roomId, authedClient.user.id)) {
        sendEvent(ws, { type: 'error', message: 'Access denied to this conversation.' });
        return;
      }

      const freshUser = findPublicUserById(authedClient.user.id) ?? authedClient.user;
      const message = createMessage({
        roomId: event.roomId,
        sender: freshUser,
        content,
      });

      broadcastToRoom(event.roomId, {
        type: 'message:created',
        message,
        clientMessageId: event.clientMessageId,
      });
      return;
    }

    if (event.type === 'typing:start' || event.type === 'typing:stop') {
      if (!canUserAccessRoom(event.roomId, authedClient.user.id)) return;
      broadcastToRoom(
        event.roomId,
        {
          type: 'typing:update',
          roomId: event.roomId,
          userId: authedClient.user.id,
          displayName: authedClient.user.displayName,
          isTyping: event.type === 'typing:start',
        },
        ws,
      );
      return;
    }

    if (event.type === 'message:delete') {
      const result = deleteMessageByOwner(event.messageId, authedClient.user.id);
      if (result.deleted && result.roomId) {
        broadcastToRoom(result.roomId, {
          type: 'message:deleted',
          roomId: result.roomId,
          messageId: event.messageId,
        });
      }
    }
  });

  ws.on('close', () => {
    if (authedClient) {
      if (authedClient.activeRoomId) {
        broadcastToRoom(
          authedClient.activeRoomId,
          {
            type: 'typing:update',
            roomId: authedClient.activeRoomId,
            userId: authedClient.user.id,
            displayName: authedClient.user.displayName,
            isTyping: false,
          },
          ws,
        );
      }
      clients.delete(ws);
      broadcastPresence();
    }
  });
});

const heartbeatInterval = setInterval(() => {
  for (const [ws, client] of clients.entries()) {
    if (!client.isAlive) {
      clients.delete(ws);
      ws.terminate();
      broadcastPresence();
      continue;
    }
    client.isAlive = false;
    ws.ping();
  }
}, 30_000);

server.on('close', () => {
  clearInterval(heartbeatInterval);
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
    return;
  }
  if (isProduction) {
    socket.destroy();
  }
});

async function startServer() {
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Application build not found.');
      }
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ForVasu server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
