import { useAppStore } from '../store';
import { appConfig } from './config';
import { db } from './db';
import { fetchWithTimeout } from './http';

export type SessionListResponse = {
  sessions: Array<{
    token: string;
    createdAt: string;
    lastSeen: string;
    expiresAt: string;
    userAgent: string;
    remoteIp: string;
  }>;
  currentToken: string;
};

export type ResolvedUserProfile = {
  pubKey: string;
  nickname?: string;
  avatar?: string;
};

export class SocketApiClient {
  private profileRefreshAt = new Map<string, number>();
  private profileRefreshInFlight = new Map<string, Promise<void>>();
  private lastKnownProfilesRefreshAt = 0;
  private readonly getSessionToken: () => string | null;

  constructor(getSessionToken: () => string | null) {
    this.getSessionToken = getSessionToken;
  }

  getSessionHeaders(): HeadersInit {
    const sessionToken = this.getSessionToken();
    return sessionToken ? { 'X-Session-Token': sessionToken } : {};
  }

  async listSessions(): Promise<SessionListResponse> {
    const response = await fetchWithTimeout(`${appConfig.backendOrigin}/sessions`, {
      headers: this.getSessionHeaders(),
    });
    if (!response.ok) {
      throw new Error('Failed to load sessions');
    }
    return response.json() as Promise<SessionListResponse>;
  }

  async revokeSession(token: string) {
    const response = await fetchWithTimeout(`${appConfig.backendOrigin}/sessions?token=${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers: this.getSessionHeaders(),
    });
    if (!response.ok) {
      throw new Error('Failed to revoke session');
    }
  }

  async revokeOtherSessions() {
    const response = await fetchWithTimeout(`${appConfig.backendOrigin}/sessions?token=all`, {
      method: 'DELETE',
      headers: this.getSessionHeaders(),
    });
    if (!response.ok) {
      throw new Error('Failed to revoke sessions');
    }
    return response.json() as Promise<{ revoked: number }>;
  }

  async syncMyProfile() {
    const { nickname, avatar, username } = useAppStore.getState();
    if (!this.getSessionToken()) {
      return;
    }

    try {
      const response = await fetchWithTimeout(appConfig.profileUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getSessionHeaders(),
        },
        body: JSON.stringify({
          nickname: nickname ?? '',
          avatar: avatar ?? '',
          username: username,
        }),
      });
      if (response.status === 409) {
        throw new Error('Username is already taken');
      }
      if (!response.ok) {
        throw new Error('Failed to save profile');
      }
    } catch (error) {
      console.warn('Failed to sync profile', error);
      throw error;
    }
  }

  async refreshOwnProfile(pubKey?: string, force = false) {
    const targetPubKey = pubKey ?? useAppStore.getState().myPublicKey;
    if (!targetPubKey) {
      return;
    }

    try {
      const response = await fetchWithTimeout(`${appConfig.profileUrl}?pub=${encodeURIComponent(targetPubKey)}`, {
        headers: this.getSessionHeaders(),
      });
      if (!response.ok) {
        return;
      }

      const profile = await response.json() as {
        nickname?: string;
        avatar?: string;
        username?: string;
      };
      const current = useAppStore.getState();
      const nextNickname = profile.nickname?.trim() || current.nickname?.trim();
      const nextAvatar = profile.avatar?.trim() || current.avatar || null;
      const nextUsername = profile.username?.trim() || current.username?.trim() || null;

      if (!force && !nextNickname && !nextAvatar && !nextUsername) {
        return;
      }
      if (!nextNickname && !nextAvatar && !nextUsername) {
        return;
      }

      current.setProfile(
        nextNickname || current.nickname || `User ${targetPubKey.substring(0, 6)}`,
        nextAvatar,
        nextUsername
      );
    } catch (error) {
      console.warn('Failed to refresh own profile', error);
    }
  }

  async refreshContactProfile(pubKey: string, force = false) {
    const now = Date.now();
    const lastRefreshedAt = this.profileRefreshAt.get(pubKey) ?? 0;
    if (!force && now - lastRefreshedAt < 5 * 60_000) {
      return;
    }

    const existingRequest = this.profileRefreshInFlight.get(pubKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = (async () => {
      try {
        const response = await fetchWithTimeout(`${appConfig.profileUrl}?pub=${encodeURIComponent(pubKey)}`, {
          headers: this.getSessionHeaders(),
        });
        if (!response.ok) {
          return;
        }

        const profile = await response.json() as {
          nickname?: string;
          avatar?: string;
          username?: string;
        };
        const fallbackName = pubKey.substring(0, 8) + '...';
        const existingContact = await db.contacts.get(pubKey);
        await db.contacts.put({
          pubKey,
          name: profile.nickname?.trim() || existingContact?.name || fallbackName,
          avatar: profile.avatar || existingContact?.avatar || undefined,
          username: profile.username || existingContact?.username || undefined,
          lastMessageAt: existingContact?.lastMessageAt ?? Date.now(),
          pinned: existingContact?.pinned,
          draft: existingContact?.draft,
          archived: existingContact?.archived,
          mutedUntil: existingContact?.mutedUntil,
        });
        this.profileRefreshAt.set(pubKey, Date.now());
      } catch (error) {
        console.warn('Failed to refresh contact profile', error);
      } finally {
        this.profileRefreshInFlight.delete(pubKey);
      }
    })();

    this.profileRefreshInFlight.set(pubKey, request);
    return request;
  }

  async resolveUsername(username: string): Promise<ResolvedUserProfile | null> {
    const normalized = username.trim().replace(/^@+/, '');
    if (!normalized) {
      return null;
    }

    const candidates = ['/profile/resolve', '/resolve'];
    for (const path of candidates) {
      try {
        const url = new URL(appConfig.backendOrigin);
        url.pathname = path;
        url.searchParams.set('username', normalized);

        const response = await fetchWithTimeout(url.toString(), {
          headers: this.getSessionHeaders(),
        });
        if (!response.ok) {
          continue;
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.toLowerCase().includes('application/json')) {
          continue;
        }

        const profile = await response.json() as ResolvedUserProfile;
        if (profile?.pubKey) {
          return profile;
        }
      } catch (error) {
        console.warn(`Failed to resolve username via ${path}`, error);
      }
    }

    return null;
  }

  async refreshKnownProfiles(force = false) {
    const now = Date.now();
    if (!force && now - this.lastKnownProfilesRefreshAt < 60_000) {
      return;
    }
    this.lastKnownProfilesRefreshAt = now;

    try {
      const contacts = await db.contacts.orderBy('lastMessageAt').reverse().limit(40).toArray();
      await Promise.allSettled(
        contacts.map((contact) => this.refreshContactProfile(contact.pubKey, force))
      );
    } catch (error) {
      console.warn('Failed to refresh known contact profiles', error);
    }
  }
}
