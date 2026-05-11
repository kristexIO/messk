import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../store';
import type { DesignStyle, FontSize, InterfaceDensity, Language, Theme, UiMode } from '../store';
import { X, User, Palette, Shield, LogOut, Camera, Lock, Download, Upload, Database, PhoneCall, PhoneIncoming, PhoneOutgoing, PhoneMissed, Layers } from 'lucide-react';
import { socketManager } from '../lib/socket';
import { db, getDatabaseNameForIdentity } from '../lib/db';
import { useLiveQuery } from 'dexie-react-hooks';
import Dexie from 'dexie';
import { clearRememberedIdentity, hashPin, rememberIdentityWithPin, verifyPin } from '../lib/security';
import { createEncryptedBackup, downloadEncryptedBackup, parseBackupFile, restoreBackup } from '../lib/backup';
import { prepareAvatarDataUrl } from '../lib/images';
import { useI18n } from '../lib/i18n';
import { SETTINGS_STORAGE_KEY } from '../lib/storage';

interface SettingsModalProps {
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  const {
    nickname,
    avatar,
    username,
    mySecretKey,
    myPublicKey,
    theme,
    designStyle,
    uiMode,
    fontSize,
    interfaceDensity,
    autoLockMinutes,
    setTheme,
    setDesignStyle,
    setUiMode,
    setFontSize,
    setInterfaceDensity,
    setAutoLockMinutes,
    language,
    setLanguage,
    setProfile,
    logout,
    isIdentityRemembered,
    forgetRememberedIdentity,
    setIdentityRemembered,
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
  const [securityMessage, setSecurityMessage] = useState('');
  const [sessions, setSessions] = useState<Array<{
    token: string;
    createdAt: string;
    lastSeen: string;
    expiresAt: string;
    userAgent: string;
    remoteIp: string;
  }>>([]);
  const [currentSessionToken, setCurrentSessionToken] = useState('');
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionActionToken, setSessionActionToken] = useState<string | null>(null);
  const { t } = useI18n();
  const callHistory = useLiveQuery(() => db.callHistory.orderBy('createdAt').reverse().limit(12).toArray(), []);
  const contacts = useLiveQuery(() => db.contacts.toArray(), []);
  const groups = useLiveQuery(() => db.groupThreads.toArray(), []);
  const channels = useLiveQuery(() => db.channelThreads.toArray(), []);
  const threadStats = useLiveQuery(() => db.threadStats.toArray(), []);
  const pendingGroupEventsCount = useLiveQuery(() => db.outgoingGroupEvents.count(), []);
  const pendingDirectMessagesCount = useLiveQuery(() => db.outgoingDirectMessages.count(), []);
  const pendingGroupInvitesCount = useLiveQuery(() => db.groupInvites.count(), []);
  const recentCallIssues = React.useMemo(
    () => (callHistory ?? []).filter((entry) => entry.outcome === 'missed' || entry.outcome === 'failed'),
    [callHistory]
  );
  const contactByPubKey = React.useMemo(
    () => new Map((contacts ?? []).map((contact) => [contact.pubKey, contact] as const)),
    [contacts]
  );
  const unreadChatCount = React.useMemo(
    () =>
      (threadStats ?? []).reduce((total, stat) => {
        const hasUnread = (stat.unreadCount ?? 0) > 0;
        const isChatThread = contactByPubKey.has(stat.threadId);
        return total + (hasUnread && isChatThread ? stat.unreadCount ?? 0 : 0);
      }, 0),
    [contactByPubKey, threadStats]
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

  const loadSessions = React.useCallback(async () => {
    try {
      setSessionsLoading(true);
      const payload = await socketManager.listSessions();
      setSessions(payload.sessions ?? []);
      setCurrentSessionToken(payload.currentToken ?? '');
    } catch (error) {
      setSecurityMessage(error instanceof Error ? error.message : 'Failed to load sessions.');
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSessions();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSessions]);

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
    const databaseNames = Array.from(new Set([
      getDatabaseNameForIdentity(myPublicKey),
      getDatabaseNameForIdentity(null),
    ]));
    socketManager.disconnect();
    localStorage.removeItem(SETTINGS_STORAGE_KEY);
    logout();
    db.close();
    void Promise.all(databaseNames.map((databaseName) => Dexie.delete(databaseName).catch(() => undefined)))
      .finally(() => window.location.reload());
  };

  const handleForgetDevice = () => {
    forgetRememberedIdentity();
    setSecurityMessage('Secure device restore disabled. Reopening the app will require your seed phrase again.');
  };

  const handleRememberDevice = async () => {
    if (!pinHash) {
      setSecurityMessage('Set a PIN first to enable secure restore on this device.');
      return;
    }
    if (!myPublicKey || !mySecretKey) {
      setSecurityMessage('Sign in before enabling secure device restore.');
      return;
    }

    const pin = window.prompt('Enter your current PIN to enable secure restore on this device.');
    if (!pin) {
      setSecurityMessage('Device restore setup cancelled.');
      return;
    }

    const validPin = await verifyPin(pin, pinHash);
    if (!validPin) {
      setSecurityMessage('PIN verification failed. Device restore was not enabled.');
      return;
    }

    await rememberIdentityWithPin(myPublicKey, mySecretKey, pin);
    setIdentityRemembered(true);
    setSecurityMessage('This device can now restore your session after refresh or restart using your PIN.');
  };

  const handleRevokeSession = async (token: string) => {
    try {
      setSessionActionToken(token);
      await socketManager.revokeSession(token);
      setSecurityMessage('Session revoked.');
      await loadSessions();
    } catch (error) {
      setSecurityMessage(error instanceof Error ? error.message : 'Failed to revoke session.');
    } finally {
      setSessionActionToken(null);
    }
  };

  const handleRevokeOthers = async () => {
    try {
      setSessionActionToken('all');
      const result = await socketManager.revokeOtherSessions();
      setSecurityMessage(`Closed ${result.revoked} other session(s).`);
      await loadSessions();
    } catch (error) {
      setSecurityMessage(error instanceof Error ? error.message : 'Failed to revoke sessions.');
    } finally {
      setSessionActionToken(null);
    }
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
    if (myPublicKey && mySecretKey) {
      await rememberIdentityWithPin(myPublicKey, mySecretKey, pinInput);
      setIdentityRemembered(true);
      setSecurityMessage('This device can now restore your session after refresh or restart using your PIN.');
    }
    setPinInput('');
    setPinConfirm('');
    setPinMessage('PIN lock enabled.');
  };

  const handleRemovePin = () => {
    clearRememberedIdentity();
    setIdentityRemembered(false);
    setPinHash(null);
    setPinInput('');
    setPinConfirm('');
    setPinMessage('PIN lock disabled.');
    setSecurityMessage('Secure device restore disabled.');
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
      setProfile(payload.profile.nickname ?? '', payload.profile.avatar, null);
      setTheme(payload.profile.theme);
      setBackupMessage('Backup imported successfully.');
    } catch (error) {
      setBackupMessage(error instanceof Error ? error.message : 'Failed to import backup.');
    } finally {
      e.target.value = '';
    }
  };

  const handleExportSettingsOnly = () => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: {
        nickname,
        avatar,
        username,
      },
      appearance: {
        theme,
        uiMode,
        designStyle,
        fontSize,
        interfaceDensity,
        language,
      },
      security: {
        autoLockMinutes,
        hasPin: Boolean(pinHash),
        remembersDevice: isIdentityRemembered,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `messk-settings-${payload.exportedAt.slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setBackupMessage('Settings-only export saved. Messages and keys are excluded.');
  };

  const themes: { id: Theme; name: string; color: string }[] = [
    { id: 'system', name: 'System', color: 'settings-theme-system' },
    { id: 'dark', name: 'Slate', color: 'bg-[#17212b]' },
    { id: 'cyberpunk', name: 'Violet', color: 'bg-[#4c4176]' },
    { id: 'forest', name: 'Pine', color: 'bg-[#276747]' },
    { id: 'light', name: 'Cloud', color: 'bg-[#f5f8fb]' },
  ];
  const languages: { id: Language; code: string; label: string }[] = [
    { id: 'en', code: 'EN', label: t('english') },
    { id: 'ru', code: 'RU', label: t('russian') },
    { id: 'fr', code: 'FR', label: t('french') },
    { id: 'de', code: 'DE', label: t('german') },
  ];
  const designStyles: { id: DesignStyle; name: string; description: string; previewClass: string }[] = [
    {
      id: 'glass',
      name: 'Glassmorphism',
      description: 'Blurred translucent panels',
      previewClass: 'settings-preview-glass',
    },
    {
      id: 'neumorph',
      name: 'Neumorphism',
      description: 'Soft inset and raised surfaces',
      previewClass: 'settings-preview-neumorph',
    },
    {
      id: 'telegram',
      name: 'Telegram Flow',
      description: 'Deep blue navigation and compact chat bubbles',
      previewClass: 'settings-preview-telegram',
    },
  ];
  const uiModes: { id: UiMode; name: string; description: string }[] = [
    { id: 'classic', name: 'Classic UI', description: 'Strict compact messenger layout' },
    { id: 'next', name: 'Next UI', description: 'Expressive glass layout with larger hierarchy' },
  ];
  const fontSizes: { id: FontSize; name: string }[] = [
    { id: 'small', name: 'Small' },
    { id: 'normal', name: 'Normal' },
    { id: 'large', name: 'Large' },
  ];
  const densities: { id: InterfaceDensity; name: string; description: string }[] = [
    { id: 'compact', name: 'Compact', description: 'Tighter list and chat spacing' },
    { id: 'comfortable', name: 'Comfortable', description: 'More room for long sessions' },
  ];
  const autoLockOptions = [
    { value: 0, label: 'Never' },
    { value: 5, label: '5 min' },
    { value: 15, label: '15 min' },
    { value: 30, label: '30 min' },
    { value: 60, label: '1 hour' },
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

  const modal = (
    <div className="settings-backdrop fixed inset-0 z-[200] flex items-center justify-center px-3 py-3 backdrop-blur-md sm:p-4">
      <div className="settings-panel flex max-h-[calc(100dvh-24px)] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] shadow-2xl animate-in fade-in zoom-in duration-300 sm:max-h-[min(880px,calc(100dvh-32px))] sm:rounded-3xl">
        <div className="settings-header flex items-center justify-between px-4 py-4 sm:px-6">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Palette className="w-5 h-5 text-accent" />
            {t('settings')}
          </h2>
          <div className="settings-header-actions">
            <div className="settings-language-pills" aria-label={t('language')}>
              {languages.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setLanguage(item.id)}
                  className={`settings-language-pill ${language === item.id ? 'is-active' : ''}`}
                  title={item.label}
                >
                  {item.code}
                </button>
              ))}
            </div>
            <button onClick={onClose} className="settings-icon-button p-2 rounded-full transition-colors" aria-label="Close settings">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="settings-body space-y-6 overflow-y-auto p-4 sm:space-y-8 sm:p-8">
          {/* Profile Section */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
              <User className="w-4 h-4" />
              {t('profile')}
            </h3>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
              <div className="relative group self-start">
                <div className="settings-avatar h-20 w-20 overflow-hidden rounded-2xl sm:h-24 sm:w-24">
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
                  <label className="text-xs text-text-muted">{t('displayName')}</label>
                  <input 
                    type="text" 
                    value={tempNick}
                    onChange={(e) => setTempNick(e.target.value)}
                    placeholder="Enter your nickname..."
                    className="settings-input w-full px-4 py-3 rounded-xl outline-none transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-text-muted">{t('username')}</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted select-none">@</span>
                    <input 
                      type="text" 
                      value={tempUsername}
                      onChange={(e) => setTempUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                      placeholder="your_handle"
                      className={`settings-input w-full py-3 pl-9 pr-4 rounded-xl outline-none transition-all ${
                        profileError ? 'settings-input-error' : ''
                      }`}
                    />
                  </div>
                  {profileError ? (
                    <div className="text-xs text-red-400 mt-1">{profileError}</div>
                  ) : (
                    <div className="text-xs text-text-muted mt-1">{t('usernameHint')}</div>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Appearance Section */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
              <Palette className="w-4 h-4" />
              {t('appearance')}
            </h3>
            <div className="settings-card rounded-2xl p-4">
              <div className="mb-3 text-xs uppercase tracking-[0.22em] text-text-muted">{t('language')}</div>
              <div className="grid grid-cols-2 gap-3">
                {languages.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setLanguage(item.id)}
                    className={`settings-choice settings-language-choice rounded-2xl px-4 py-3 text-left transition-all ${language === item.id ? 'is-active' : ''}`}
                  >
                    <div className="text-sm font-semibold">{item.code}</div>
                    <div className="mt-1 text-xs text-text-muted">{item.label}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {themes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTheme(t.id)}
                  className={`settings-choice p-4 rounded-2xl transition-all flex flex-col items-center gap-3 ${
                    theme === t.id ? 'is-active' : ''
                  }`}
                >
                  <div className={`settings-theme-preview ${t.color}`} aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="text-xs font-medium">{t.name}</span>
                </button>
              ))}
            </div>
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Interface mode</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {uiModes.map((mode) => (
                  <button
                    key={mode.id}
                    onClick={() => setUiMode(mode.id)}
                    className={`settings-choice rounded-2xl p-4 text-left transition-all ${
                      uiMode === mode.id ? 'is-active' : ''
                    }`}
                  >
                    <div className="text-sm font-semibold">{mode.name}</div>
                    <div className="mt-1 text-xs text-text-muted">{mode.description}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="settings-card rounded-2xl p-4">
                <div className="mb-3 text-xs uppercase tracking-[0.22em] text-text-muted">Font size</div>
                <div className="grid grid-cols-3 gap-2">
                  {fontSizes.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setFontSize(item.id)}
                      className={`settings-choice rounded-xl px-3 py-2 text-xs font-semibold transition-all ${fontSize === item.id ? 'is-active' : ''}`}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-card rounded-2xl p-4">
                <div className="mb-3 text-xs uppercase tracking-[0.22em] text-text-muted">Density</div>
                <div className="grid grid-cols-2 gap-2">
                  {densities.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setInterfaceDensity(item.id)}
                      className={`settings-choice rounded-xl px-3 py-2 text-left transition-all ${interfaceDensity === item.id ? 'is-active' : ''}`}
                    >
                      <div className="text-xs font-semibold">{item.name}</div>
                      <div className="mt-1 text-[10px] text-text-muted">{item.description}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {uiMode === 'next' ? (
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-[0.22em] text-text-muted flex items-center gap-2">
                <Layers className="w-3.5 h-3.5" />
                {t('surfaceStyle')}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {designStyles.map((style) => (
                  <button
                    key={style.id}
                    onClick={() => setDesignStyle(style.id)}
                    className={`settings-choice rounded-2xl p-4 text-left transition-all ${
                      designStyle === style.id ? 'is-active' : ''
                    }`}
                  >
                    <div className={`settings-design-preview ${style.previewClass}`} aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                    <div className="text-sm font-semibold">{style.name}</div>
                    <div className="mt-1 text-xs text-text-muted">{style.description}</div>
                  </button>
                ))}
              </div>
            </div>
            ) : null}
          </section>

          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
              <Database className="w-4 h-4" />
              {t('workspaceOverview')}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Chats</div>
                <div className="mt-2 text-xl font-semibold text-white">{contacts?.length ?? 0}</div>
              </div>
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Unread</div>
                <div className="mt-2 text-xl font-semibold text-accent">{unreadChatCount}</div>
              </div>
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Archived</div>
                <div className="mt-2 text-xl font-semibold text-violet-200">{archivedChatCount}</div>
              </div>
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Groups</div>
                <div className="mt-2 text-xl font-semibold text-white">{groups?.length ?? 0}</div>
              </div>
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Owned groups</div>
                <div className="mt-2 text-xl font-semibold text-cyan-200">{ownedGroupCount}</div>
              </div>
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Channels</div>
                <div className="mt-2 text-xl font-semibold text-white">{channels?.length ?? 0}</div>
              </div>
              <div className="settings-card rounded-2xl p-4 sm:col-span-3">
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
              {t('account')}
            </h3>
            <div className="settings-card rounded-2xl p-4 space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Shield className="w-4 h-4 text-accent" />
                    Device persistence
                  </div>
                  <p className="mt-2 text-xs leading-5 text-text-muted">
                    This device can keep an encrypted copy of your identity secret. It stays locked behind your PIN and lets you recover the session after refresh without exposing the raw key in browser storage.
                  </p>
                </div>
                <div className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  isIdentityRemembered ? 'bg-emerald-400/10 text-emerald-200' : 'bg-amber-400/10 text-amber-100'
                }`}>
                  {isIdentityRemembered ? 'PIN restore ready' : 'Seed required on restart'}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {isIdentityRemembered ? (
                  <button
                    onClick={handleForgetDevice}
                    className="settings-secondary-button px-5 py-2.5 rounded-xl transition-all"
                  >
                    Forget this device
                  </button>
                ) : (
                  <button
                    onClick={() => void handleRememberDevice()}
                    disabled={!pinHash || !mySecretKey}
                    className="settings-secondary-button px-5 py-2.5 rounded-xl transition-all disabled:opacity-60"
                  >
                    Remember this device
                  </button>
                )}
                <span className="text-xs text-text-muted">
                  {pinHash ? 'A valid PIN is required before this device can restore your session.' : 'Set a PIN first to allow encrypted restore on this device.'}
                </span>
              </div>
              <div className="text-xs text-text-muted min-h-4">{securityMessage}</div>
            </div>
            <div className="settings-card rounded-2xl p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">Active Sessions</div>
                <button
                  type="button"
                  onClick={() => void handleRevokeOthers()}
                  disabled={sessionsLoading || sessionActionToken === 'all'}
                  className="settings-secondary-button px-4 py-2 rounded-xl text-xs disabled:opacity-60"
                >
                  Logout other devices
                </button>
              </div>
              {sessionsLoading ? (
                <div className="text-xs text-text-muted">Loading sessions...</div>
              ) : sessions.length === 0 ? (
                <div className="text-xs text-text-muted">No active sessions found.</div>
              ) : (
                <div className="space-y-2">
                  {sessions.map((session) => {
                    const isCurrent = session.token === currentSessionToken;
                    return (
                      <div key={session.token} className="rounded-xl bg-black/20 px-3 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm text-white">{session.userAgent || 'Unknown device'}</div>
                            <div className="mt-1 text-[11px] text-text-muted">
                              {session.remoteIp || 'Unknown IP'} • Last seen {new Date(session.lastSeen).toLocaleString()}
                            </div>
                          </div>
                          {isCurrent ? (
                            <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-200">Current</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void handleRevokeSession(session.token)}
                              disabled={sessionActionToken === session.token}
                              className="rounded-lg border border-red-400/30 bg-red-400/10 px-2 py-1 text-xs text-red-100 disabled:opacity-60"
                            >
                              Logout
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="settings-card rounded-2xl p-4 space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Lock className="w-4 h-4 text-accent" />
                App Lock
              </div>
              <div>
                <div className="mb-2 text-xs uppercase tracking-[0.22em] text-text-muted">Auto-lock</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {autoLockOptions.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setAutoLockMinutes(item.value)}
                      className={`settings-choice rounded-xl px-3 py-2 text-xs font-semibold transition-all ${autoLockMinutes === item.value ? 'is-active' : ''}`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder={pinHash ? 'New 4-digit PIN' : '4-digit PIN'}
                  className="settings-input w-full px-4 py-3 rounded-xl outline-none transition-all"
                />
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={pinConfirm}
                  onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="Confirm PIN"
                  className="settings-input w-full px-4 py-3 rounded-xl outline-none transition-all"
                />
              </div>
              <div className="flex flex-wrap gap-3">
                <button onClick={() => void handleSavePin()} className="btn-premium px-5 py-2.5">
                  {pinHash ? 'Update PIN' : 'Enable PIN Lock'}
                </button>
                <button onClick={lockApp} disabled={!pinHash} className="settings-secondary-button px-5 py-2.5 rounded-xl disabled:opacity-50 transition-all">
                  Lock Now
                </button>
                <button onClick={handleRemovePin} disabled={!pinHash} className="settings-secondary-button px-5 py-2.5 rounded-xl disabled:opacity-50 transition-all text-red-300">
                  Disable PIN
                </button>
              </div>
              <div className="text-xs text-text-muted min-h-4">{pinMessage}</div>
            </div>
            <div className="settings-card rounded-2xl p-4 space-y-4">
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
                <button onClick={handleExportSettingsOnly} className="settings-secondary-button px-5 py-2.5 rounded-xl transition-all flex items-center gap-2">
                  <Download className="w-4 h-4" />
                  Export Settings Only
                </button>
                <label className="settings-secondary-button px-5 py-2.5 rounded-xl transition-all cursor-pointer flex items-center gap-2">
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
            <button
              onClick={handleLogout}
              className="w-full p-4 rounded-xl border border-red-500/40 bg-red-500/10 hover:bg-red-500/15 text-red-200 flex items-center justify-between transition-all"
            >
              <div className="flex items-center gap-3">
                <LogOut className="w-5 h-5" />
                <span className="font-medium">Panic Logout</span>
              </div>
            </button>
          </section>

          <section className="space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
              <Palette className="w-4 h-4" />
              {t('productivity')}
            </h3>
            <div className="settings-card rounded-2xl p-4 space-y-3">
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
              {t('releaseDiagnostics')}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Secure transport</div>
                <div className={`mt-2 text-sm font-medium ${connectionTone}`}>{connectionStatus}</div>
              </div>
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Queued direct sends</div>
                <div className="mt-2 text-sm font-medium text-white">{pendingDirectMessagesCount ?? 0}</div>
              </div>
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Queued group sends</div>
                <div className="mt-2 text-sm font-medium text-white">{pendingGroupEventsCount ?? 0}</div>
              </div>
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Pending group invites</div>
                <div className="mt-2 text-sm font-medium text-white">{pendingGroupInvitesCount ?? 0}</div>
              </div>
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Recent call issues</div>
                <div className={`mt-2 text-sm font-medium ${recentCallIssues.length > 0 ? 'text-amber-200' : 'text-emerald-300'}`}>
                  {recentCallIssues.length > 0 ? `${recentCallIssues.length} need review` : 'No recent issues'}
                </div>
              </div>
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Group sync</div>
                <div className={`mt-2 text-sm font-medium ${
                  groupSyncStatus.state === 'error' ? 'text-red-300' : groupSyncStatus.state === 'syncing' ? 'text-amber-200' : 'text-emerald-300'
                }`}>
                  {groupSyncStatus.state}
                </div>
              </div>
              <div className="settings-card rounded-2xl p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-text-muted">Channel sync</div>
                <div className={`mt-2 text-sm font-medium ${
                  channelSyncStatus.state === 'error' ? 'text-red-300' : channelSyncStatus.state === 'syncing' ? 'text-amber-200' : 'text-emerald-300'
                }`}>
                  {channelSyncStatus.state}
                </div>
              </div>
            </div>
            <div className="settings-card rounded-2xl px-4 py-3 text-xs text-text-muted">
              Use this section before a release candidate run: queued direct and group sends should be zero, transport should be connected, and repeated missed or failed calls should be investigated before shipping.
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
              {t('callHistory')}
            </h3>
            <div className="settings-card rounded-2xl p-4 space-y-3">
              {recentCallIssues.length > 0 ? (
                <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-100/80">Needs Attention</div>
                  <div className="mt-2 space-y-2">
                    {recentCallIssues.slice(0, 3).map((entry) => {
                      const contact = contactByPubKey.get(entry.peerPubKey);
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
                  const contact = contactByPubKey.get(entry.peerPubKey);
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

        <div className="settings-footer flex justify-end gap-3 px-4 py-4 sm:gap-4 sm:p-6">
          <button onClick={onClose} className="settings-secondary-button px-6 py-2.5 rounded-xl text-sm font-medium transition-all">
            {t('cancel')}
          </button>
          <button onClick={handleSaveProfile} className="btn-premium px-8">
            {t('saveChanges')}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};
