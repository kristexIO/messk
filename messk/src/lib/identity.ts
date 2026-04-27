export function normalizeMentionHandle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 24);
}

export function deriveMentionHandle(displayName: string, fallbackPubKey: string, taken: Set<string>): string {
  const base = normalizeMentionHandle(displayName) || `user_${fallbackPubKey.slice(0, 6).toLowerCase()}`;
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  for (let i = 2; i <= 99; i++) {
    const next = `${base}_${i}`;
    if (!taken.has(next)) {
      taken.add(next);
      return next;
    }
  }

  const fallback = `user_${fallbackPubKey.slice(0, 10).toLowerCase()}`;
  taken.add(fallback);
  return fallback;
}

export async function getPublicKeyFingerprint(pubKey: string): Promise<string> {
  const bytes = Uint8Array.from(atob(pubKey), (char) => char.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 4) {
    groups.push(hex.slice(i, i + 4));
  }
  return groups.join(' ');
}
