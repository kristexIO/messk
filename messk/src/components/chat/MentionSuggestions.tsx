export type MentionSuggestion = {
  pubKey: string;
  displayName: string;
  handle: string;
};

type MentionSuggestionsProps = {
  suggestions: MentionSuggestion[];
  selectedIndex: number;
  onSelect: (candidate: MentionSuggestion) => void;
};

export function MentionSuggestions({
  suggestions,
  selectedIndex,
  onSelect,
}: MentionSuggestionsProps) {
  if (!suggestions.length) {
    return null;
  }

  return (
    <div className="absolute bottom-16 left-16 z-30 w-64 rounded-2xl border border-white/15 bg-slate-950/95 p-2 shadow-2xl backdrop-blur">
      {suggestions.map((candidate, index) => (
        <button
          key={candidate.pubKey}
          type="button"
          onClick={() => onSelect(candidate)}
          className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-all ${
            selectedIndex === index
              ? 'bg-accent/20 text-white'
              : 'text-text-muted hover:bg-white/10 hover:text-white'
          }`}
        >
          <span className="truncate">{candidate.displayName}</span>
          <span className="ml-2 font-mono text-[11px] text-accent">@{candidate.handle}</span>
        </button>
      ))}
    </div>
  );
}
