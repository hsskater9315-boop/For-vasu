export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  createdAt: number;
}

export interface Room {
  id: string;
  name: string;
  slug: string;
  description: string;
  type: 'channel' | 'dm';
  createdBy: string | null;
  createdAt: number;
  memberIds?: string[];
  otherUser?: PublicUser | null;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  senderDisplayName: string;
  senderColor: string;
  content: string;
  createdAt: number;
  pending?: boolean;
  failed?: boolean;
  clientMessageId?: string;
}

export type ClientWsEvent =
  | { type: 'auth'; token: string }
  | { type: 'room:join'; roomId: string }
  | { type: 'message:send'; roomId: string; content: string; clientMessageId: string }
  | { type: 'typing:start'; roomId: string }
  | { type: 'typing:stop'; roomId: string }
  | { type: 'message:delete'; messageId: string };

export type ServerWsEvent =
  | { type: 'auth:ok'; userId: string; onlineUserIds: string[] }
  | { type: 'auth:error'; message: string }
  | { type: 'room:history'; roomId: string; messages: ChatMessage[] }
  | { type: 'message:created'; message: ChatMessage; clientMessageId?: string }
  | { type: 'message:deleted'; roomId: string; messageId: string }
  | { type: 'room:created'; room: Room }
  | { type: 'user:registered'; user: PublicUser }
  | { type: 'presence:update'; onlineUserIds: string[] }
  | {
      type: 'typing:update';
      roomId: string;
      userId: string;
      displayName: string;
      isTyping: boolean;
    }
  | { type: 'error'; message: string };
