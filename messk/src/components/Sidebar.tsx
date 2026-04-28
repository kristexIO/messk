import React, { useDeferredValue, useState } from 'react';
import { useAppStore } from '../store';
import { db, getDatabaseNameForIdentity, rebuildAllThreadStats } from '../lib/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { KeyRound, Copy, Check, LogOut, MessageSquareOff, UserPlus, Edit2, Settings, QrCode, Search, Pin, Archive, BellOff, Bell, Inbox, Sparkles, Plus, Megaphone } from 'lucide-react';
import { socketManager } from '../lib/socket';
import { decodeBase64 } from 'tweetnacl-util';
import { UserIdentityModal } from './UserIdentityModal';
import { SettingsModal } from './SettingsModal';
import Dexie from 'dexie';
import { CreateGroupModal } from './CreateGroupModal';
import { CreateChannelModal } from './CreateChannelModal';
import { CreateChatModal } from './CreateChatModal';
import { refreshGroupAvailability, syncChannels, syncGroups } from '../lib/community';
import { toast } from 'react-hot-toast';
import { useI18n } from '../lib/i18n';

const INITIAL_SIDEBAR_SECTION_LIMIT = 24;
const SIDEBAR_SECTION_STEP = 24;

function safeGroupMembers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((member): member is string => typeof member === 'string' && member.length > 0);
}

function getVisibleItems<T extends { id?: string; pubKey?: string }>(
  items: T[],
  limit: number,
  activeId: string | null,
  isSearching: boolean,
  resolveId: (item: T) => string
) {
  if (isSearching) {
    return items;
  }

  const activeIndex = activeId ? items.findIndex((item) => resolveId(item) === activeId) : -1;
  const effectiveLimit = activeIndex >= 0 ? Math.max(limit, activeIndex + 1) : limit;
  return items.slice(0, effectiveLimit);
}

export const Sidebar: React.FC = () => {
  const {
    myPublicKey,
    activePeerKey,
    activeGroupId,
    activeChannelId,
    setActivePeer,
    setActiveGroup,
    setActiveChannel,
    logout,
    nickname,
    avatar,
    typingStatus,
    connectionStatus,
    groupSyncStatus,
    channelSyncStatus
  } = useAppStore();
  const [isCopied, setIsCopied] = useState(false);
  const [editingContact, setEditingContact] = useState<string | null>(null);
  const [editNameInput, setEditNameInput] = useState('');
  const [showMyId, setShowMyId] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCreateChat, setShowCreateChat] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<'chats' | 'groups' | 'channels'>('chats');
  const [activeFilter, setActiveFilter] = useState<'inbox' | 'archived' | 'unread'>('inbox');
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [contactExpansionByContext, setContactExpansionByContext] = useState<Record<string, number>>({});
  const [groupExpansionByContext, setGroupExpansionByContext] = useState<Record<string, number>>({});
  const [channelExpansionByContext, setChannelExpansionByContext] = useState<Record<string, number>>({});
  const deferredSearch = useDeferredValue(searchInput.trim().toLowerCase());
  const sidebarContextKey = `${activeFilter}:${deferredSearch}`;
  const quickCreateRef = React.useRef<HTMLDivElement>(null);
  const { t } = useI18n();

  React.useEffect(() => {
    const timer = window.setInterval(() => setNowTs(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  React.useEffect(() => {
    if (!showQuickCreate) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!quickCreateRef.current?.contains(event.target as Node)) {
        setShowQuickCreate(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showQuickCreate]);

  React.useEffect(() => {
    if (connectionStatus !== 'connected') return;
    void Promise.allSettled([syncGroups(), syncChannels()]).then((results) => {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.warn(index === 0 ? 'Failed to sync groups' : 'Failed to sync channels', result.reason);
        }
      });
    });
  }, [connectionStatus]);

  const allContacts = useLiveQuery(() => db.contacts.toArray(), []);
  const groups = useLiveQuery(() => db.groupThreads.orderBy('lastActivityAt').reverse().toArray(), []);
  const channels = useLiveQuery(() => db.channelThreads.orderBy('lastActivityAt').reverse().toArray(), []);
  const groupInvites = useLiveQuery(() => db.groupInvites.orderBy('createdAt').reverse().toArray(), []);
  const threadStats = useLiveQuery(() => db.threadStats.toArray(), []);

  React.useEffect(() => {
    if (threadStats === undefined || threadStats.length > 0) {
      return;
    }

    void db.messages.count().then((count) => {
      if (count > 0) {
        return rebuildAllThreadStats();
      }
      return undefined;
    }).catch((error) => {
      console.warn('Failed to rebuild thread stats cache', error);
    });
  }, [threadStats]);

  const unreadCounts = React.useMemo(
    () =>
      Object.fromEntries(
        (threadStats ?? [])
          .filter((stat) => (stat.unreadCount ?? 0) > 0)
          .map((stat) => [stat.threadId, stat.unreadCount] as const)
      ),
    [threadStats]
  );
  const contactByPubKey = React.useMemo(
    () => new Map((allContacts ?? []).map((contact) => [contact.pubKey, contact] as const)),
    [allContacts]
  );
  const threadSummaries = React.useMemo(
    () =>
      Object.fromEntries(
        (threadStats ?? [])
          .filter((stat) => Boolean(stat.lastMessagePreview) || typeof stat.lastMessageAt === 'number')
          .map((stat) => [
            stat.threadId,
            {
              preview: stat.lastMessagePreview ?? '',
              timestamp: stat.lastMessageAt ?? 0,
            },
          ] as const)
      ),
    [threadStats]
  );

  const contacts = React.useMemo(() => {
    const allKnownContacts = allContacts ?? [];
    const filterByState = allKnownContacts.filter((contact) => {
      if (activeFilter === 'archived') return Boolean(contact.archived);
      if (activeFilter === 'unread') return !contact.archived && Boolean(unreadCounts?.[contact.pubKey]);
      return !contact.archived;
    });

    const filteredContacts = deferredSearch
      ? filterByState.filter((contact) =>
          contact.name.toLowerCase().includes(deferredSearch) ||
          contact.pubKey.toLowerCase().includes(deferredSearch) ||
          (contact.draft ?? '').toLowerCase().includes(deferredSearch)
        )
      : filterByState;

    return filteredContacts.sort((a, b) => {
      const pinnedDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
      if (pinnedDelta !== 0) return pinnedDelta;
      const unreadDelta = (unreadCounts?.[b.pubKey] ?? 0) - (unreadCounts?.[a.pubKey] ?? 0);
      if (unreadDelta !== 0) return unreadDelta;
      return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
    });
  }, [activeFilter, allContacts, deferredSearch, unreadCounts]);

  const filteredGroups = React.useMemo(() => {
    const knownGroups = groups ?? [];
    if (!deferredSearch) {
      return knownGroups;
    }
    return knownGroups.filter((group) =>
      group.title.toLowerCase().includes(deferredSearch) ||
      safeGroupMembers(group.members).some((member) => member.toLowerCase().includes(deferredSearch))
    );
  }, [deferredSearch, groups]);

  const filteredChannels = React.useMemo(() => {
    const knownChannels = channels ?? [];
    if (!deferredSearch) {
      return knownChannels;
    }
    return knownChannels.filter((channel) =>
      channel.title.toLowerCase().includes(deferredSearch) ||
      channel.ownerPubKey.toLowerCase().includes(deferredSearch)
    );
  }, [channels, deferredSearch]);

  const contactRenderLimit = INITIAL_SIDEBAR_SECTION_LIMIT + (contactExpansionByContext[sidebarContextKey] ?? 0);
  const groupRenderLimit = INITIAL_SIDEBAR_SECTION_LIMIT + (groupExpansionByContext[sidebarContextKey] ?? 0);
  const channelRenderLimit = INITIAL_SIDEBAR_SECTION_LIMIT + (channelExpansionByContext[sidebarContextKey] ?? 0);

  const visibleContacts = React.useMemo(
    () => getVisibleItems(contacts, contactRenderLimit, activePeerKey, Boolean(deferredSearch), (contact) => contact.pubKey),
    [activePeerKey, contactRenderLimit, contacts, deferredSearch]
  );
  const visibleGroups = React.useMemo(
    () => getVisibleItems(filteredGroups, groupRenderLimit, activeGroupId, Boolean(deferredSearch), (group) => group.id),
    [activeGroupId, deferredSearch, filteredGroups, groupRenderLimit]
  );
  const visibleChannels = React.useMemo(
    () => getVisibleItems(filteredChannels, channelRenderLimit, activeChannelId, Boolean(deferredSearch), (channel) => channel.id),
    [activeChannelId, channelRenderLimit, deferredSearch, filteredChannels]
  );
  const hasHiddenContacts = !deferredSearch && contacts.length > visibleContacts.length;
  const hasHiddenGroups = !deferredSearch && filteredGroups.length > visibleGroups.length;
  const hasHiddenChannels = !deferredSearch && filteredChannels.length > visibleChannels.length;

  const filterTabs = [
    { id: 'inbox' as const, label: t('inbox'), icon: Inbox },
    { id: 'unread' as const, label: t('unread'), icon: Bell },
    { id: 'archived' as const, label: t('archived'), icon: Archive },
  ];
  const workspaceTabs = [
    { id: 'chats' as const, label: t('chats'), accent: 'from-white to-white/70' },
    { id: 'groups' as const, label: t('groups'), accent: 'from-cyan-200 to-sky-300' },
    { id: 'channels' as const, label: t('channels'), accent: 'from-violet-200 to-fuchsia-200' },
  ];

  const inboxUnreadCount = Object.entries(unreadCounts ?? {}).reduce((total, [pubKey, count]) => {
    const contact = contactByPubKey.get(pubKey);
    return total + (contact?.archived ? 0 : count);
  }, 0);
  const archivedCount = allContacts?.filter((contact) => contact.archived).length ?? 0;
  const activeWorkspaceCount = activeWorkspaceTab === 'chats'
    ? contacts.length
    : activeWorkspaceTab === 'groups'
      ? filteredGroups.length
      : filteredChannels.length;
  const connectionStateLabel = connectionStatus === 'connected'
    ? t('online')
    : connectionStatus === 'offline'
      ? t('offline')
      : connectionStatus === 'reconnecting'
        ? t('reconnecting')
        : t('connecting');
  const connectionStateClass = connectionStatus === 'connected'
    ? 'is-online'
    : connectionStatus === 'offline'
      ? 'is-offline'
      : 'is-pending';
  const formatSyncTime = (timestamp: number | null) => {
    if (!timestamp) return t('never');
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleCopyMyKey = () => {
    if (!myPublicKey) return;
    navigator.clipboard.writeText(myPublicKey);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleLogout = () => {
    const databaseNames = Array.from(new Set([
      getDatabaseNameForIdentity(myPublicKey),
      getDatabaseNameForIdentity(null),
    ]));
    socketManager.disconnect();
    localStorage.removeItem('messenger_settings');
    logout();
    db.close();
    void Promise.all(databaseNames.map((databaseName) => Dexie.delete(databaseName).catch(() => undefined)))
      .finally(() => window.location.reload());
  };

  const startChatWithKey = async (rawPeerKey: string) => {
    const cleanPeerKey = rawPeerKey.trim();
    if (!cleanPeerKey) {
      return false;
    }

    try {
      const decoded = decodeBase64(cleanPeerKey);
      if (decoded.length !== 32) {
        toast.error(t('invalidKeyLength'));
        return false;
      }
    } catch {
      toast.error(t('invalidBase64Key'));
      return false;
    }

    const existing = await db.contacts.get(cleanPeerKey);
    if (!existing) {
      await db.contacts.put({
        pubKey: cleanPeerKey,
        name: cleanPeerKey.substring(0, 8) + '...',
        lastMessageAt: Date.now()
      });
    }
    void socketManager.refreshContactProfile(cleanPeerKey);
    setActiveWorkspaceTab('chats');
    setActivePeer(cleanPeerKey);
    return true;
  };

  const startEditingContact = (e: React.MouseEvent, pubKey: string, currentName: string) => {
    e.stopPropagation();
    setEditingContact(pubKey);
    setEditNameInput(currentName);
  };

  const saveContactName = async (e: React.FormEvent, pubKey: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (editNameInput.trim()) {
      await db.contacts.update(pubKey, { name: editNameInput.trim() });
    }
    setEditingContact(null);
  };

  const handleRefreshGroups = async () => {
    if (connectionStatus !== 'connected') {
      useAppStore.getState().setGroupSyncStatus({ state: 'error', error: t('serverOfflineRefresh') });
      return;
    }
    try {
      await syncGroups();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failedRefreshGroups'));
    }
  };

  const handleRefreshChannels = async () => {
    if (connectionStatus !== 'connected') {
      useAppStore.getState().setChannelSyncStatus({ state: 'error', error: t('serverOfflineRefresh') });
      return;
    }
    try {
      await syncChannels(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failedRefreshChannels'));
    }
  };

  const handleOpenInvitedGroup = async (groupId: string, inviteId: string) => {
    try {
      const group = await refreshGroupAvailability(groupId);
      if (!group) {
        toast.error(t('groupUnavailable'));
        return;
      }
      await db.groupInvites.delete(inviteId);
      setActiveWorkspaceTab('groups');
      setActiveGroup(groupId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failedLoadInvitedGroup'));
    }
  };

  const handleOpenQuickChat = () => {
    setActiveWorkspaceTab('chats');
    setShowQuickCreate(false);
    setShowCreateChat(true);
  };

  const handleOpenQuickGroup = () => {
    setShowQuickCreate(false);
    setActiveWorkspaceTab('groups');
    setShowCreateGroup(true);
  };

  const handleOpenQuickChannel = () => {
    setShowQuickCreate(false);
    setActiveWorkspaceTab('channels');
    setShowCreateChannel(true);
  };

  return (
    <div className={`
      ${activePeerKey || activeGroupId || activeChannelId ? 'hidden md:flex' : 'flex'}
      messk-sidebar flex-col w-full md:w-[390px] premium-glass z-10 h-full border-r border-white/5
    `}>
      <div className="p-4 space-y-5 sm:p-6 sm:space-y-6">
        <div className="sidebar-brand flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/20 text-accent flex items-center justify-center shadow-[0_0_15px_var(--accent-glow)]">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">
                Messk
              </h1>
              <div className={`connection-chip ${connectionStateClass}`}>
                <span />
                {connectionStateLabel}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSettings(true)}
              className="p-2.5 text-text-muted hover:text-white hover:bg-white/5 rounded-xl transition-all"
              title={t('settings')}
              aria-label={t('openSettings')}
            >
              <Settings className="w-5 h-5" />
            </button>
            <button
              onClick={handleLogout}
              className="p-2.5 text-text-muted hover:text-red-400 hover:bg-red-400/10 rounded-xl transition-all"
              title={t('logout')}
              aria-label={t('logout')}
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="identity-card relative group p-4 rounded-2xl bg-white/5 border border-white/10 hover:border-accent/30 transition-all hover-glow">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-accent flex items-center justify-center text-lg font-bold shadow-lg overflow-hidden">
              {avatar ? (
                <img src={avatar} alt="Avatar" className="w-full h-full object-cover" />
              ) : (
                nickname?.charAt(0).toUpperCase() || '?'
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="font-semibold truncate">{nickname || t('anonymous')}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="font-mono text-[10px] text-text-muted truncate max-w-[120px]">
                  {myPublicKey}
                </span>
                <button onClick={handleCopyMyKey} className="text-text-muted hover:text-accent transition-colors" aria-label={t('copyPublicKey')}>
                  {isCopied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
            </div>
            <button
              onClick={() => setShowMyId(true)}
              className="p-2 text-text-muted hover:text-accent transition-colors bg-white/5 rounded-lg"
              aria-label={t('showQrIdentity')}
            >
              <QrCode className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {showMyId && myPublicKey && <UserIdentityModal pubKey={myPublicKey} onClose={() => setShowMyId(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showCreateChat && (
        <CreateChatModal
          onClose={() => setShowCreateChat(false)}
          onCreate={startChatWithKey}
        />
      )}
      {showCreateGroup && (
        <CreateGroupModal
          onClose={() => setShowCreateGroup(false)}
          onCreated={() => {
            void handleRefreshGroups();
          }}
        />
      )}
      {showCreateChannel && (
        <CreateChannelModal
          onClose={() => setShowCreateChannel(false)}
          onCreated={() => {
            void handleRefreshChannels();
          }}
        />
      )}

      <div className="px-4 py-4 sm:px-6">
        <div className="workspace-tabs rounded-[22px] border border-white/10 bg-white/[0.04] p-1.5">
          <div className="grid grid-cols-3 gap-1.5">
            {workspaceTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveWorkspaceTab(tab.id)}
                className={`rounded-2xl px-3 py-2.5 text-sm font-semibold transition-all ${
                  activeWorkspaceTab === tab.id
                    ? 'bg-[#10162f] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_8px_24px_rgba(0,0,0,0.18)]'
                    : 'text-text-muted hover:bg-white/[0.04] hover:text-white'
                }`}
              >
                <span className={`bg-gradient-to-r ${tab.accent} bg-clip-text text-transparent`}>
                  {tab.label}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              placeholder={
                activeWorkspaceTab === 'chats'
                  ? t('searchChats')
                  : activeWorkspaceTab === 'groups'
                    ? t('searchGroups')
                    : t('searchChannels')
              }
              className="product-input w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm outline-none transition-all focus:border-accent/50 focus:bg-white/10"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label={t('searchWorkspace')}
            />
          </div>
          <div className="relative" ref={quickCreateRef}>
            <button
              type="button"
              onClick={() => setShowQuickCreate((current) => !current)}
              className={`product-icon-button flex h-[42px] w-[42px] items-center justify-center rounded-xl border transition-all ${
                showQuickCreate
                  ? 'border-white/20 bg-[#121937] text-white'
                  : 'border-white/10 bg-white/[0.04] text-white hover:bg-white/[0.08]'
              }`}
              aria-label={t('openCreateMenu')}
              aria-expanded={showQuickCreate}
            >
              <Plus className="w-5 h-5" />
            </button>
            {showQuickCreate ? (
              <div className="quick-create-menu absolute right-0 top-[calc(100%+10px)] z-30 w-52 rounded-[22px] border border-white/10 bg-[#0f1530]/95 p-2 shadow-[0_24px_80px_rgba(0,0,0,0.42)] backdrop-blur-xl">
                <button
                  type="button"
                  onClick={handleOpenQuickChat}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm text-white transition-all hover:bg-white/[0.06]"
                >
                  <UserPlus className="h-4 w-4 text-accent" />
                  <div>
                    <div className="font-medium">{t('newChat')}</div>
                    <div className="text-[11px] text-text-muted">{t('newChatHint')}</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={handleOpenQuickGroup}
                  className="mt-1 flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm text-white transition-all hover:bg-white/[0.06]"
                >
                  <Sparkles className="h-4 w-4 text-cyan-200" />
                  <div>
                    <div className="font-medium">{t('newGroup')}</div>
                    <div className="text-[11px] text-text-muted">{t('newGroupHint')}</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={handleOpenQuickChannel}
                  className="mt-1 flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm text-white transition-all hover:bg-white/[0.06]"
                >
                  <Megaphone className="h-4 w-4 text-violet-200" />
                  <div>
                    <div className="font-medium">{t('newChannel')}</div>
                    <div className="text-[11px] text-text-muted">{t('newChannelHint')}</div>
                  </div>
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {activeWorkspaceTab === 'chats' ? (
          <div className="mt-3 flex gap-2">
            {filterTabs.map((tab) => {
              const Icon = tab.icon;
              const badge = tab.id === 'inbox'
                ? inboxUnreadCount
                : tab.id === 'unread'
                  ? inboxUnreadCount
                  : tab.id === 'archived'
                    ? archivedCount
                    : undefined;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveFilter(tab.id)}
                  aria-pressed={activeFilter === tab.id}
                  className={`inline-flex items-center gap-2 rounded-2xl border px-3.5 py-2 text-xs font-medium transition-all ${
                    activeFilter === tab.id
                      ? 'border-white/20 bg-[#121937] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                      : 'border-white/10 bg-white/[0.04] text-text-muted hover:bg-white/[0.08] hover:text-white'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                  {badge ? (
                    <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-white">
                      {badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="sidebar-scroll flex-1 overflow-y-auto px-3 pb-4 custom-scrollbar sm:px-4">
        {activeWorkspaceTab === 'groups' ? (
        <div className="mb-4 rounded-[26px] border border-white/8 bg-white/[0.03] p-3">
          <div className="mb-3 flex items-center justify-between px-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-accent" />
              <span className="text-xs font-semibold uppercase tracking-[0.22em] text-text-muted">{t('groups')}</span>
            </div>
            <button
              type="button"
              onClick={handleRefreshGroups}
              className="rounded-xl border border-white/10 px-2.5 py-1 text-[11px] text-text-muted transition-all hover:border-white/20 hover:text-white"
            >
              {t('refresh')}
            </button>
          </div>
          <div className={`mb-3 rounded-2xl border px-3 py-2 text-[11px] ${
            groupSyncStatus.state === 'error'
              ? 'border-red-400/20 bg-red-400/10 text-red-100'
              : groupSyncStatus.state === 'syncing'
                ? 'border-amber-300/20 bg-amber-300/10 text-amber-100'
                : 'border-white/10 bg-black/10 text-text-muted'
          }`}>
            {groupSyncStatus.state === 'syncing'
              ? t('syncingGroups')
              : groupSyncStatus.state === 'error'
                ? groupSyncStatus.error || t('groupSyncFailed')
                : t('lastSync', { time: formatSyncTime(groupSyncStatus.lastSyncAt) })}
          </div>
          {groups === undefined ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, index) => (
                <div key={index} className="flex items-center gap-3 rounded-2xl border border-white/5 bg-white/[0.03] px-3 py-3 animate-pulse">
                  <div className="h-10 w-10 rounded-2xl bg-white/10" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-24 rounded-full bg-white/10" />
                    <div className="h-2.5 w-16 rounded-full bg-white/5" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredGroups.length > 0 ? (
            <div className="space-y-2">
              {visibleGroups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => {
                    setActiveWorkspaceTab('groups');
                    setActiveGroup(group.id);
                  }}
                  className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-all ${
                    activeGroupId === group.id
                      ? 'border-accent/30 bg-accent/10'
                      : 'border-transparent bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.05]'
                  }`}
                >
                  <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-cyan-400/20 to-white/5">
                    {group.avatar ? (
                      <img src={group.avatar} alt={group.title} className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-sm font-bold text-white">{group.title.substring(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-white">{group.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
                      <span className="truncate">{threadSummaries?.[group.id]?.preview || t('membersCount', { count: Number.isFinite(group.memberCount) ? group.memberCount : safeGroupMembers(group.members).length })}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
                      <span>{t('membersCount', { count: Number.isFinite(group.memberCount) ? group.memberCount : safeGroupMembers(group.members).length })}</span>
                      <span className="h-1 w-1 rounded-full bg-white/20" />
                      <span className="uppercase tracking-wide text-accent/80">{group.role}</span>
                    </div>
                  </div>
                  {(unreadCounts?.[group.id] ?? 0) > 0 ? (
                    <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-white shadow-[0_0_12px_var(--accent-glow)]">
                      {unreadCounts?.[group.id]}
                    </span>
                  ) : null}
                </button>
              ))}
              {hasHiddenGroups ? (
                <button
                  type="button"
                  onClick={() =>
                    setGroupExpansionByContext((current) => ({
                      ...current,
                      [sidebarContextKey]: (current[sidebarContextKey] ?? 0) + SIDEBAR_SECTION_STEP,
                    }))
                  }
                  className="w-full rounded-2xl border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-text-muted transition-all hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
                >
                  {t('loadMoreGroups', { count: Math.min(SIDEBAR_SECTION_STEP, filteredGroups.length - visibleGroups.length) })}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/10 bg-black/10 px-4 py-6 text-center">
              <div className="text-sm font-medium text-white">{t('noGroupsYet')}</div>
              <div className="mt-1 text-xs text-text-muted">{t('noGroupsYetText')}</div>
            </div>
          )}
        </div>
        ) : null}

        {activeWorkspaceTab === 'channels' ? (
        <div className="mb-4 rounded-[26px] border border-white/8 bg-white/[0.03] p-3">
          <div className="mb-3 flex items-center justify-between px-2">
            <div className="flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-violet-200" />
              <span className="text-xs font-semibold uppercase tracking-[0.22em] text-text-muted">{t('channels')}</span>
            </div>
            <button
              type="button"
              onClick={handleRefreshChannels}
              className="rounded-xl border border-white/10 px-2.5 py-1 text-[11px] text-text-muted transition-all hover:border-white/20 hover:text-white"
            >
              {t('refresh')}
            </button>
          </div>
          <div className={`mb-3 rounded-2xl border px-3 py-2 text-[11px] ${
            channelSyncStatus.state === 'error'
              ? 'border-red-400/20 bg-red-400/10 text-red-100'
              : channelSyncStatus.state === 'syncing'
                ? 'border-amber-300/20 bg-amber-300/10 text-amber-100'
                : 'border-white/10 bg-black/10 text-text-muted'
          }`}>
            {channelSyncStatus.state === 'syncing'
              ? t('syncingChannels')
              : channelSyncStatus.state === 'error'
                ? channelSyncStatus.error || t('channelSyncFailed')
                : t('lastSync', { time: formatSyncTime(channelSyncStatus.lastSyncAt) })}
          </div>
          {channels === undefined ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, index) => (
                <div key={index} className="flex items-center gap-3 rounded-2xl border border-white/5 bg-white/[0.03] px-3 py-3 animate-pulse">
                  <div className="h-10 w-10 rounded-2xl bg-white/10" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-24 rounded-full bg-white/10" />
                    <div className="h-2.5 w-16 rounded-full bg-white/5" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredChannels.length > 0 ? (
            <div className="space-y-2">
              {visibleChannels.map((channel) => (
                <button
                  key={channel.id}
                  type="button"
                  onClick={() => {
                    setActiveWorkspaceTab('channels');
                    setActiveChannel(channel.id);
                  }}
                  className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-all ${
                    activeChannelId === channel.id
                      ? 'border-violet-300/30 bg-violet-300/10'
                      : 'border-transparent bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.05]'
                  }`}
                >
                  <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-violet-300/20 to-white/5">
                    {channel.avatar ? (
                      <img src={channel.avatar} alt={channel.title} className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-sm font-bold text-white">{channel.title.substring(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-white">{channel.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
                      <span className="truncate">{threadSummaries?.[channel.id]?.preview || t('subscribersCount', { count: channel.subscriberCount })}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
                      <span>{t('subscribersCount', { count: channel.subscriberCount })}</span>
                      <span className="h-1 w-1 rounded-full bg-white/20" />
                      <span className="uppercase tracking-wide text-violet-200/80">{channel.role}</span>
                    </div>
                  </div>
                  {(unreadCounts?.[channel.id] ?? 0) > 0 ? (
                    <span className="rounded-full bg-violet-400 px-2 py-0.5 text-[10px] font-bold text-white">
                      {unreadCounts?.[channel.id]}
                    </span>
                  ) : null}
                </button>
              ))}
              {hasHiddenChannels ? (
                <button
                  type="button"
                  onClick={() =>
                    setChannelExpansionByContext((current) => ({
                      ...current,
                      [sidebarContextKey]: (current[sidebarContextKey] ?? 0) + SIDEBAR_SECTION_STEP,
                    }))
                  }
                  className="w-full rounded-2xl border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-text-muted transition-all hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
                >
                  {t('loadMoreChannels', { count: Math.min(SIDEBAR_SECTION_STEP, filteredChannels.length - visibleChannels.length) })}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/10 bg-black/10 px-4 py-6 text-center">
              <div className="text-sm font-medium text-white">{t('noChannelsYet')}</div>
              <div className="mt-1 text-xs text-text-muted">{t('noChannelsYetText')}</div>
            </div>
          )}
        </div>
        ) : null}

        {activeWorkspaceTab === 'groups' && (groupInvites?.length ?? 0) > 0 ? (
          <div className="mb-4 rounded-[26px] border border-amber-300/15 bg-amber-300/[0.04] p-3">
            <div className="mb-3 flex items-center justify-between px-2">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-200" />
                <span className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-100/80">{t('invites')}</span>
              </div>
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white">
                {groupInvites?.length ?? 0}
              </span>
            </div>
            <div className="space-y-2">
              {groupInvites?.map((invite) => (
                <div
                  key={invite.id}
                  className="rounded-2xl border border-white/10 bg-black/10 px-3 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-amber-200/20 to-white/5">
                      {invite.avatar ? (
                        <img src={invite.avatar} alt={invite.title} className="h-full w-full object-cover" />
                      ) : (
                        <span className="text-sm font-bold text-white">{invite.title.substring(0, 1).toUpperCase()}</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-white">{invite.title}</div>
                      <div className="mt-1 text-[11px] text-text-muted">
                        {t('membersCount', { count: invite.memberCount })} - {t('role')}: {invite.role}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleOpenInvitedGroup(invite.groupId, invite.id)}
                      className="rounded-xl border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-xs font-medium text-white transition-all hover:border-amber-300/40 hover:bg-amber-300/15"
                    >
                      {t('openGroup')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void db.groupInvites.delete(invite.id)}
                      className="rounded-xl border border-white/10 px-3 py-2 text-xs text-text-muted transition-all hover:border-white/20 hover:text-white"
                    >
                      {t('dismiss')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {activeWorkspaceTab === 'chats' && !allContacts ? (
          <div className="space-y-3 mt-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex items-center gap-4 rounded-2xl border border-white/5 bg-white/5 p-3 animate-pulse">
                <div className="h-11 w-11 rounded-xl bg-white/10" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-32 rounded-full bg-white/10" />
                  <div className="h-2.5 w-24 rounded-full bg-white/5" />
                </div>
                <div className="h-8 w-8 rounded-xl bg-white/5" />
              </div>
            ))}
          </div>
        ) : activeWorkspaceTab === 'chats' && contacts && contacts.length > 0 ? (
          <div className="space-y-1 mt-2">
            {visibleContacts.map((contact) => {
              const isMuted = Boolean(contact.mutedUntil && contact.mutedUntil > nowTs);
              return (
                <div
                  key={contact.pubKey}
                  onClick={() => setActivePeer(contact.pubKey)}
                  role="button"
                  tabIndex={0}
                  aria-label={t('openChatWith', { name: contact.name })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setActivePeer(contact.pubKey);
                    }
                  }}
                  className={`
                    p-3 rounded-2xl cursor-pointer transition-all flex items-center gap-4 group
                    ${activePeerKey === contact.pubKey
                      ? 'bg-accent/15 border border-accent/20'
                      : 'hover:bg-white/5 border border-transparent'}
                  `}
                >
                  <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-white/10 to-white/5 border border-white/10 flex items-center justify-center text-white flex-shrink-0 relative overflow-hidden">
                    <div className="absolute inset-0 shimmer-bg opacity-0 group-hover:opacity-100 transition-opacity" />
                    {contact.avatar ? (
                      <img src={contact.avatar} alt={contact.name} className="relative z-10 h-full w-full object-cover" />
                    ) : (
                      <span className="font-bold relative z-10">{contact.name.substring(0, 1).toUpperCase()}</span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    {editingContact === contact.pubKey ? (
                      <form onSubmit={(e) => saveContactName(e, contact.pubKey)} className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={editNameInput}
                          onChange={(e) => setEditNameInput(e.target.value)}
                          className="bg-black/40 border border-accent/50 rounded-lg px-2 py-1 text-sm text-white w-full outline-none"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <button type="submit" onClick={(e) => e.stopPropagation()} className="text-green-400 p-1"><Check className="w-4 h-4" /></button>
                      </form>
                    ) : (
                      <div className="flex justify-between items-center">
                        <h3 className="text-[15px] font-semibold truncate group-hover:text-white transition-colors">{contact.name}</h3>
                        <button
                          onClick={(e) => startEditingContact(e, contact.pubKey, contact.name)}
                          className="text-text-muted hover:text-accent opacity-0 group-hover:opacity-100 transition-all p-1"
                          aria-label={t('renameContact', { name: contact.name })}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                    <div className="mt-0.5 flex items-center gap-2">
                      {typingStatus[contact.pubKey] ? (
                        <p className="text-[11px] text-accent truncate">{t('typing')}</p>
                      ) : contact.draft?.trim() ? (
                        <p className="text-[11px] text-amber-300 truncate">{t('draft')}: {contact.draft}</p>
                      ) : (
                        <p className="font-mono text-[11px] text-text-muted truncate opacity-60">
                          {contact.pubKey.substring(0, 16)}...
                        </p>
                      )}
                      {(unreadCounts?.[contact.pubKey] ?? 0) > 0 ? (
                        <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-white shadow-[0_0_12px_var(--accent-glow)]">
                          {unreadCounts?.[contact.pubKey]}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        const nextMutedUntil = contact.mutedUntil && contact.mutedUntil > Date.now()
                          ? undefined
                          : Date.now() + 8 * 60 * 60 * 1000;
                        await db.contacts.update(contact.pubKey, { mutedUntil: nextMutedUntil });
                      }}
                      className={`rounded-xl p-2 transition-all ${
                        isMuted
                          ? 'text-blue-300 opacity-100'
                          : 'text-text-muted opacity-0 group-hover:opacity-100 hover:text-blue-300'
                      }`}
                      title={isMuted ? t('unmuteChat') : t('muteChat')}
                      aria-label={isMuted ? t('unmuteContact', { name: contact.name }) : t('muteContact', { name: contact.name })}
                    >
                      {isMuted ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await db.contacts.update(contact.pubKey, { archived: !contact.archived, pinned: contact.archived ? contact.pinned : false });
                        if (activePeerKey === contact.pubKey && !contact.archived) {
                          setActivePeer(null);
                        }
                      }}
                      className={`rounded-xl p-2 transition-all ${
                        contact.archived
                          ? 'text-violet-300 opacity-100'
                          : 'text-text-muted opacity-0 group-hover:opacity-100 hover:text-violet-300'
                      }`}
                      title={contact.archived ? t('restoreChat') : t('archiveChat')}
                      aria-label={contact.archived ? t('restoreContact', { name: contact.name }) : t('archiveContact', { name: contact.name })}
                    >
                      <Archive className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await db.contacts.update(contact.pubKey, { pinned: !contact.pinned });
                      }}
                      className={`rounded-xl p-2 transition-all ${contact.pinned ? 'text-amber-300 opacity-100' : 'text-text-muted opacity-0 group-hover:opacity-100 hover:text-amber-300'}`}
                      title={contact.pinned ? t('unpinChat') : t('pinChat')}
                      aria-label={contact.pinned ? t('unpinContact', { name: contact.name }) : t('pinContact', { name: contact.name })}
                    >
                      <Pin className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
            {hasHiddenContacts ? (
              <button
                type="button"
                onClick={() =>
                  setContactExpansionByContext((current) => ({
                    ...current,
                    [sidebarContextKey]: (current[sidebarContextKey] ?? 0) + SIDEBAR_SECTION_STEP,
                  }))
                }
                className="mt-3 w-full rounded-2xl border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-text-muted transition-all hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
              >
                {t('loadMoreChats', { count: Math.min(SIDEBAR_SECTION_STEP, contacts.length - visibleContacts.length) })}
              </button>
            ) : null}
          </div>
        ) : activeWorkspaceTab === 'chats' ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 opacity-30 mt-10">
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
              <MessageSquareOff className="w-8 h-8" />
            </div>
            <p className="text-sm">
              {activeFilter === 'archived'
                ? t('noArchivedChats')
                : activeFilter === 'unread'
                  ? t('noUnreadChats')
                  : t('noRecentChats')}
            </p>
            {activeFilter === 'inbox' ? (
              <p className="mt-2 max-w-xs text-xs text-text-muted">
                {t('emptyInboxHint')}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="sidebar-metrics border-t border-white/5 px-4 py-3 sm:px-6 sm:py-4">
        <div className="grid grid-cols-3 gap-2 text-center text-[10px] text-text-muted sm:text-[11px]">
          <div className="rounded-2xl bg-white/5 px-3 py-2">
            <div className="text-base font-semibold text-white">{activeWorkspaceCount}</div>
            <div>{activeWorkspaceTab === 'chats' ? t('visibleChats') : activeWorkspaceTab === 'groups' ? t('visibleGroups') : t('visibleChannels')}</div>
          </div>
          <div className="rounded-2xl bg-white/5 px-3 py-2">
            <div className={`text-base font-semibold ${activeWorkspaceTab === 'groups' ? 'text-cyan-200' : activeWorkspaceTab === 'channels' ? 'text-violet-200' : 'text-accent'}`}>
              {activeWorkspaceTab === 'chats' ? inboxUnreadCount : activeWorkspaceTab === 'groups' ? (groups?.length ?? 0) : (channels?.length ?? 0)}
            </div>
            <div>{activeWorkspaceTab === 'chats' ? t('unread') : activeWorkspaceTab === 'groups' ? t('totalGroups') : t('totalChannels')}</div>
          </div>
          <div className="rounded-2xl bg-white/5 px-3 py-2">
            <div className="text-base font-semibold text-white">
              {activeWorkspaceTab === 'chats'
                ? archivedCount
                : activeWorkspaceTab === 'groups'
                  ? filteredGroups.filter((group) => group.role === 'owner').length
                  : filteredChannels.filter((channel) => channel.role === 'owner').length}
            </div>
            <div>{activeWorkspaceTab === 'chats' ? t('archived') : t('owned')}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
