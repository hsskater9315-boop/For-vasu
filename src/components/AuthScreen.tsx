import { useState } from 'react';
import type { FormEvent } from 'react';
import { AlertCircle, Eye, EyeOff, MessageSquare } from 'lucide-react';
import type { PublicUser } from '../types/chat';

interface AuthScreenProps {
  onAuthSuccess: (token: string, user: PublicUser) => void;
}

export function AuthScreen({ onAuthSuccess }: AuthScreenProps) {
  const [mode, setMode] = useState<'signup' | 'login'>('signup');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedUser = username.trim();
    if (trimmedUser.length < 3 || trimmedUser.length > 24) {
      setError('Username must be 3 to 24 characters.');
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmedUser)) {
      setError('Username can only use letters, numbers, dots, underscores, or hyphens.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setSubmitting(true);
    try {
      const endpoint = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: trimmedUser, password }),
      });

      const data = (await response.json()) as {
        token?: string;
        user?: PublicUser;
        error?: string;
      };

      if (!response.ok || !data.token || !data.user) {
        setError(data.error || 'Authentication failed. Please check your details.');
        return;
      }

      onAuthSuccess(data.token, data.user);
    } catch {
      setError('Unable to reach the server. Please check your connection and retry.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900 flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-6 py-4">
          <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white">
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
            </div>
            <span className="font-display text-lg font-bold tracking-tight text-slate-900">
              ForVasu
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'signup' ? 'login' : 'signup');
                setError(null);
              }}
              className="px-4 py-2 text-sm font-medium text-slate-700 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              {mode === 'signup' ? 'Log in instead' : 'Create account'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 items-center px-6 py-10 lg:py-16">
        <div className="grid w-full grid-cols-1 items-stretch gap-10 lg:grid-cols-12 lg:gap-12">
          <section className="flex flex-col justify-center lg:col-span-6">
            <p className="text-sm font-medium text-blue-600">Real-Time Messaging</p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl text-balance">
              Sign up with a username and start chatting live.
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-slate-600">
              Create your account in seconds using a unique username and password. Join open
              channels or start instant one-on-one direct messages synced over WebSockets.
            </p>

            <div className="mt-8 space-y-5 border-t border-slate-200 pt-6">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  01. Username & Password Accounts
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Pick any available handle without needing an email verification step.
                </p>
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  02. Live Channels & Direct Messages
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Messages, typing indicators, and online status update across browsers in real
                  time.
                </p>
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  03. Multi-Tab Ready
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Open a second browser tab to sign up another user and test live conversations
                  immediately.
                </p>
              </div>
            </div>
          </section>

          <section className="flex items-center justify-center lg:col-span-6">
            <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 sm:p-8">
              <div
                className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1"
                role="tablist"
                aria-label="Authentication mode"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'signup'}
                  onClick={() => {
                    setMode('signup');
                    setError(null);
                  }}
                  className={`min-h-[40px] rounded-md px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
                    mode === 'signup'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Sign Up
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'login'}
                  onClick={() => {
                    setMode('login');
                    setError(null);
                  }}
                  className={`min-h-[40px] rounded-md px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
                    mode === 'login'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Log In
                </button>
              </div>

              <div className="mt-6">
                <h2 className="text-xl font-semibold tracking-tight text-slate-900">
                  {mode === 'signup' ? 'Create your account' : 'Welcome back'}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {mode === 'signup'
                    ? 'Choose a username and password to join the chat.'
                    : 'Enter your username and password to continue.'}
                </p>
              </div>

              {error && (
                <div
                  role="alert"
                  className="mt-5 flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
                <div>
                  <label
                    htmlFor="auth-username"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Username
                  </label>
                  <input
                    id="auth-username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. aarav_99"
                    className="mt-1.5 block w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15 focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    3–24 characters. Letters, numbers, dots, underscores, or hyphens.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="auth-password"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Password
                  </label>
                  <div className="relative mt-1.5">
                    <input
                      id="auth-password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Minimum 6 characters"
                      className="block w-full min-h-[42px] rounded-lg border border-slate-300 bg-white py-2 pr-11 pl-3.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-500 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-r-lg"
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-2 flex w-full min-h-[44px] items-center justify-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting
                    ? mode === 'signup'
                      ? 'Creating account...'
                      : 'Signing in...'
                    : mode === 'signup'
                      ? 'Create Account & Enter Chat'
                      : 'Sign In'}
                </button>
              </form>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
