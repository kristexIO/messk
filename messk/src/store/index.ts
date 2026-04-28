import { create } from 'zustand';
import { migrateLocalDataToEncryptedAtRest, persistIdentityKeyPair, setVaultKey, switchActiveDatabase } from '../lib/db';

export type Theme = 'dark' | 'light' | 'cyberpunk' | 'forest';
export type DesignStyle = 'glass' | 'neumorph' | 'telegram';
export type Language = 'en' | 'ru' | 'fr' | 'de';

export type CollectionSyncStatus = {
  state: 'idle' | 'syncing' | 'synced' | 'error';
  lastSyncAt: number | null;
  error: string | null;
};

interface AppState {
  myPublicKey: string | null;
  mySecretKey: string | null;
  activePeerKey: string | null;
  activeGroupId: string | null;
  activeChannelId: string | null;
  
  // Profile
  nickname: string | null;
  avatar: string | null; // Base64 avatar
  username: string | null;
  
  // UI State
  typingStatus: Record<string, boolean>;
  connectionStatus: 'offline' | 'connecting' | 'connected' | 'reconnecting';
  groupSyncStatus: CollectionSyncStatus;
  channelSyncStatus: CollectionSyncStatus;
  isLocked: boolean;
  pinHash: string | null;
  theme: Theme;
  designStyle: DesignStyle;
  language: Language;
  isRestoringIdentity: boolean;
  isIdentityRemembered: boolean;

  // Actions
  setKeys: (publicKey: string, secretKey: string) => void;
  setProfile: (nickname: string, avatar: string | null, username: string | null) => void;
  setActivePeer: (peerKey: string | null) => void;
  setActiveGroup: (groupId: string | null) => void;
  setActiveChannel: (channelId: string | null) => void;
  setTyping: (peerKey: string, isTyping: boolean) => void;
  setConnectionStatus: (status: AppState['connectionStatus']) => void;
  setGroupSyncStatus: (status: Partial<CollectionSyncStatus>) => void;
  setChannelSyncStatus: (status: Partial<CollectionSyncStatus>) => void;
  setLocked: (isLocked: boolean) => void;
  setPinHash: (pinHash: string | null) => void;
  lockApp: () => void;
  setTheme: (theme: Theme) => void;
  setDesignStyle: (designStyle: DesignStyle) => void;
  setLanguage: (language: Language) => void;
  restoreRememberedIdentity: () => Promise<void>;
  forgetRememberedIdentity: () => void;
  logout: () => void;
}

// Helper to load settings from local storage
const loadSettings = () => {
  try {
    const saved = localStorage.getItem('messenger_settings');
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
};

const savedSettings = loadSettings();
const REMEMBERED_IDENTITY_KEY = 'messenger_remembered_identity';

const normalizeLanguage = (value: unknown): Language => {
  return value === 'ru' || value === 'fr' || value === 'de' || value === 'en' ? value : 'en';
};

const normalizeTheme = (value: unknown): Theme => {
  return value === 'light' || value === 'cyberpunk' || value === 'forest' || value === 'dark' ? value : 'dark';
};

const normalizeDesignStyle = (value: unknown): DesignStyle => {
  return value === 'neumorph' || value === 'telegram' || value === 'glass' ? value : 'glass';
};

const loadRememberedIdentity = (): { publicKey: string; secretKey: string } | null => {
  try {
    const saved = localStorage.getItem(REMEMBERED_IDENTITY_KEY);
    if (!saved) {
      return null;
    }
    const parsed = JSON.parse(saved) as Partial<{ publicKey: string; secretKey: string }>;
    if (typeof parsed.publicKey !== 'string' || typeof parsed.secretKey !== 'string') {
      return null;
    }
    return { publicKey: parsed.publicKey, secretKey: parsed.secretKey };
  } catch {
    return null;
  }
};

const rememberIdentity = (publicKey: string, secretKey: string) => {
  localStorage.setItem(REMEMBERED_IDENTITY_KEY, JSON.stringify({ publicKey, secretKey }));
};

const removeRememberedIdentity = () => {
  localStorage.removeItem(REMEMBERED_IDENTITY_KEY);
};

const loadProfileForKey = (publicKey: string): { nickname?: string | null; avatar?: string | null; username?: string | null } | null => {
  const profiles = loadSettings().profiles;
  if (!profiles || typeof profiles !== 'object') {
    return null;
  }
  const profile = profiles[publicKey];
  if (!profile || typeof profile !== 'object') {
    return null;
  }
  return profile;
};

export const useAppStore = create<AppState>((set, get) => ({
  myPublicKey: null,
  mySecretKey: null,
  activePeerKey: null,
  activeGroupId: null,
  activeChannelId: null,
  
  nickname: savedSettings.nickname || null,
  avatar: savedSettings.avatar || null,
  username: savedSettings.username || null,
  
  typingStatus: {},
  connectionStatus: 'offline',
  groupSyncStatus: { state: 'idle', lastSyncAt: null, error: null },
  channelSyncStatus: { state: 'idle', lastSyncAt: null, error: null },
  isLocked: false,
  pinHash: savedSettings.pinHash || null,
  theme: normalizeTheme(savedSettings.theme),
  designStyle: normalizeDesignStyle(savedSettings.designStyle),
  language: normalizeLanguage(savedSettings.language),
  isRestoringIdentity: true,
  isIdentityRemembered: loadRememberedIdentity() !== null,

  setKeys: (publicKey, secretKey) => {
    switchActiveDatabase(publicKey);
    setVaultKey(secretKey);
    rememberIdentity(publicKey, secretKey);
    const savedProfile = loadProfileForKey(publicKey);
    set({
      myPublicKey: publicKey,
      mySecretKey: secretKey,
      nickname: savedProfile?.nickname ?? null,
      avatar: savedProfile?.avatar ?? null,
      username: savedProfile?.username ?? null,
      isRestoringIdentity: false,
      isIdentityRemembered: true,
    });
    void persistIdentityKeyPair(publicKey, secretKey).catch((error) => {
      console.error('Failed to persist current identity key pair', error);
    });
    void migrateLocalDataToEncryptedAtRest().catch((error) => {
      console.error('Failed to migrate local encrypted data', error);
    });
  },
  
  setProfile: (nickname, avatar, username) => {
    const publicKey = get().myPublicKey;
    const settings = loadSettings();
    const profiles = publicKey
      ? {
          ...(settings.profiles ?? {}),
          [publicKey]: { nickname, avatar, username },
        }
      : settings.profiles;

    set({ nickname, avatar, username });
    localStorage.setItem('messenger_settings', JSON.stringify({
      ...settings,
      nickname,
      avatar,
      username,
      profiles,
    }));
  },
  
  setActivePeer: (peerKey) => set({ activePeerKey: peerKey, activeGroupId: null, activeChannelId: null }),
  setActiveGroup: (groupId) => set({ activeGroupId: groupId, activePeerKey: null, activeChannelId: null }),
  setActiveChannel: (channelId) => set({ activeChannelId: channelId, activePeerKey: null, activeGroupId: null }),
  
  setTyping: (peerKey, isTyping) => set((state) => ({
    typingStatus: { ...state.typingStatus, [peerKey]: isTyping }
  })),

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setGroupSyncStatus: (status) => set((state) => ({
    groupSyncStatus: { ...state.groupSyncStatus, ...status },
  })),
  setChannelSyncStatus: (status) => set((state) => ({
    channelSyncStatus: { ...state.channelSyncStatus, ...status },
  })),
  
  setLocked: (isLocked) => set({ isLocked }),

  setPinHash: (pinHash) => {
    set((state) => ({ pinHash, isLocked: pinHash ? state.isLocked : false }));
    localStorage.setItem('messenger_settings', JSON.stringify({
      ...loadSettings(),
      pinHash
    }));
  },

  lockApp: () => set((state) => state.pinHash ? { isLocked: true } : state),
  
  setTheme: (theme) => {
    set({ theme });
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('messenger_settings', JSON.stringify({
      ...loadSettings(),
      theme
    }));
  },

  setDesignStyle: (designStyle) => {
    set({ designStyle });
    document.documentElement.setAttribute('data-style', designStyle);
    localStorage.setItem('messenger_settings', JSON.stringify({
      ...loadSettings(),
      designStyle
    }));
  },

  setLanguage: (language) => {
    set({ language });
    localStorage.setItem('messenger_settings', JSON.stringify({
      ...loadSettings(),
      language
    }));
  },

  restoreRememberedIdentity: async () => {
    const identity = loadRememberedIdentity();
    if (!identity) {
      set({ isRestoringIdentity: false, isIdentityRemembered: false });
      return;
    }

    switchActiveDatabase(identity.publicKey);
    setVaultKey(identity.secretKey);
    const savedProfile = loadProfileForKey(identity.publicKey);
    set({
      myPublicKey: identity.publicKey,
      mySecretKey: identity.secretKey,
      nickname: savedProfile?.nickname ?? savedSettings.nickname ?? null,
      avatar: savedProfile?.avatar ?? savedSettings.avatar ?? null,
      username: savedProfile?.username ?? savedSettings.username ?? null,
      isRestoringIdentity: false,
      isIdentityRemembered: true,
    });

    void migrateLocalDataToEncryptedAtRest().catch((error) => {
      console.error('Failed to migrate local encrypted data', error);
    });
  },

  forgetRememberedIdentity: () => {
    removeRememberedIdentity();
    set({ isIdentityRemembered: false });
  },
  
  logout: () => {
    removeRememberedIdentity();
    switchActiveDatabase(null);
    setVaultKey(null);
    set({
      myPublicKey: null,
      mySecretKey: null,
      activePeerKey: null,
      activeGroupId: null,
      activeChannelId: null,
      typingStatus: {},
      connectionStatus: 'offline',
      groupSyncStatus: { state: 'idle', lastSyncAt: null, error: null },
      channelSyncStatus: { state: 'idle', lastSyncAt: null, error: null },
      isLocked: false,
      pinHash: null,
      isRestoringIdentity: false,
      isIdentityRemembered: false,
    });
    // Keep theme and nickname on logout for convenience
  },
}));

// Initialize theme on load
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', normalizeTheme(savedSettings.theme));
  document.documentElement.setAttribute('data-style', normalizeDesignStyle(savedSettings.designStyle));
}
