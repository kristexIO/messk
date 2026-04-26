import { create } from 'zustand';
import { migrateLocalDataToEncryptedAtRest, persistIdentityKeyPair, setVaultKey, switchActiveDatabase } from '../lib/db';

export type Theme = 'dark' | 'light' | 'cyberpunk' | 'forest';

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
  
  // UI State
  typingStatus: Record<string, boolean>;
  connectionStatus: 'offline' | 'connecting' | 'connected' | 'reconnecting';
  groupSyncStatus: CollectionSyncStatus;
  channelSyncStatus: CollectionSyncStatus;
  isLocked: boolean;
  pinHash: string | null;
  theme: Theme;

  // Actions
  setKeys: (publicKey: string, secretKey: string) => void;
  setProfile: (nickname: string, avatar: string | null) => void;
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

export const useAppStore = create<AppState>((set) => ({
  myPublicKey: null,
  mySecretKey: null,
  activePeerKey: null,
  activeGroupId: null,
  activeChannelId: null,
  
  nickname: savedSettings.nickname || null,
  avatar: savedSettings.avatar || null,
  
  typingStatus: {},
  connectionStatus: 'offline',
  groupSyncStatus: { state: 'idle', lastSyncAt: null, error: null },
  channelSyncStatus: { state: 'idle', lastSyncAt: null, error: null },
  isLocked: false,
  pinHash: savedSettings.pinHash || null,
  theme: savedSettings.theme || 'dark',

  setKeys: (publicKey, secretKey) => {
    switchActiveDatabase(publicKey);
    setVaultKey(secretKey);
    set({ myPublicKey: publicKey, mySecretKey: secretKey });
    void persistIdentityKeyPair(publicKey, secretKey).catch((error) => {
      console.error('Failed to persist current identity key pair', error);
    });
    void migrateLocalDataToEncryptedAtRest().catch((error) => {
      console.error('Failed to migrate local encrypted data', error);
    });
  },
  
  setProfile: (nickname, avatar) => {
    set({ nickname, avatar });
    localStorage.setItem('messenger_settings', JSON.stringify({
      ...loadSettings(),
      nickname,
      avatar
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
  
  logout: () => {
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
      pinHash: null
    });
    // Keep theme and nickname on logout for convenience
  },
}));

// Initialize theme on load
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', savedSettings.theme || 'dark');
}
