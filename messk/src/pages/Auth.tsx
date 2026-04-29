import React, { useState } from 'react';
import { generateSeedPhrase, deriveKeysFromPhraseAsync, isValidSeedPhrase } from '../lib/seed';
import { getSavedProfileForKey, useAppStore } from '../store';
import type { Language } from '../store';
import { KeyRound, ShieldCheck, AtSign, Loader2, Copy, Check, ChevronRight, Camera, ArrowLeft, UserRound } from 'lucide-react';
import { prepareDatabaseForIdentity } from '../lib/db';
import { prepareAvatarDataUrl } from '../lib/images';
import { appConfig } from '../lib/config';
import { fetchWithTimeout } from '../lib/http';
import { useI18n } from '../lib/i18n';

type RemoteProfile = {
  nickname?: string;
  avatar?: string;
  username?: string;
};

async function loadRemoteProfile(pubKey: string): Promise<RemoteProfile | null> {
  try {
    const response = await fetchWithTimeout(`${appConfig.profileUrl}?pub=${encodeURIComponent(pubKey)}`);
    if (!response.ok) {
      return null;
    }
    return await response.json() as RemoteProfile;
  } catch {
    return null;
  }
}

export const Auth: React.FC = () => {
  const [mode, setMode] = useState<'select' | 'generate' | 'verify' | 'import' | 'profile'>('select');
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [hasCopied, setHasCopied] = useState(false);
  const [agreedToSave, setAgreedToSave] = useState(false);
  const [pendingPhrase, setPendingPhrase] = useState('');
  const [profileSource, setProfileSource] = useState<'generate' | 'import'>('generate');
  const [profileNickname, setProfileNickname] = useState('');
  const [profileAvatar, setProfileAvatar] = useState('');
  const [verificationIndexes, setVerificationIndexes] = useState<number[]>([]);
  const [verificationInputs, setVerificationInputs] = useState<Record<number, string>>({});
  const { t } = useI18n();

  const setKeys = useAppStore(state => state.setKeys);
  const setProfile = useAppStore(state => state.setProfile);
  const language = useAppStore(state => state.language);
  const setLanguage = useAppStore(state => state.setLanguage);
  const languages: { id: Language; code: string; label: string }[] = [
    { id: 'en', code: 'EN', label: t('english') },
    { id: 'ru', code: 'RU', label: t('russian') },
    { id: 'fr', code: 'FR', label: t('french') },
    { id: 'de', code: 'DE', label: t('german') },
  ];
  const trustLabels: Record<Language, string[]> = {
    en: ['E2EE', 'Local keys', 'No tracking'],
    ru: ['E2EE', 'Ключи локально', 'Без трекинга'],
    fr: ['E2EE', 'Cles locales', 'Sans suivi'],
    de: ['E2EE', 'Lokale Schlussel', 'Kein Tracking'],
  };

  const handleGenerate = async () => {
    setIsLoading(true);
    await new Promise(r => setTimeout(r, 800));
    setPhrase(generateSeedPhrase());
    setMode('generate');
    setIsLoading(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(phrase);
    setHasCopied(true);
    setTimeout(() => setHasCopied(false), 2000);
  };

  const beginSeedVerification = () => {
    const words = phrase.trim().split(/\s+/);
    if (words.length !== 12) {
      setError(t('invalidSeed'));
      return;
    }
    const indexes = [...Array(words.length).keys()]
      .sort(() => Math.random() - 0.5)
      .slice(0, 3)
      .sort((a, b) => a - b);
    setVerificationIndexes(indexes);
    setVerificationInputs({});
    setError('');
    setMode('verify');
  };

  const completeSeedVerification = () => {
    const words = phrase.trim().toLowerCase().split(/\s+/);
    const isCorrect = verificationIndexes.every((index) =>
      (verificationInputs[index] ?? '').trim().toLowerCase() === words[index]
    );
    if (!isCorrect) {
      setError(t('verifyError'));
      return;
    }
    continueToProfile(phrase, 'generate');
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setProfileAvatar(await prepareAvatarDataUrl(file));
    } catch (avatarError) {
      setError(avatarError instanceof Error ? avatarError.message : 'Failed to prepare avatar.');
    } finally {
      e.target.value = '';
    }
  };

  const continueToProfile = (seedPhrase: string, source: 'generate' | 'import') => {
    const normalizedPhrase = seedPhrase.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!isValidSeedPhrase(normalizedPhrase)) {
      setError(t('invalidSeed'));
      return;
    }
    setPendingPhrase(normalizedPhrase);
    setProfileSource(source);
    setError('');
    setMode('profile');
  };

  const handleRestoreStart = async () => {
    const normalizedPhrase = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!isValidSeedPhrase(normalizedPhrase)) {
      setError(t('invalidSeed'));
      return;
    }

    setIsLoading(true);
    try {
      const keys = await deriveKeysFromPhraseAsync(normalizedPhrase);
      const remoteProfile = await loadRemoteProfile(keys.publicKey);
      const localProfile = getSavedProfileForKey(keys.publicKey);
      const hasExistingProfile = Boolean(
        remoteProfile?.nickname?.trim() ||
        remoteProfile?.avatar?.trim() ||
        remoteProfile?.username?.trim() ||
        localProfile?.nickname?.trim() ||
        localProfile?.avatar?.trim() ||
        localProfile?.username?.trim()
      );

      if (hasExistingProfile) {
        setPendingPhrase(normalizedPhrase);
        setProfileSource('import');
        setProfileNickname(remoteProfile?.nickname?.trim() || localProfile?.nickname?.trim() || '');
        setProfileAvatar(remoteProfile?.avatar?.trim() || localProfile?.avatar?.trim() || '');
        await performLogin(normalizedPhrase, remoteProfile);
        return;
      }

      continueToProfile(normalizedPhrase, 'import');
    } catch {
      setError(t('cryptoFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const performLogin = async (seedPhrase: string, prefetchedRemoteProfile?: RemoteProfile | null) => {
    setIsLoading(true);
    try {
      if (!isValidSeedPhrase(seedPhrase)) {
        setError(t('invalidSeed'));
        return;
      }
      const keys = await deriveKeysFromPhraseAsync(seedPhrase);
      await prepareDatabaseForIdentity(keys.publicKey);
      const remoteProfile =
        prefetchedRemoteProfile !== undefined
          ? prefetchedRemoteProfile
          : profileSource === 'import'
            ? await loadRemoteProfile(keys.publicKey)
            : null;
      setKeys(keys.publicKey, keys.secretKey);
      const currentProfile = useAppStore.getState();
      const nickname =
        profileNickname.trim() ||
        remoteProfile?.nickname?.trim() ||
        currentProfile.nickname?.trim() ||
        `User ${keys.publicKey.substring(0, 6)}`;
      const avatar =
        profileAvatar ||
        remoteProfile?.avatar?.trim() ||
        currentProfile.avatar ||
        null;
      const username =
        remoteProfile?.username?.trim() ||
        currentProfile.username?.trim() ||
        null;
      setProfile(nickname, avatar, username);
    } catch {
      setError(t('cryptoFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="auth-screen min-h-[100dvh] w-full overflow-y-auto bg-gradient-to-br from-[#020617] via-[#0f172a] to-[#1e1b4b] px-4 py-6 sm:flex sm:items-center sm:justify-center sm:p-6">
      {/* Background Decorative Blobs */}
      <div className="fixed top-[-10%] left-[-10%] w-[40%] h-[40%] bg-accent/10 rounded-full blur-[120px] pointer-events-none animate-pulse-slow" />
      <div className="fixed bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/10 rounded-full blur-[120px] pointer-events-none animate-pulse-slow" />
      <div className="auth-language-switcher" aria-label={t('language')}>
        {languages.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setLanguage(item.id)}
            className={`auth-language-pill ${language === item.id ? 'is-active' : ''}`}
            title={item.label}
          >
            {item.code}
          </button>
        ))}
      </div>

      {mode === 'select' && (
        <div className="auth-card flex w-full max-w-md flex-col items-center rounded-[28px] premium-glass p-6 animate-in fade-in zoom-in duration-500 sm:rounded-[32px] sm:p-10">
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-3xl border border-accent/30 bg-accent/20 shadow-[0_0_40px_var(--accent-glow)] sm:mb-8 sm:h-20 sm:w-20">
            <ShieldCheck className="h-8 w-8 text-accent sm:h-10 sm:w-10" />
          </div>
          <h1 className="mb-3 text-center text-3xl font-bold tracking-tight sm:text-4xl">{t('authTitle')}</h1>
          <p className="mb-8 max-w-[280px] text-center text-sm leading-relaxed text-text-muted sm:mb-10">
            {t('authSubtitle')}
          </p>

          <div className="trust-strip mb-8 grid w-full grid-cols-3 gap-2 text-center">
            {trustLabels[language].map((label) => (
              <div key={label} className="trust-chip">{label}</div>
            ))}
          </div>

          <div className="w-full space-y-4">
            <button
              onClick={handleGenerate}
              disabled={isLoading}
              className="btn-premium w-full h-14 group"
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <KeyRound className="w-5 h-5 group-hover:rotate-12 transition-transform" />}
              {t('createIdentity')}
            </button>
            
            <button
              onClick={() => setMode('import')}
              className="w-full h-14 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all flex items-center justify-center gap-3 font-medium text-text-main"
            >
              <AtSign className="w-5 h-5 text-text-muted" />
              {t('haveSeed')}
            </button>
          </div>
        </div>
      )}

      {mode === 'generate' && (
        <div className="w-full max-w-xl rounded-[28px] premium-glass p-5 animate-in slide-in-from-right-10 duration-500 sm:rounded-[32px] sm:p-10">
          <h2 className="mb-3 flex items-center gap-3 text-xl font-bold sm:text-2xl">
             <ShieldCheck className="text-accent" />
             {t('backupTitle')}
          </h2>
          <p className="text-text-muted mb-8 text-sm leading-relaxed">
            {t('backupDescription')}
            <span className="block mt-2 text-accent/80 font-medium">{t('backupWarning')}</span>
          </p>

          <div className="group relative mb-8 rounded-2xl border border-white/5 bg-black/40 p-4 sm:p-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
              {phrase.split(' ').map((word, index) => (
                <div key={index} className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-2.5 border border-white/5 hover:border-accent/20 transition-all">
                  <span className="text-accent/40 text-[10px] font-bold w-4">{index + 1}</span>
                  <span className="font-mono text-sm tracking-wide">{word}</span>
                </div>
              ))}
            </div>
            
            <button 
              onClick={handleCopy}
              className="absolute -top-3 -right-3 w-10 h-10 bg-accent text-white rounded-xl shadow-lg flex items-center justify-center hover:scale-110 active:scale-95 transition-all"
            >
              {hasCopied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
            </button>
          </div>

          <label className="flex items-start gap-4 cursor-pointer group mb-10">
            <div className="relative flex items-center justify-center mt-1">
              <input 
                type="checkbox" 
                className="peer sr-only"
                checked={agreedToSave}
                onChange={(e) => setAgreedToSave(e.target.checked)}
              />
              <div className="w-6 h-6 bg-white/5 border-2 border-white/10 rounded-lg peer-checked:bg-accent peer-checked:border-accent transition-all"></div>
              <Check className="absolute w-4 h-4 text-white opacity-0 peer-checked:opacity-100 transition-opacity pointer-events-none" />
            </div>
            <span className="text-xs text-text-muted leading-normal group-hover:text-text-main transition-colors">
              {t('phraseSaved')}
            </span>
          </label>

          <div className="flex gap-4">
            <button onClick={() => setMode('select')} className="px-6 py-3 rounded-2xl bg-white/5 hover:bg-white/10 transition-all font-medium">
              {t('back')}
            </button>
            <button 
              onClick={beginSeedVerification}
              disabled={!agreedToSave || isLoading}
              className="btn-premium flex-1"
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ChevronRight className="w-5 h-5" />}
              {t('continue')}
            </button>
          </div>
        </div>
      )}

      {mode === 'verify' && (
        <div className="w-full max-w-lg rounded-[28px] premium-glass p-5 animate-in fade-in zoom-in duration-500 sm:rounded-[32px] sm:p-10">
          <h2 className="mb-3 flex items-center gap-3 text-xl font-bold sm:text-2xl">
            <ShieldCheck className="text-accent" />
            {t('verifyTitle')}
          </h2>
          <p className="text-text-muted mb-8 text-sm leading-relaxed">{t('verifyDescription')}</p>

          <div className="space-y-4">
            {verificationIndexes.map((index) => (
              <div key={index} className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">
                  {t('verifyWord', { number: index + 1 })}
                </label>
                <input
                  type="text"
                  value={verificationInputs[index] ?? ''}
                  onChange={(event) => {
                    setError('');
                    setVerificationInputs((current) => ({
                      ...current,
                      [index]: event.target.value.toLowerCase().trim(),
                    }));
                  }}
                  className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 font-mono outline-none transition-all focus:border-accent/40"
                />
              </div>
            ))}
          </div>

          {error ? (
            <div className="text-red-400 text-xs mt-5 px-2 flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-red-400 rounded-full animate-pulse" />
              {error}
            </div>
          ) : null}

          <div className="flex gap-4 mt-8">
            <button onClick={() => setMode('generate')} className="px-6 py-3 rounded-2xl bg-white/5 hover:bg-white/10 transition-all font-medium">
              {t('back')}
            </button>
            <button
              onClick={completeSeedVerification}
              disabled={verificationIndexes.some((index) => !(verificationInputs[index] ?? '').trim())}
              className="btn-premium flex-1"
            >
              <ChevronRight className="w-5 h-5" />
              {t('finishSetup')}
            </button>
          </div>
        </div>
      )}

      {mode === 'import' && (
        <div className="w-full max-w-lg rounded-[28px] premium-glass p-5 animate-in slide-in-from-left-10 duration-500 sm:rounded-[32px] sm:p-10">
          <h2 className="mb-3 flex items-center gap-3 text-xl font-bold sm:text-2xl">
             <KeyRound className="text-accent" />
             {t('restoreTitle')}
          </h2>
          <p className="text-text-muted mb-8 text-sm">
            {t('restoreDescription')}
          </p>

          <textarea
            className="mb-2 min-h-[140px] w-full resize-none rounded-2xl border border-white/10 bg-black/40 p-4 font-mono text-base outline-none transition-all shadow-inner focus:border-accent/40 focus:bg-black/60 sm:p-6 sm:text-lg"
            placeholder="word1 word2 word3..."
            value={phrase}
            onChange={(e) => {
              setPhrase(e.target.value.toLowerCase());
              setError('');
            }}
          />
          
          {error ? (
            <div className="text-red-400 text-xs mt-2 px-2 flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-red-400 rounded-full animate-pulse" />
              {error}
            </div>
          ) : <div className="h-4 mt-2"></div>}

          <div className="flex gap-4 mt-8">
            <button onClick={() => setMode('select')} className="px-6 py-3 rounded-2xl bg-white/5 hover:bg-white/10 transition-all font-medium">
              {t('cancel')}
            </button>
            <button 
              onClick={() => void handleRestoreStart()}
              disabled={phrase.trim().split(/\s+/).length !== 12 || isLoading}
              className="btn-premium flex-1"
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
              {t('restoreIdentity')}
            </button>
          </div>
        </div>
      )}

      {mode === 'profile' && (
        <div className="w-full max-w-xl rounded-[28px] premium-glass p-5 animate-in fade-in zoom-in duration-500 sm:rounded-[32px] sm:p-10">
          <div className="flex items-center gap-3 mb-3">
            <UserRound className="text-accent" />
            <h2 className="text-2xl font-bold">{t('finishProfile')}</h2>
          </div>
          <p className="text-text-muted mb-8 text-sm leading-relaxed">
            {t('finishProfileDescription')}
          </p>

          <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
            <div className="relative group">
              <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-3xl border border-white/10 bg-white/5 text-3xl font-bold text-accent sm:h-28 sm:w-28">
                {profileAvatar ? (
                  <img src={profileAvatar} alt="Profile avatar" className="w-full h-full object-cover" />
                ) : (
                  profileNickname.trim().charAt(0).toUpperCase() || '?'
                )}
              </div>
              <label className="absolute inset-0 rounded-3xl bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer">
                <Camera className="w-6 h-6 text-white" />
                <input type="file" className="hidden" accept="image/*" onChange={handleAvatarChange} />
              </label>
            </div>

            <div className="flex-1 space-y-2">
              <label className="text-xs text-text-muted">{t('displayName')}</label>
              <input
                type="text"
                value={profileNickname}
                onChange={(e) => setProfileNickname(e.target.value)}
                placeholder={t('chooseNickname')}
                className="w-full px-4 py-3 bg-black/30 rounded-2xl border border-white/10 focus:border-accent/40 outline-none transition-all"
              />
              <p className="text-xs text-text-muted">
                {t('profileHint')}
              </p>
            </div>
          </div>

          {error ? (
            <div className="text-red-400 text-xs mt-6 px-2 flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-red-400 rounded-full animate-pulse" />
              {error}
            </div>
          ) : null}

          <div className="flex gap-4 mt-10">
            <button
              onClick={() => setMode(profileSource)}
              className="px-6 py-3 rounded-2xl bg-white/5 hover:bg-white/10 transition-all font-medium flex items-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              {t('back')}
            </button>
            <button
              onClick={() => performLogin(pendingPhrase)}
              disabled={!pendingPhrase || isLoading}
              className="btn-premium flex-1"
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ChevronRight className="w-5 h-5" />}
              {t('enterMessenger')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
