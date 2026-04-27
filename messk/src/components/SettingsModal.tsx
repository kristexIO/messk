import React, { useState } from 'react';
import { useAppStore } from '../store';
import type { DesignStyle, Theme } from '../store';
import { X, User, Palette, Shield, LogOut, Camera, Lock, Download, Upload, Database, PhoneCall, PhoneIncoming, PhoneOutgoing, PhoneMissed, Layers } from 'lucide-react';
import { socketManager } from '../lib/socket';
import { db } from '../lib/db';
import { useLiveQuery } from 'dexie-react-hooks';
import Dexie from 'dexie';
import { hashPin } from '../lib/security';
import { createEncryptedBackup, downloadEncryptedBackup, parseBackupFile, restoreBackup } from '../lib/backup';
import { prepareAvatarDataUrl } from '../lib/images';

interface SettingsModalProps {
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  const {
    nickname,
    avatar,
    username,
    theme,
    designStyle,
    setTheme,
    setDesignStyle,
    setProfile,
    logout,
    pinHash,
    setPinHash,
    lockApp,
    connectionStatus,
    groupSyncStatus,
    channelSyncStatus
  } = useAppStore();
  const [tempNick, setTempNick] = useState(nickname || '');
  const [tempAvatar, setTempAvatar] = useState(avatar || '');
  const [tempUsername, setTempUsername] = useState(username || '');
  const [profileError, setProfileError] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinMessage, setPinMessage] = useState('');
  const [backupMessage, setBackupMessage] = useState('');
  const callHistory = useLiveQuery(() => db.callHistory.orderBy('createdAt').reverse().limit(12).toArray(), []);
  const contacts = useLiveQuery(() => db.contacts.toArray(), []);
  const groups = useLiveQuery(() => db.groupThreads.toArray(), []);
  const channels = useLiveQuery(() => db.channelThreads.toArray(), []);
  const threadStats = useLiveQuery(() => db.threadStats.toArray(), []);
  const pendingGroupEventsCount = useLiveQuery(() => db.outgoingGroupEvents.count(), []);
  const pendingGroupInvitesCount = useLiveQuery(() => db.groupInvites.count(), []);
  const recentCallIssues = React.useMemo(
    () => (callHistory ?? []).filter((entry) => entry.outcome === 'missed' || entry.outcome === 'failed'),
    [callHistory]
  );
  const unreadChatCount = React.useMemo(
    () =>
      (threadStats ?? []).reduce((total, stat) => {
        const hasUnread = (stat.unreadCount ?? 0) > 0;
        const isChatThread = contacts?.some((contact) => contact.pubKey === stat.threadId);
        return total + (hasUnread && isChatThread ? stat.unreadCount ?? 0 : 0);
      }, 0),
    [contacts, threadStats]
  );
  const archivedChatCount = React.useMemo(
    () => contacts?.filter((contact) => contact.archived).length ?? 0,
    [contacts]
  );
  const ownedGroupCount = React.useMemo(
    () => groups?.filter((group) => group.role === 'owner').length ?? 0,
    [groups]
  );
  const ownedChannelCount = React.useMemo(
    () => channels?.filter((channel) => channel.role === 'owner').length ?? 0,
    [channels]
  );

  const handleSaveProfile = async () => {
    setProfileError('');
    if (tempUsername) {
      if (tempUsername.length < 5 || tempUsername.length > 32) {
        setProfileError('Username must be between 5 and 32 characters');
        return;
      }
      if (!/^[a-zA-Z0-9_]+$/.test(tempUsername)) {
        setProfileError('Username can only contain letters, numbers, and underscores');
        return;
      }
    }

    setProfile(tempNick, tempAvatar, tempUsername);
    try {
      await socketManager.syncMyProfile();
      onClose();
    } catch (error) {
      if (error instanceof Error && error.message === 'Username is already taken') {
        setProfileError('Username is already taken');
      } else {
        setProfileError('Failed to save profile to server');
      }
    }
  };

  const handleLogout = () => {
    socketManager.disconnect();
    localStorage.removeItem('messenger_settings');
    void Dexie.delete('MessengerDB').finally(() => window.location.reload());
    logout();
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        setTempAvatar(await prepareAvatarDataUrl(file));
      } catch (error) {
        setBackupMessage(error instanceof Error ? error.message : 'Failed to prepare avatar.');
      } finally {
        e.target.value = '';
      }
    }
  };

  const handleSavePin = async () => {
    if (!/^\d{4}$/.test(pinInput)) {
      setPinMessage('PIN must be exactly 4 digits.');
      return;
    }
    if (pinInput !== pinConfirm) {
      setPinMessage('PIN confirmation does not match.');
      return;
    }

    const nextPinHash = await hashPin(pinInput);
    setPinHash(nextPinHash);
    setPinInput('');
    setPinConfirm('');
    setPinMessage('PIN lock enabled.');
  };

  const handleRemovePin = () => {
    setPinHash(null);
    setPinInput('');
    setPinConfirm('');
    setPinMessage('PIN lock disabled.');
  };

  const handleExportBackup = async () => {
    const password = window.prompt('Set a backup password. You will need it to restore this backup.');
    if (!password) {
      setBackupMessage('Backup export cancelled.');
      return;
    }

    try {
      const backup = await createEncryptedBackup({
        nickname,
        avatar,
        theme
      }, password);
      downloadEncryptedBackup(backup);
      setBackupMessage('Encrypted backup exported. It contains profile, contacts and messages, but not secret keys.');
    } catch (error) {
      setBackupMessage(error instanceof Error ? error.message : 'Failed to export encrypted backup.');
    }
  };

  const handleImportBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const confirmed = window.confirm('Importing a backup will replace your current local contacts and message history. Continue?');
      if (!confirmed) {
        setBackupMessage('Backup import cancelled.');
        return;
      }

      let payload;
      try {
        payload = await parseBackupFile(file);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Backup password is required') {
          throw error;
        }
        const password = window.prompt('Enter the backup password.');
        if (!password) {
          setBackupMessage('Backup import cancelled.');
          return;
        }
        payload = await parseBackupFile(file, password);
      }
      await restoreBackup(payload);
      setProfile(payload.profile.nickname ?? '', payload.profile.avatar);
      setTheme(payload.profile.theme);
      setBackupMessage('Backup imported successfully.');
    } catch (error) {
      setBackupMessage(error instanceof Error ? error.message : 'Failed to import backup.');
    } finally {
      e.target.value = '';
    }
  };

  const themes: { id: Theme; name: string; color: string }[] = [
    { id: 'dark', name: 'Midnight', color: 'bg-[#020617]' },
    { id: 'cyberpunk', name: 'Cyberpunk', color: 'bg-[#05010d]' },
    { id: 'forest', name: 'Forest', color: 'bg-[#052e16]' },
    { id: 'light', name: 'Cloud', color: 'bg-white' },
  ];
  const designStyles: { id: DesignStyle; name: string; description: string }[] = [
    { id: 'glass', name: 'Glassmorphism', description: 'Blurred translucent panels' },
    { id: 'neumorph', name: 'Neumorphism', description: 'Soft inset and raised surfaces' },
  ];

  const getCallOutcomeTone = (outcome: string) => {
    switch (outcome) {
      case 'connected':
        return 'text-emerald-300';
      case 'missed':
      case 'failed':
        return 'text-red-300';
      case 'declined':
        return 'text-amber-200';
      default:
        return 'text-text-muted';
    }
  };

  const getCallIcon = (direction: string, outcome: string) => {
    if (outcome === 'missed' || outcome === 'failed') {
      return PhoneMissed;
    }
    return direction === 'incoming' ? PhoneIncoming : PhoneOutgoing;
  };

  const connectionTone = connectionStatus === 'connected'
    ? 'text-emerald-300'
    : connectionStatus === 'offline'
      ? 'text-red-300'
      : 'text-amber-200';

  return (
    <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/60 px-3 py-3 backdrop-blur-md sm:items-center sm:p-4">
      <div className="flex max-h-[100dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] premium-glass shadow-2xl animate-in fade-in zoom-in duration-300 sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-white/10 bg-slate-950/75 px-4 py-4 sm:px-6">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Palette className="w-5 h-5 text-accent" />
            Settings
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="max-h-[calc(100dvh-132px)] space-y-6 overflow-y-auto p-4 sm:max-h-[70vh] sm:space-y-8 sm:p-8">
          {/* Profile Section */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
              <User className="w-4 h-4" />
              Profile
            </h3>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
              <div className="relative group self-start">
                <div className="h-20 w-20 overflow-hidden rounded-2xl border-2 border-accent/30 bg-slate-800 sm:h-24 sm:w-24">
                  {tempAvatar ? (
                    <img src={tempAvatar} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-3xl font-bold text-accent">
                      {tempNick.charAt(0) || '?'}
                    </div>
                  )}
                </div>
                <label className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-2xl bg-black/60 opacity-0 transition-opacity group-hover:opacity-100">
                  <Camera className="w-6 h-6 text-white" />
                  <input type="file" className="hidden" accept="image/*" onChange={handleAvatarChange} />
                </label>
              </div>
              <div className="flex-1 space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-text-muted">Display Name</label>
                  <input 
                    type="text" 
                    value={tempNick}
                    onChange={(e) => setTempNick(e.target.value)}
                    placeholder="Enter your nickname..."
                    className="w-full px-4 py-3 bg-white/5 rounded-xl border border-white/10 focus:border-accent outline-none transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-text-muted">Username (@handle)</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted select-none">@</span>
                    <input 
                      type="text" 
                      value={tempUsername}
                      onChange={(e) => setTempUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                      placeholder="your_handle"
                      className={`w-full py-3 pl-9 pr-4 bg-white/5 rounded-xl border outline-none transition-all ${
                        profileError ? 'border-red-400 focus:border-red-500' : 'border-white/10 focus:border-accent'
                      }`}
                    />
                  </div>
                  {profileError ? (
                    <div className="text-xs text-red-400 mt-1">{profileError}</div>
                  ) : (
                    <div className="text-xs text-text-muted mt-1">Global handle to let people find you</div>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Appearance Section */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
              <Palette className="w-4 h-4" />
              Appearance
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {themes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTheme(t.id)}
                  className={`p-4 rounded-2xl border-2 transition-all flex flex-col items-center gap-3 ${
                    theme === t.id ? 'border-accent bg-accent/10 shadow-lg' : 'border-white/10 hover:border-white/20'
                  }`}
                >
                  <div className={`w-8 h-8 rounded-full shadow-inner ${t.color}`} />
                  <span className="text-xs font-medium">{t.name}</span>
                </button>
              ))}
            </div>
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-[0.22em] text-text-muted flex items-center gap-2">
                <Layers className="w-3.5 h-3.5" />
                Surface style
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {designStyles.map((style) => (
                  <button
                    key={style.id}
                    onClick={() => setDesignStyle(style.id)}
                    className={`rounded-2xl border p-4 text-left transition-all ${
                      designStyle === style.id
                        ? 'border-accent bg-accent/10 shadow-lg'
                        : 'border-white/10 bg-white/5 hover:border-white/20'
                    }`}
                  >
                    <div className="text-sm font-semibold text-white">{style.name}</div>
                    <div className="mt-1 text-xs text-text-muted">{style.description}</div>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
              <Database className="w-4 h-4" />
              Workspace Overview
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Chats</div>
                <div className="mt-2 text-xl font-semibold text-white">{contacts?.length ?? 0}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Unread</div>
                <div className="mt-2 text-xl font-semibold text-accent">{unreadChatCount}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Archived</div>
                <div className="mt-2 text-xl font-semibold text-violet-200">{archivedChatCount}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Groups</div>
                <div className="mt-2 text-xl font-semibold text-white">{groups?.length ?? 0}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Owned groups</div>
                <div className="mt-2 text-xl font-semibold text-cyan-200">{ownedGroupCount}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Channels</div>
                <div className="mt-2 text-xl font-semibold text-white">{channels?.length ?? 0}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:col-span-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Owned channels</div>
                    <div className="mt-2 text-xl font-semibold text-violet-200">{ownedChannelCount}</div>
                  </div>
                <div className="max-w-[220px] text-right text-xs leading-5 text-text-muted">
                  Overview cards moved here so the sidebar can stay focused on navigation and creation.
                </div>
              </div>
            </div>
            </div>
          </section>

          {/* Account Section */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
              <Shield className="w-4 h-4" />
              Account
            </h3>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Lock className="w-4 h-4 text-accent" />
                App Lock
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder={pinHash ? 'New 4-digit PIN' : '4-digit PIN'}
                  className="w-full px-4 py-3 bg-black/30 rounded-xl border border-white/10 focus:border-accent outline-none transition-all"
                />
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={pinConfirm}
                  onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="Confirm PIN"
                  className="w-full px-4 py-3 bg-black/30 rounded-xl border border-white/10 focus:border-accent outline-none transition-all"
                />
              </div>
              <div className="flex flex-wrap gap-3">
                <button onClick={() => void handleSavePin()} className="btn-premium px-5 py-2.5">
                  {pinHash ? 'Update PIN' : 'Enable PIN Lock'}
                </button>
                <button onClick={lockApp} disabled={!pinHash} className="px-5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-all">
                  Lock Now
                </button>
                <button onClick={handleRemovePin} disabled={!pinHash} className="px-5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-all text-red-300">
                  Disable PIN
                </button>
              </div>
              <div className="text-xs text-text-muted min-h-4">{pinMessage}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Database className="w-4 h-4 text-accent" />
                Backup
              </div>
              <p className="text-xs text-text-muted">
                Export or restore your local profile, contacts and chat history. Secret encryption keys are intentionally excluded.
              </p>
              <div className="flex flex-wrap gap-3">
                <button onClick={() => void handleExportBackup()} className="btn-premium px-5 py-2.5 flex items-center gap-2">
                  <Download className="w-4 h-4" />
                  Export Backup
                </button>
                <label className="px-5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 transition-all cursor-pointer flex items-center gap-2">
                  <Upload className="w-4 h-4" />
                  Import Backup
                  <input type="file" accept="application/json" className="hidden" onChange={(e) => void handleImportBackup(e)} />
                </label>
              </div>
              <div className="text-xs text-text-muted min-h-4">{backupMessage}</div>
            </div>
            <button 
              onClick={handleLogout}
              className="w-full p-4 rounded-xl border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 text-red-400 flex items-center justify-between transition-all"
            >
              <div className="flex items-center gap-3">
                <LogOut className="w-5 h-5" />
                <span className="font-medium">Logout and Clear Session</span>
              </div>
            </button>
          </section>

          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
              <Palette className="w-4 h-4" />
              Productivity
            </h3>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3">
              <div className="text-sm font-medium">Keyboard Shortcuts</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-text-muted">
                <div className="rounded-xl bg-black/20 px-3 py-2">
                  <span className="font-semibold text-white">Ctrl + F</span> focuses message search
                </div>
                <div className="rounded-xl bg-black/20 px-3 py-2">
                  <span className="font-semibold text-white">Ctrl + Shift + M</span> mutes or unmutes the active chat
                </div>
                <div className="rounded-xl bg-black/20 px-3 py-2">
                  <span className="font-semibold text-white">Ctrl + Shift + A</span> archives or restores the active chat
                </div>
                <div className="rounded-xl bg-black/20 px-3 py-2">
                  <span className="font-semibold text-white">Escape</span> clears chat search or returns to the chat list
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
              <Shield className="w-4 h-4" />
              Release Diagnostics
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Secure transport</div>
                <div className={`mt-2 text-sm font-medium ${connectionTone}`}>{connectionStatus}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Queued group sends</div>
                <div className="mt-2 text-sm font-medium text-white">{pendingGroupEventsCount ?? 0}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Pending group invites</div>
                <div className="mt-2 text-sm font-medium text-white">{pendingGroupInvitesCount ?? 0}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Recent call issues</div>
                <div className={`mt-2 text-sm font-medium ${recentCallIssues.length > 0 ? 'text-amber-200' : 'text-emerald-300'}`}>
                  {recentCallIssues.length > 0 ? `${recentCallIssues.length} need review` : 'No recent issues'}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Group sync</div>
                <div className={`mt-2 text-sm font-medium ${
                  groupSyncStatus.state === 'error' ? 'text-red-300' : groupSyncStatus.state === 'syncing' ? 'text-amber-200' : 'text-emerald-300'
                }`}>
                  {groupSyncStatus.state}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Channel sync</div>
                <div className={`mt-2 text-sm font-medium ${
                  channelSyncStatus.state === 'error' ? 'text-red-300' : channelSyncStatus.state === 'syncing' ? 'text-amber-200' : 'text-emerald-300'
                }`}>
                  {channelSyncStatus.state}
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-xs text-text-muted">
              Use this section before a release candidate run: pending group sends should be zero, transport should be connected, and repeated missed or failed calls should be investigated before shipping.
            </div>
            {(groupSyncStatus.error || channelSyncStatus.error) ? (
              <div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-xs text-red-100">
                {groupSyncStatus.error ? `Group sync: ${groupSyncStatus.error}` : null}
                {groupSyncStatus.error && channelSyncStatus.error ? ' • ' : null}
                {channelSyncStatus.error ? `Channel sync: ${channelSyncStatus.error}` : null}
              </div>
            ) : null}
          </section>

          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
              <PhoneCall className="w-4 h-4" />
              Call History
            </h3>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3">
              {recentCallIssues.length > 0 ? (
                <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-100/80">Needs Attention</div>
                  <div className="mt-2 space-y-2">
                    {recentCallIssues.slice(0, 3).map((entry) => {
                      const contact = contacts?.find((item) => item.pubKey === entry.peerPubKey);
                      const displayName = contact?.name || `${entry.peerPubKey.substring(0, 16)}...`;
                      return (
                        <div key={`issue-${entry.id}`} className="flex items-center justify-between gap-3 text-xs text-amber-50">
                          <span className="truncate">{displayName}</span>
                          <span className="shrink-0 uppercase tracking-wide">{entry.outcome}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {callHistory === undefined ? (
                <div className="text-xs text-text-muted">Loading recent calls...</div>
              ) : callHistory.length === 0 ? (
                <div className="text-xs text-text-muted">No calls yet. Your recent call events will show up here.</div>
              ) : (
                callHistory.map((entry) => {
                  const Icon = getCallIcon(entry.direction, entry.outcome);
                  const contact = contacts?.find((item) => item.pubKey === entry.peerPubKey);
                  const displayName = contact?.name || `${entry.peerPubKey.substring(0, 16)}...`;
                  return (
                    <div key={entry.id} className="flex items-center justify-between rounded-xl bg-black/20 px-3 py-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`rounded-full bg-white/5 p-2 ${getCallOutcomeTone(entry.outcome)}`}>
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm text-white">{displayName}</div>
                          <div className="mt-1 text-xs text-text-muted">
                            {entry.direction} • {entry.media} • {entry.outcome}
                          </div>
                        </div>
                      </div>
                      <div className="text-[11px] text-text-muted">
                        {new Date(entry.createdAt).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>

        <div className="flex justify-end gap-3 border-t border-white/10 bg-black/20 px-4 py-4 sm:gap-4 sm:p-6">
          <button onClick={onClose} className="px-6 py-2.5 rounded-xl text-sm font-medium hover:bg-white/5 transition-all">
            Cancel
          </button>
          <button onClick={handleSaveProfile} className="btn-premium px-8">
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};
