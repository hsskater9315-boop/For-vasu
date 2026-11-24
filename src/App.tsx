import { useState } from 'react';
import { AuthScreen } from './components/AuthScreen';
import { ChatWorkspace } from './components/ChatWorkspace';
import type { PublicUser } from './types/chat';

interface SessionState {
  token: string;
  user: PublicUser;
}

export default function App() {
  const [session, setSession] = useState<SessionState | null>(null);

  if (!session) {
    return (
      <AuthScreen
        onAuthSuccess={(token, user) => {
          setSession({ token, user });
        }}
      />
    );
  }

  return (
    <ChatWorkspace
      token={session.token}
      currentUser={session.user}
      onSignOut={() => setSession(null)}
    />
  );
}
