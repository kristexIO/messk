import { lazy, Suspense, useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { decodeBase64 } from 'tweetnacl-util';
import { useAppStore } from '../store';
import { db } from '../lib/db';
import { joinInviteLink, syncChannels, syncGroups } from '../lib/community';
import { initNotifications } from '../lib/notifications';
import { socketManager } from '../lib/socket';
import { ONBOARDING_STORAGE_KEY } from '../lib/storage';
import { RouteLoadingFallback } from './RouteLoadingFallback';

const Chat = lazy(async () => {
  const module = await import('../pages/Chat');
  return { default: module.Chat };
});

const OnboardingModal = lazy(async () => {
  const module = await import('./OnboardingModal');
  return { default: module.OnboardingModal };
});

export function AuthenticatedSession() {
  const {
    myPublicKey,
    mySecretKey,
    isLocked,
    isRestoringIdentity,
    setActivePeer,
    setActiveGroup,
    setActiveChannel,
  } = useAppStore();
  const [hasDismissedOnboarding, setHasDismissedOnboarding] = useState(
    () => localStorage.getItem(ONBOARDING_STORAGE_KEY) === '1'
  );
  const showOnboarding = Boolean(mySecretKey && !isLocked && !hasDismissedOnboarding);

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
  }, []);

  return (
    <>
      {showOnboarding ? (
        <Suspense fallback={null}>
          <OnboardingModal
            onClose={() => {
              localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
              setHasDismissedOnboarding(true);
            }}
          />
        </Suspense>
      ) : null}
      <Suspense fallback={<RouteLoadingFallback route="chat" />}>
        <Chat />
      </Suspense>
    </>
  );
}

