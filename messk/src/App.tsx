import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useAppStore } from './store';
import { Toaster } from 'react-hot-toast';
import { LockScreen } from './components/LockScreen';
import { lazy, Suspense, useEffect, useState } from 'react';
import { socketManager } from './lib/socket';
import { initNotifications, isTauri } from './lib/notifications';
import { OnboardingModal } from './components/OnboardingModal';
import { db } from './lib/db';
import { decodeBase64 } from 'tweetnacl-util';
import { useI18n } from './lib/i18n';
import { joinInviteLink, syncChannels, syncGroups } from './lib/community';
import { toast } from 'react-hot-toast';

const Auth = lazy(async () => {
  const module = await import('./pages/Auth');
  return { default: module.Auth };
});

const Chat = lazy(async () => {
  const module = await import('./pages/Chat');
  return { default: module.Chat };
});

function App() {
  const { myPublicKey, mySecretKey, isLocked, isRestoringIdentity, restoreRememberedIdentity, setActivePeer, setActiveGroup, setActiveChannel } = useAppStore();
  const { t } = useI18n();
  const [hasDismissedOnboarding, setHasDismissedOnboarding] = useState(
    () => localStorage.getItem('messk_onboarding_seen') === '1'
  );
  const showOnboarding = Boolean(mySecretKey && !isLocked && !hasDismissedOnboarding);

  useEffect(() => {
    void restoreRememberedIdentity();
  }, [restoreRememberedIdentity]);

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
    // Init native notifications & autostart (Tauri only)
    if (isTauri) {
      initNotifications();
      // Enable autostart silently
      import('@tauri-apps/plugin-autostart').then(({ enable, isEnabled }) => {
        isEnabled().then((enabled) => {
          if (!enabled) enable();
        });
      });
    }

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
          background: 'rgba(15, 23, 42, 0.92)',
          color: '#f8fbff',
          borderRadius: '18px',
          border: '1px solid rgba(174, 209, 255, 0.16)',
          boxShadow: '0 22px 60px rgba(0, 0, 0, 0.35)',
          backdropFilter: 'blur(18px)',
        }
      }} />
      <Routes>
        <Route path="*" element={
          <Suspense fallback={<div className="min-h-screen bg-[#020617]" />}>
            <>
              {isLocked && <LockScreen />}
              {showOnboarding && mySecretKey && !isLocked ? (
                <OnboardingModal
                  onClose={() => {
                    localStorage.setItem('messk_onboarding_seen', '1');
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
    </Router>
  );
}

export default App;
