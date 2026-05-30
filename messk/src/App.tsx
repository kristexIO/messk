import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useAppStore } from './store';
import { Toaster } from 'react-hot-toast';
import { LockScreen } from './components/LockScreen';
import { Component, lazy, Suspense, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { socketManager } from './lib/socket';
import { initNotifications } from './lib/notifications';
import { OnboardingModal } from './components/OnboardingModal';
import { db } from './lib/db';
import { decodeBase64 } from 'tweetnacl-util';
import { useI18n } from './lib/i18n';
import { joinInviteLink, syncChannels, syncGroups } from './lib/community';
import { toast } from 'react-hot-toast';
import { ONBOARDING_STORAGE_KEY } from './lib/storage';
import { getSafeUiRecoveryCopy, logUiRenderError } from './lib/uiErrorRecovery';

const Auth = lazy(async () => {
  const module = await import('./pages/Auth');
  return { default: module.Auth };
});

const Chat = lazy(async () => {
  const module = await import('./pages/Chat');
  return { default: module.Chat };
});

const TrustCenter = lazy(async () => {
  const module = await import('./pages/TrustCenter');
  return { default: module.TrustCenter };
});

type AppErrorBoundaryState = {
  hasError: boolean;
};

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return {
      hasError: true,
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    logUiRenderError('app', error, info.componentStack ?? undefined);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const copy = getSafeUiRecoveryCopy('app');

    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0e1621] px-4 text-white">
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#17212b] p-5 shadow-none">
          <div className="text-lg font-semibold">{copy.title}</div>
          <p className="mt-2 text-sm leading-6 text-white/70">
            {copy.body}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-xl bg-[#2aabee] px-4 py-2 text-sm font-semibold text-white"
            >
              {copy.primaryAction}
            </button>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white/80"
            >
              {copy.secondaryAction}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

function App() {
  const { myPublicKey, mySecretKey, isLocked, isRestoringIdentity, restoreRememberedIdentity, setActivePeer, setActiveGroup, setActiveChannel, autoLockMinutes, lockApp } = useAppStore();
  const { t } = useI18n();
  const lastActivityRef = useRef(0);
  const [hasDismissedOnboarding, setHasDismissedOnboarding] = useState(
    () => localStorage.getItem(ONBOARDING_STORAGE_KEY) === '1'
  );
  const showOnboarding = Boolean(mySecretKey && !isLocked && !hasDismissedOnboarding);

  useEffect(() => {
    void restoreRememberedIdentity();
  }, [restoreRememberedIdentity]);

  useEffect(() => {
    if (!mySecretKey || !autoLockMinutes || isLocked) {
      return;
    }

    lastActivityRef.current = Date.now();
    const markActivity = () => {
      lastActivityRef.current = Date.now();
    };
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivityRef.current >= autoLockMinutes * 60_000) {
        lockApp();
      }
    }, 15_000);
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    events.forEach((eventName) => window.addEventListener(eventName, markActivity, { passive: true }));

    return () => {
      window.clearInterval(timer);
      events.forEach((eventName) => window.removeEventListener(eventName, markActivity));
    };
  }, [autoLockMinutes, isLocked, lockApp, mySecretKey]);

  useEffect(() => {
    if (!myPublicKey || isRestoringIdentity) {
      return;
    }
    void socketManager.refreshOwnProfile(myPublicKey);
  }, [isRestoringIdentity, myPublicKey]);

  useEffect(() => {
    if (!mySecretKey || isRestoringIdentity) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const chatPubKey = params.get('chat');
    if (!chatPubKey) {
      return;
    }

    try {
      if (decodeBase64(chatPubKey).length !== 32) {
        return;
      }
    } catch {
      return;
    }

    void db.contacts.get(chatPubKey).then(async (existing) => {
      if (!existing) {
        await db.contacts.put({
          pubKey: chatPubKey,
          name: `${chatPubKey.substring(0, 8)}...`,
          lastMessageAt: Date.now(),
        });
      }
      void socketManager.refreshContactProfile(chatPubKey);
      setActivePeer(chatPubKey);
      params.delete('chat');
      const nextQuery = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`);
    });
  }, [isRestoringIdentity, mySecretKey, setActivePeer]);

  useEffect(() => {
    if (!mySecretKey || isRestoringIdentity) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const inviteToken = params.get('invite');
    if (!inviteToken) {
      return;
    }

    let cancelled = false;
    void (async () => {
      let shouldClearInvite = false;
      try {
        const ready = await socketManager.ensureRealtimeReady();
        if (!ready || cancelled) {
          return;
        }
        shouldClearInvite = true;
        const joined = await joinInviteLink(inviteToken);
        if (cancelled) {
          return;
        }

        if (joined.entityType === 'group') {
          await syncGroups(true);
          if (cancelled) {
            return;
          }
          setActiveGroup(joined.entityId);
          toast.success('Joined group via invite link.');
        } else {
          await syncChannels(true);
          if (cancelled) {
            return;
          }
          setActiveChannel(joined.entityId);
          toast.success('Joined channel via invite link.');
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : 'Failed to use invite link.');
        }
      } finally {
        if (shouldClearInvite) {
          params.delete('invite');
          const nextQuery = params.toString();
          window.history.replaceState(null, '', `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isRestoringIdentity, mySecretKey, setActiveChannel, setActiveGroup]);

  useEffect(() => {
    void initNotifications();

    const handleUnload = () => {
      socketManager.disconnect();
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, [mySecretKey]);

  return (
    <Router>
      <Toaster position="top-center" toastOptions={{
        style: {
          background: 'var(--tg-panel)',
          color: 'var(--text-main)',
          borderRadius: '10px',
          border: '1px solid var(--tg-line)',
          boxShadow: 'none',
        }
      }} />
      <AppErrorBoundary>
        <Routes>
          <Route path="/trust" element={
            <Suspense fallback={<div className="min-h-screen bg-[#020617]" />}>
              <TrustCenter />
            </Suspense>
          } />
          <Route path="*" element={
            <Suspense fallback={<div className="min-h-screen bg-[#020617]" />}>
              <>
                {isLocked && <LockScreen />}
                {showOnboarding && mySecretKey && !isLocked ? (
                  <OnboardingModal
                    onClose={() => {
                      localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
                      setHasDismissedOnboarding(true);
                    }}
                  />
                ) : null}
                {isRestoringIdentity ? (
                  <div className="flex min-h-screen items-center justify-center bg-[#020617] text-sm font-semibold text-white/70">
                    {t('restoringSession')}
                  </div>
                ) : mySecretKey ? <Chat /> : <Auth />}
              </>
            </Suspense>
          } />
        </Routes>
      </AppErrorBoundary>
    </Router>
  );
}

export default App;
