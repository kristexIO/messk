export function fallbackParticipantName(pubKey: string) {
  return `${pubKey.substring(0, 12)}...`;
}

const LEGACY_REACTION_MAP: Record<string, string> = {
  'рџ‘Ќ': '\u{1F44D}',
  'вќ¤пёЏ': '\u2764\uFE0F',
  'рџ”Ґ': '\u{1F525}',
};

export function normalizeReactionValue(value: string | null | undefined): string | null {
  if (!value) return null;
  return LEGACY_REACTION_MAP[value] ?? value;
}
