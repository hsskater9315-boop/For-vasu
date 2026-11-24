import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import {
  ArrowDown,
  Check,
  Copy,
  Hash,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  Search,
  Send,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type {
  ChatMessage,
  ClientWsEvent,
  PublicUser,
  Room,
  ServerWsEvent,
} from '../types/chat';
import { Avatar } from './Avatar';
import { NewChannelModal } from './NewChannelModal';

interface ChatWorkspaceProps {
  token: string;
  currentUser: PublicUser;
  onSignOut: () => void;
}

function formatMessageTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateHeading(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function ChatWorkspace({ token, currentUser, onSignOut }: ChatWorkspaceProps) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(() => new Set([currentUser.id]));
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ChatMessage[]>>({});
  const [loadingRoomId, setLoadingRoomId] = useState<string | null>(null);
  const [unreadByRoom, setUnreadByRoom] = useState<Record<string, number>>({});
  const [typingByRoom, setTypingByRoom] = useState<Record<string, Record<string, string>>>({});
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'reconnecting'>(
    'connecting',
  );
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const activeRoomIdRef = useRef<string | null>(null);
  const isTypingSentRef = useRef(false);
  const typingStopTimerRef = useRef<number | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const pendingQueueRef = useRef<ClientWsEvent[]>([]);

  useEffect(() => {
    activeRoomIdRef.current = activeRoomId;
  }, [activeRoomId]);

  const sendWs = useCallback((event: ClientWsEvent) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
      return true;
    }
    return false;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = messageScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    shouldStickToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, []);

  const loadBootstrap = useCallback(async () => {
    setBootstrapLoading(true);
    setBootstrapError(null);
    try {
      const response = await fetch('/api/bootstrap', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        onSignOut();
        return;
      }
      if (!response.ok) {
        throw new Error('Could not load workspace');
      }
      const data = (await response.json()) as {
        rooms: Room[];
        users: PublicUser[];
        onlineUserIds: string[];
      };

      setRooms(data.rooms);
      setUsers(data.users);
      setOnlineUserIds(new Set(data.onlineUserIds));

      setActiveRoomId((prev) => {
        if (prev && data.rooms.some((r) => r.id === prev)) return prev;
        return data.rooms[0]?.id ?? null;
      });
    } catch {
      setBootstrapError('Failed to load conversations. Please retry.');
    } finally {
      setBootstrapLoading(false);
    }
  }, [token, onSignOut]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  // Fetch message history when switching rooms over HTTP as immediate baseline
  useEffect(() => {
    if (!activeRoomId) return;
    const roomId = activeRoomId;
    setUnreadByRoom((prev) => {
      if (!prev[roomId]) return prev;
      const next = { ...prev };
      delete next[roomId];
      return next;
    });

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      sendWs({ type: 'room:join', roomId });
    }

    let cancelled = false;
    async function fetchHistory() {
      setLoadingRoomId(roomId);
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { messages: ChatMessage[] };
        if (cancelled) return;
        setMessagesByRoom((prev) => {
          const existing = prev[roomId] ?? [];
          const pending = existing.filter((m) => m.pending);
          const mergedIds = new Set(data.messages.map((m) => m.id));
          const uniquePending = pending.filter((p) => !mergedIds.has(p.id));
          return {
            ...prev,
            [roomId]: [...data.messages, ...uniquePending],
          };
        });
        requestAnimationFrame(() => scrollToBottom('auto'));
      } finally {
        if (!cancelled) {
          setLoadingRoomId((curr) => (curr === roomId ? null : curr));
        }
      }
    }

    void fetchHistory();
    return () => {
      cancelled = true;
    };
  }, [activeRoomId, token, sendWs, scrollToBottom]);

  // WebSocket lifecycle with automatic exponential backoff reconnection
  useEffect(() => {
    let unmounted = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;

    function connect() {
      if (unmounted) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        if (unmounted) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: 'auth', token }));
      });

      ws.addEventListener('message', (evt) => {
        let event: ServerWsEvent;
        try {
          event = JSON.parse(String(evt.data)) as ServerWsEvent;
        } catch {
          return;
        }

        if (event.type === 'auth:error') {
          onSignOut();
          return;
        }

        if (event.type === 'auth:ok') {
          reconnectAttempt = 0;
          setWsStatus('connected');
          setOnlineUserIds(new Set(event.onlineUserIds));

          if (activeRoomIdRef.current) {
            ws.send(JSON.stringify({ type: 'room:join', roomId: activeRoomIdRef.current }));
          }

          if (pendingQueueRef.current.length > 0) {
            const queued = [...pendingQueueRef.current];
            pendingQueueRef.current = [];
            for (const q of queued) {
              ws.send(JSON.stringify(q));
            }
          }
          return;
        }

        if (event.type === 'presence:update') {
          setOnlineUserIds(new Set(event.onlineUserIds));
          return;
        }

        if (event.type === 'user:registered') {
          setUsers((prev) => {
            if (prev.some((u) => u.id === event.user.id)) return prev;
            return [...prev, event.user].sort((a, b) =>
              a.displayName.localeCompare(b.displayName),
            );
          });
          return;
        }

        if (event.type === 'room:created') {
          setRooms((prev) => {
            if (prev.some((r) => r.id === event.room.id)) return prev;
            return [...prev, event.room];
          });
          return;
        }

        if (event.type === 'room:history') {
          setMessagesByRoom((prev) => {
            const existing = prev[event.roomId] ?? [];
            const pending = existing.filter((m) => m.pending);
            const serverIds = new Set(event.messages.map((m) => m.id));
            const remainingPending = pending.filter((p) => !serverIds.has(p.id));
            return {
              ...prev,
              [event.roomId]: [...event.messages, ...remainingPending],
            };
          });
          if (event.roomId === activeRoomIdRef.current) {
            requestAnimationFrame(() => scrollToBottom('auto'));
          }
          return;
        }

        if (event.type === 'message:created') {
          const msg = event.message;
          setMessagesByRoom((prev) => {
            const roomMsgs = prev[msg.roomId] ?? [];
            if (roomMsgs.some((m) => m.id === msg.id)) {
              return prev;
            }
            let updated: ChatMessage[];
            if (
              event.clientMessageId &&
              roomMsgs.some((m) => m.clientMessageId === event.clientMessageId)
            ) {
              updated = roomMsgs.map((m) =>
                m.clientMessageId === event.clientMessageId ? msg : m,
              );
            } else {
              updated = [...roomMsgs, msg];
            }
            return { ...prev, [msg.roomId]: updated };
          });

          // Clear typing status for the sender when their message lands
          setTypingByRoom((prev) => {
            const roomTyping = prev[msg.roomId];
            if (!roomTyping || !roomTyping[msg.senderId]) return prev;
            const nextRoomTyping = { ...roomTyping };
            delete nextRoomTyping[msg.senderId];
            return { ...prev, [msg.roomId]: nextRoomTyping };
          });

          if (msg.roomId !== activeRoomIdRef.current) {
            setUnreadByRoom((prev) => ({
              ...prev,
              [msg.roomId]: (prev[msg.roomId] ?? 0) + 1,
            }));
          } else if (shouldStickToBottomRef.current || msg.senderId === currentUser.id) {
            requestAnimationFrame(() => scrollToBottom('smooth'));
          }
          return;
        }

        if (event.type === 'message:deleted') {
          setMessagesByRoom((prev) => {
            const existing = prev[event.roomId];
            if (!existing) return prev;
            return {
              ...prev,
              [event.roomId]: existing.filter((m) => m.id !== event.messageId),
            };
          });
          return;
        }

        if (event.type === 'typing:update') {
          if (event.userId === currentUser.id) return;
          setTypingByRoom((prev) => {
            const roomTyping = { ...(prev[event.roomId] ?? {}) };
            if (event.isTyping) {
              roomTyping[event.userId] = event.displayName;
            } else {
              delete roomTyping[event.userId];
            }
            return { ...prev, [event.roomId]: roomTyping };
          });
          return;
        }

        if (event.type === 'error') {
          setActionError(event.message);
          window.setTimeout(() => setActionError(null), 4000);
        }
      });

      ws.addEventListener('close', () => {
        if (unmounted) return;
        setWsStatus('reconnecting');
        const delay = Math.min(1000 * 2 ** reconnectAttempt, 10000);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      });
    }

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (typingStopTimerRef.current !== null) window.clearTimeout(typingStopTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [token, currentUser.id, onSignOut, scrollToBottom]);

  const activeRoom = useMemo(
    () => rooms.find((r) => r.id === activeRoomId) ?? null,
    [rooms, activeRoomId],
  );

  const channels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rooms
      .filter((r) => r.type === 'channel')
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  }, [rooms, searchQuery]);

  const otherUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return users
      .filter((u) => u.id !== currentUser.id)
      .filter(
        (u) =>
          !q ||
          u.displayName.toLowerCase().includes(q) ||
          u.username.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const aOnline = onlineUserIds.has(a.id) ? 0 : 1;
        const bOnline = onlineUserIds.has(b.id) ? 0 : 1;
        if (aOnline !== bOnline) return aOnline - bOnline;
        return a.displayName.localeCompare(b.displayName);
      });
  }, [users, currentUser.id, searchQuery, onlineUserIds]);

  const dmByOtherUserId = useMemo(() => {
    const map = new Map<string, Room>();
    for (const r of rooms) {
      if (r.type === 'dm' && r.otherUser) {
        map.set(r.otherUser.id, r);
      }
    }
    return map;
  }, [rooms]);

  const activeMessages = activeRoomId ? (messagesByRoom[activeRoomId] ?? []) : [];

  const activeTypers = useMemo(() => {
    if (!activeRoomId) return [];
    return Object.values(typingByRoom[activeRoomId] ?? {});
  }, [activeRoomId, typingByRoom]);

  async function handleOpenDm(targetUser: PublicUser) {
    const existing = dmByOtherUserId.get(targetUser.id);
    if (existing) {
      setActiveRoomId(existing.id);
      setSidebarOpen(false);
      return;
    }

    try {
      const response = await fetch('/api/dm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ targetUserId: targetUser.id }),
      });
      const data = (await response.json()) as { room?: Room; error?: string };
      if (!response.ok || !data.room) {
        setActionError(data.error || 'Could not open direct message.');
        return;
      }

      setRooms((prev) => (prev.some((r) => r.id === data.room!.id) ? prev : [...prev, data.room!]));
      setActiveRoomId(data.room.id);
      setSidebarOpen(false);
    } catch {
      setActionError('Network error while starting direct message.');
    }
  }

  function emitTypingStop(roomId: string) {
    if (isTypingSentRef.current) {
      isTypingSentRef.current = false;
      sendWs({ type: 'typing:stop', roomId });
    }
    if (typingStopTimerRef.current !== null) {
      window.clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = null;
    }
  }

  function handleDraftChange(value: string) {
    setDraft(value);
    if (!activeRoomId) return;
    if (value.trim().length > 0) {
      if (!isTypingSentRef.current) {
        isTypingSentRef.current = true;
        sendWs({ type: 'typing:start', roomId: activeRoomId });
      }
      if (typingStopTimerRef.current !== null) {
        window.clearTimeout(typingStopTimerRef.current);
      }
      const currentRoom = activeRoomId;
      typingStopTimerRef.current = window.setTimeout(() => {
        emitTypingStop(currentRoom);
      }, 2200);
    } else {
      emitTypingStop(activeRoomId);
    }
  }

  function submitMessage() {
    if (!activeRoomId) return;
    const content = draft.trim();
    if (!content) return;
    if (content.length > 2000) {
      setActionError('Message exceeds 2,000 characters.');
      return;
    }

    const clientMessageId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMessage: ChatMessage = {
      id: clientMessageId,
      clientMessageId,
      roomId: activeRoomId,
      senderId: currentUser.id,
      senderName: currentUser.username,
      senderDisplayName: currentUser.displayName,
      senderColor: currentUser.avatarColor,
      content,
      createdAt: Date.now(),
      pending: true,
    };

    setMessagesByRoom((prev) => ({
      ...prev,
      [activeRoomId]: [...(prev[activeRoomId] ?? []), optimisticMessage],
    }));

    setDraft('');
    emitTypingStop(activeRoomId);
    requestAnimationFrame(() => scrollToBottom('smooth'));

    const payload: ClientWsEvent = {
      type: 'message:send',
      roomId: activeRoomId,
      content,
      clientMessageId,
    };

    const sent = sendWs(payload);
    if (!sent) {
      pendingQueueRef.current.push(payload);
    }
  }

  function handleComposerSubmit(e: FormEvent) {
    e.preventDefault();
    submitMessage();
  }

  function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  }

  function handleDeleteMessage(messageId: string) {
    sendWs({ type: 'message:delete', messageId });
  }

  function handleScrollMessages() {
    const el = messageScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 80;
    shouldStickToBottomRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);
  }

  async function handleCopyAppLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      setActionError('Copy the browser URL from the address bar to open a second session.');
    }
  }

  const sidebarContent = (
    <div className="flex h-full flex-col bg-slate-50 border-r border-slate-200">
      <div className="flex h-16 items-center justify-between gap-3 border-b border-slate-200 px-4">
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white">
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
          </div>
          <span className="font-display text-base font-bold tracking-tight text-slate-900">
            ForVasu
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setNewChannelOpen(true)}
            aria-label="Create new channel"
            title="New channel"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-200/70 hover:text-slate-900 transition-colors"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-200/70 lg:hidden"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="px-3 py-3 border-b border-slate-200/80">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter channels or people"
            aria-label="Filter channels or people"
            className="block w-full min-h-[36px] rounded-lg border border-slate-200 bg-white py-1.5 pr-3 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15 focus:outline-none"
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6" aria-label="Conversations">
        <div>
          <div className="flex items-center justify-between px-2 mb-1.5">
            <h2 className="text-xs font-semibold text-slate-500">Channels</h2>
            <span className="font-mono text-xs text-slate-400 tabular-nums">
              {channels.length}
            </span>
          </div>
          {channels.length === 0 ? (
            <p className="px-2 py-2 text-xs text-slate-500">No channels match your filter.</p>
          ) : (
            <ul className="space-y-0.5">
              {channels.map((room) => {
                const isActive = room.id === activeRoomId;
                const unread = unreadByRoom[room.id] ?? 0;
                return (
                  <li key={room.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveRoomId(room.id);
                        setSidebarOpen(false);
                      }}
                      className={`flex w-full min-h-[38px] items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                        isActive
                          ? 'bg-blue-600 text-white font-medium'
                          : 'text-slate-700 hover:bg-slate-200/70 hover:text-slate-900'
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <Hash
                          className={`h-4 w-4 shrink-0 ${
                            isActive ? 'text-blue-100' : 'text-slate-400'
                          }`}
                          aria-hidden="true"
                        />
                        <span className="truncate">{room.name}</span>
                      </span>
                      {unread > 0 && !isActive && (
                        <span className="font-mono text-xs font-semibold text-blue-600 tabular-nums shrink-0">
                          {unread}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between px-2 mb-1.5">
            <h2 className="text-xs font-semibold text-slate-500">Direct Messages</h2>
            <span className="font-mono text-xs text-slate-400 tabular-nums">
              {otherUsers.length}
            </span>
          </div>

          {otherUsers.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
              <p className="font-medium text-slate-800">No other members yet</p>
              <p className="mt-1 leading-relaxed text-slate-500">
                Open another tab and sign up a second username to message directly.
              </p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {otherUsers.map((person) => {
                const dmRoom = dmByOtherUserId.get(person.id);
                const isActive = dmRoom ? dmRoom.id === activeRoomId : false;
                const isOnline = onlineUserIds.has(person.id);
                const unread = dmRoom ? (unreadByRoom[dmRoom.id] ?? 0) : 0;

                return (
                  <li key={person.id}>
                    <button
                      type="button"
                      onClick={() => void handleOpenDm(person)}
                      className={`flex w-full min-h-[42px] items-center justify-between gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                        isActive
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-700 hover:bg-slate-200/70 hover:text-slate-900'
                      }`}
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        <Avatar
                          name={person.displayName}
                          color={person.avatarColor}
                          size="sm"
                          showPresence
                          online={isOnline}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {person.displayName}
                          </span>
                          <span
                            className={`block truncate text-xs ${
                              isActive
                                ? 'text-blue-100'
                                : isOnline
                                  ? 'text-emerald-700'
                                  : 'text-slate-400'
                            }`}
                          >
                            {isOnline ? 'Online' : 'Offline'}
                          </span>
                        </span>
                      </span>
                      {unread > 0 && !isActive && (
                        <span className="font-mono text-xs font-semibold text-blue-600 tabular-nums shrink-0">
                          {unread}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </nav>

      <div className="border-t border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <Avatar
              name={currentUser.displayName}
              color={currentUser.avatarColor}
              size="md"
              showPresence
              online={wsStatus === 'connected'}
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">
                {currentUser.displayName}
              </p>
              <p className="truncate font-mono text-xs text-slate-500">
                @{currentUser.username}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            aria-label="Sign out"
            title="Sign out"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-white text-slate-900">
      {/* Desktop Sidebar */}
      <aside className="hidden w-[272px] shrink-0 lg:block">{sidebarContent}</aside>

      {/* Mobile Drawer Sidebar */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-50 w-[280px] max-w-[85vw] h-full">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main Conversation Pane */}
      <div className="flex min-w-0 flex-1 flex-col bg-white">
        <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-4 lg:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open conversations"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 lg:hidden"
            >
              <Menu className="h-4 w-4" aria-hidden="true" />
            </button>

            {activeRoom ? (
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  {activeRoom.type === 'channel' ? (
                    <Hash className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  ) : null}
                  <h1 className="truncate font-display text-base font-semibold text-slate-900">
                    {activeRoom.type === 'channel' ? activeRoom.name : activeRoom.name}
                  </h1>
                </div>
                <p className="truncate text-xs text-slate-500">
                  {activeRoom.type === 'dm' && activeRoom.otherUser
                    ? `@${activeRoom.otherUser.username} · ${
                        onlineUserIds.has(activeRoom.otherUser.id) ? 'Online' : 'Offline'
                      }`
                    : activeRoom.description}
                </p>
              </div>
            ) : (
              <h1 className="font-display text-base font-semibold text-slate-900">ForVasu</h1>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-500">
              <Users className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
              <span className="font-mono tabular-nums">{onlineUserIds.size}</span>
              <span>online</span>
            </div>
            <button
              type="button"
              onClick={() => void handleCopyAppLink()}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              {copiedLink ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                  <span>Link copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                  <span>Invite Link</span>
                </>
              )}
            </button>
          </div>
        </header>

        {wsStatus === 'reconnecting' && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800">
            Connection interrupted. Reconnecting to live chat...
          </div>
        )}

        {actionError && (
          <div
            role="alert"
            className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs font-medium text-red-700"
          >
            {actionError}
          </div>
        )}

        {bootstrapLoading ? (
          <div className="flex-1 p-6 space-y-4">
            <div className="h-12 w-2/3 animate-pulse rounded-lg bg-slate-100" />
            <div className="h-12 w-1/2 animate-pulse rounded-lg bg-slate-100" />
            <div className="h-12 w-3/4 animate-pulse rounded-lg bg-slate-100" />
          </div>
        ) : bootstrapError ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <p className="text-sm font-medium text-slate-900">{bootstrapError}</p>
            <button
              type="button"
              onClick={() => void loadBootstrap()}
              className="mt-3 min-h-[40px] rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="relative flex-1 overflow-hidden">
              <div
                ref={messageScrollRef}
                onScroll={handleScrollMessages}
                className="h-full overflow-y-auto px-4 py-5 lg:px-6"
              >
                {loadingRoomId === activeRoomId && activeMessages.length === 0 ? (
                  <div className="space-y-4">
                    <div className="h-10 w-64 animate-pulse rounded-lg bg-slate-100" />
                    <div className="h-10 w-80 animate-pulse rounded-lg bg-slate-100" />
                  </div>
                ) : activeMessages.length === 0 ? (
                  <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-500">
                      {activeRoom?.type === 'channel' ? (
                        <Hash className="h-5 w-5" aria-hidden="true" />
                      ) : (
                        <MessageSquare className="h-5 w-5" aria-hidden="true" />
                      )}
                    </div>
                    <h2 className="mt-3 text-base font-semibold text-slate-900">
                      {activeRoom?.type === 'channel'
                        ? `Welcome to #${activeRoom.name}`
                        : `Start chatting with ${activeRoom?.name ?? 'this user'}`}
                    </h2>
                    <p className="mt-1 max-w-sm text-sm text-slate-500">
                      No messages here yet. Type a message below to send it in real time.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {activeMessages.map((msg, index) => {
                      const prev = index > 0 ? activeMessages[index - 1] : null;
                      const showDateDivider =
                        !prev ||
                        new Date(prev.createdAt).toDateString() !==
                          new Date(msg.createdAt).toDateString();

                      const isGrouped =
                        !showDateDivider &&
                        prev !== null &&
                        prev.senderId === msg.senderId &&
                        msg.createdAt - prev.createdAt < 5 * 60 * 1000;

                      const isOwn = msg.senderId === currentUser.id;

                      return (
                        <div key={msg.id}>
                          {showDateDivider && (
                            <div className="my-5 flex items-center gap-3">
                              <div className="h-px flex-1 bg-slate-200" />
                              <span className="text-xs font-medium text-slate-500">
                                {formatDateHeading(msg.createdAt)}
                              </span>
                              <div className="h-px flex-1 bg-slate-200" />
                            </div>
                          )}

                          <div
                            className={`group flex items-start gap-3 rounded-lg px-2 py-1 hover:bg-slate-50 transition-colors ${
                              isGrouped ? 'mt-0' : 'mt-3'
                            } ${msg.pending ? 'opacity-65' : ''}`}
                          >
                            {isGrouped ? (
                              <div className="w-9 shrink-0 pt-0.5 text-right font-mono text-[11px] text-slate-400 opacity-0 group-hover:opacity-100 tabular-nums select-none">
                                {formatMessageTime(msg.createdAt)}
                              </div>
                            ) : (
                              <div className="pt-0.5">
                                <Avatar
                                  name={msg.senderDisplayName}
                                  color={msg.senderColor}
                                  size="md"
                                />
                              </div>
                            )}

                            <div className="min-w-0 flex-1">
                              {!isGrouped && (
                                <div className="flex items-baseline gap-2">
                                  <span className="text-sm font-semibold text-slate-900">
                                    {msg.senderDisplayName}
                                  </span>
                                  <span className="font-mono text-xs text-slate-400">
                                    @{msg.senderName}
                                  </span>
                                  <span aria-hidden="true" className="text-slate-300">
                                    ·
                                  </span>
                                  <span className="font-mono text-xs text-slate-400 tabular-nums">
                                    {formatMessageTime(msg.createdAt)}
                                  </span>
                                  {msg.pending && (
                                    <span className="text-xs text-slate-400">Sending...</span>
                                  )}
                                </div>
                              )}
                              <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-slate-800">
                                {msg.content}
                              </p>
                            </div>

                            {isOwn && !msg.pending && (
                              <button
                                type="button"
                                onClick={() => handleDeleteMessage(msg.id)}
                                aria-label="Delete message"
                                title="Delete message"
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-red-50 hover:text-red-600 transition-colors"
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {showJumpToBottom && (
                <button
                  type="button"
                  onClick={() => scrollToBottom('smooth')}
                  className="absolute right-6 bottom-4 inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Jump to latest</span>
                </button>
              )}
            </div>

            <div className="shrink-0 border-t border-slate-200 bg-white px-4 pt-2 pb-4 lg:px-6">
              <div className="mb-1.5 min-h-[18px] text-xs text-slate-500">
                {activeTypers.length === 1 && (
                  <span>{activeTypers[0]} is typing...</span>
                )}
                {activeTypers.length === 2 && (
                  <span>
                    {activeTypers[0]} and {activeTypers[1]} are typing...
                  </span>
                )}
                {activeTypers.length > 2 && (
                  <span>{activeTypers.length} people are typing...</span>
                )}
              </div>

              <form
                onSubmit={handleComposerSubmit}
                className="flex items-end gap-2 rounded-xl border border-slate-300 bg-white p-2 focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-600/15"
              >
                <textarea
                  rows={1}
                  maxLength={2000}
                  value={draft}
                  onChange={(e) => handleDraftChange(e.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  disabled={!activeRoom}
                  placeholder={
                    activeRoom
                      ? activeRoom.type === 'channel'
                        ? `Message #${activeRoom.name}`
                        : `Message ${activeRoom.name}`
                      : 'Select a conversation'
                  }
                  aria-label="Message input"
                  className="max-h-36 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
                />
                <div className="flex items-center gap-2 shrink-0">
                  {draft.length > 1500 && (
                    <span className="font-mono text-xs text-slate-400 tabular-nums">
                      {draft.length}/2000
                    </span>
                  )}
                  <button
                    type="submit"
                    disabled={!activeRoom || !draft.trim()}
                    aria-label="Send message"
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45 transition-colors whitespace-nowrap"
                  >
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Send</span>
                  </button>
                </div>
              </form>
            </div>
          </>
        )}
      </div>

      <NewChannelModal
        open={newChannelOpen}
        token={token}
        onClose={() => setNewChannelOpen(false)}
        onCreated={(room) => {
          setRooms((prev) => (prev.some((r) => r.id === room.id) ? prev : [...prev, room]));
          setActiveRoomId(room.id);
          setSidebarOpen(false);
        }}
      />
    </div>
  );
}
