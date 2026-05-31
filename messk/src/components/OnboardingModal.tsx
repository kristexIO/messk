import React from 'react';
import { BellOff, Download, KeyRound, Search, ShieldCheck, X } from 'lucide-react';
import { AccessibleModalFrame } from './AccessibleModalFrame';

interface OnboardingModalProps {
  onClose: () => void;
}

const steps = [
  {
    icon: KeyRound,
    title: 'Start Securely',
    body: 'Paste a public key in the sidebar to open your first encrypted chat. Your seed phrase remains the only way to recover your identity.',
  },
  {
    icon: BellOff,
    title: 'Stay Focused',
    body: 'Mute a chat for 8 hours, archive it when you want a cleaner inbox, and jump back into unread messages in one click.',
  },
  {
    icon: Download,
    title: 'Back Up Safely',
    body: 'Export encrypted backups from Settings to keep profile, contacts and history available without exposing your secret keys.',
  },
];

const shortcuts = [
  'Ctrl + F searches inside the active chat',
  'Ctrl + Shift + M mutes or unmutes the active chat',
  'Ctrl + Shift + A archives or restores the active chat',
  'Escape clears chat search or returns to the chat list',
];

export const OnboardingModal: React.FC<OnboardingModalProps> = ({ onClose }) => {
  const titleId = 'onboarding-dialog-title';
  const descriptionId = 'onboarding-dialog-description';

  return (
    <AccessibleModalFrame
      titleId={titleId}
      descriptionId={descriptionId}
      onClose={onClose}
      className="fixed inset-0 z-[210] flex items-end justify-center bg-black/70 px-3 py-3 backdrop-blur-md sm:items-center sm:p-4"
      panelClassName="premium-glass relative flex max-h-[100dvh] w-full max-w-4xl flex-col overflow-hidden rounded-[28px] border border-white/10 shadow-2xl outline-none animate-in fade-in zoom-in duration-300 sm:rounded-[36px]"
    >
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -left-10 top-0 h-48 w-48 rounded-full bg-accent/15 blur-[100px]" />
          <div className="absolute bottom-0 right-0 h-56 w-56 rounded-full bg-blue-500/10 blur-[120px]" />
        </div>

        <div className="relative border-b border-white/10 px-4 py-4 sm:px-8 sm:py-6">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close onboarding"
            className="absolute right-4 top-4 rounded-full p-2 text-text-muted transition-colors hover:bg-white/10 hover:text-white sm:right-6 sm:top-6"
          >
            <X className="h-5 w-5" />
          </button>
          <div className="flex items-start gap-3 pr-10 sm:items-center sm:pr-12">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/15 text-accent shadow-[0_0_20px_var(--accent-glow)] sm:h-12 sm:w-12">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent/80">Welcome</p>
              <h2 id={titleId} className="text-xl font-bold text-white sm:text-2xl">Your secure workspace is ready</h2>
            </div>
          </div>
          <p id={descriptionId} className="mt-3 max-w-2xl text-sm leading-relaxed text-text-muted sm:mt-4">
            Messk is set up for end-to-end encrypted conversations, local vault protection and encrypted backups. Here are the fastest ways to feel at home.
          </p>
        </div>

        <div className="relative flex-1 overflow-y-auto">
          <div className="grid gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8 md:grid-cols-3">
          {steps.map((step) => {
            const Icon = step.icon;
            return (
              <div key={step.title} className="rounded-3xl border border-white/10 bg-white/5 p-5 sm:p-6">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-black/20 text-accent sm:h-12 sm:w-12">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-semibold sm:mt-5">{step.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-text-muted">{step.body}</p>
              </div>
            );
          })}
          </div>

          <div className="grid gap-4 border-t border-white/10 px-4 py-4 sm:gap-6 sm:px-8 sm:py-6 md:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-3xl border border-white/10 bg-black/20 p-5 sm:p-6">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Search className="h-4 w-4 text-accent" />
              Fast shortcuts
            </div>
            <div className="mt-4 grid gap-3 text-sm text-text-muted">
              {shortcuts.map((shortcut) => (
                <div key={shortcut} className="rounded-2xl bg-white/5 px-4 py-3">
                  {shortcut}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/5 p-5 sm:p-6">
            <div className="text-sm font-semibold">Release-ready defaults already enabled</div>
            <div className="mt-4 space-y-3 text-sm text-text-muted">
              <div className="rounded-2xl bg-black/20 px-4 py-3">Encrypted local storage for sensitive records</div>
              <div className="rounded-2xl bg-black/20 px-4 py-3">PIN lock support with keyboard unlock flow</div>
              <div className="rounded-2xl bg-black/20 px-4 py-3">Muted, archived and unread-focused chat workflow</div>
            </div>
          </div>
        </div>
        </div>

        <div className="relative flex flex-col gap-3 border-t border-white/10 bg-slate-950/70 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8 sm:py-6">
          <p className="text-sm text-text-muted">
            You can reopen guidance later from Settings and keep building from a stable encrypted base.
          </p>
          <button type="button" onClick={onClose} className="btn-premium w-full justify-center px-6 py-3 sm:w-auto">
            Start Messaging
          </button>
        </div>
    </AccessibleModalFrame>
  );
};
