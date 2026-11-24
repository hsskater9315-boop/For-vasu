import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertCircle, Hash, X } from 'lucide-react';
import type { Room } from '../types/chat';

interface NewChannelModalProps {
  open: boolean;
  token: string;
  onClose: () => void;
  onCreated: (room: Room) => void;
}

export function NewChannelModal({ open, token, onClose, onCreated }: NewChannelModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) {
      setError('Channel name must be at least 2 characters.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      });

      const data = (await response.json()) as { room?: Room; error?: string };
      if (!response.ok || !data.room) {
        setError(data.error || 'Could not create channel.');
        return;
      }

      setName('');
      setDescription('');
      onCreated(data.room);
      onClose();
    } catch {
      setError('Network error while creating channel.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-channel-title"
    >
      <div
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="new-channel-title" className="text-lg font-semibold text-slate-900">
            Create a Channel
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <p className="mt-1 text-sm text-slate-500">
          Public channels are visible to everyone signed into ForVasu.
        </p>

        {error && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label htmlFor="channel-name" className="block text-sm font-medium text-slate-700">
              Channel Name
            </label>
            <div className="relative mt-1.5">
              <Hash
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                id="channel-name"
                type="text"
                required
                maxLength={32}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="design-review"
                className="block w-full min-h-[40px] rounded-lg border border-slate-300 bg-white py-2 pr-3 pl-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label htmlFor="channel-desc" className="block text-sm font-medium text-slate-700">
              Description (optional)
            </label>
            <input
              id="channel-desc"
              type="text"
              maxLength={140}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this channel for?"
              className="mt-1.5 block w-full min-h-[40px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-600/15 focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="min-h-[40px] rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {submitting ? 'Creating...' : 'Create Channel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
