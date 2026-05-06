import React, { useEffect, useEffectEvent, useState, useRef } from 'react';
import { useAppStore } from '../store';
import { WebRTCManager } from '../lib/webrtc';
import { appConfig } from '../lib/config';
import { Phone, PhoneOff, Video, Mic, MicOff, VideoOff, ShieldCheck, RotateCcw, Activity } from 'lucide-react';
import { socketManager } from '../lib/socket';
import { db } from '../lib/db';
import { useLiveQuery } from 'dexie-react-hooks';

type WebRTCSignalDetail = {
  type: 'call_offer' | 'call_answer' | 'call_reject' | 'call_end' | 'ice_candidate';
  sender_pub_key: string;
  data: string;
};

type StartCallDetail = {
  video: boolean;
  peerPubKey?: string;
};

type StatusTone = 'neutral' | 'success' | 'warning' | 'danger';

const CALL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const STATUS_RESET_MS = 2_500;

async function logCallEvent(input: {
  peerPubKey: string | null;
  direction: 'incoming' | 'outgoing';
  media: 'audio' | 'video';
  outcome: 'started' | 'connected' | 'missed' | 'declined' | 'ended' | 'failed';
}) {
  if (!input.peerPubKey) {
    return;
  }

  await db.callHistory.put({
    id: crypto.randomUUID(),
    peerPubKey: input.peerPubKey,
    direction: input.direction,
    media: input.media,
    outcome: input.outcome,
    createdAt: Date.now(),
    endedAt: ['connected', 'missed', 'declined', 'ended', 'failed'].includes(input.outcome) ? Date.now() : undefined,
  });
}

function errorToStatus(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    const normalizedMessage = error.message.trim();
    const loweredMessage = normalizedMessage.toLowerCase();
    if (
      loweredMessage.includes('secure') ||
      loweredMessage.includes('socket disconnected') ||
      loweredMessage.includes('authentication timeout')
    ) {
      return 'Secure signaling is not ready yet';
    }
    return normalizedMessage;
  }
  if (!(error instanceof DOMException)) {
    return null;
  }

  switch (error.name) {
    case 'NotAllowedError':
      return 'Microphone or camera access denied';
    case 'SecurityError':
      return 'Browser blocked microphone or camera access';
    case 'NotFoundError':
      return 'Camera or microphone not found';
    case 'NotReadableError':
      return 'Camera or microphone is busy';
    case 'OverconstrainedError':
      return 'Requested media device is unavailable';
    case 'AbortError':
      return 'Media startup was interrupted. Retry the call.';
    default:
      return null;
  }
}

export const CallOverlay: React.FC = () => {
  const { activePeerKey, myPublicKey } = useAppStore();
  const [callState, setCallState] = useState<'idle' | 'incoming' | 'outgoing' | 'active'>('idle');
  const [isVideo, setIsVideo] = useState(false);
  const [callerPubKey, setCallerPubKey] = useState<string | null>(null);
  const [incomingSDP, setIncomingSDP] = useState<RTCSessionDescriptionInit | null>(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<StatusTone>('neutral');
  const [peerConnectionState, setPeerConnectionState] = useState<RTCPeerConnectionState>('new');
  const [iceConnectionState, setIceConnectionState] = useState<RTCIceConnectionState>('new');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [lastRetryTarget, setLastRetryTarget] = useState<{ peerPubKey: string; video: boolean } | null>(null);
  const [callDirection, setCallDirection] = useState<'incoming' | 'outgoing'>('outgoing');
  const [callMedia, setCallMedia] = useState<'audio' | 'video'>('audio');

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const rtcManagerRef = useRef<WebRTCManager | null>(null);
  const callTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callGenerationRef = useRef(0);
  const callPeerRef = useRef<string | null>(null);
  const pendingRemoteCandidatesRef = useRef<Array<{ senderPubKey: string; candidate: RTCIceCandidateInit }>>([]);
  const callDirectionRef = useRef<'incoming' | 'outgoing'>('outgoing');
  const callMediaRef = useRef<'audio' | 'video'>('audio');
  const lastLoggedOutcomeRef = useRef<'connected' | 'missed' | 'declined' | 'ended' | 'failed' | null>(null);
  const displayPeerKey = callerPubKey ?? activePeerKey;
  const displayContact = useLiveQuery(async () => {
    if (!displayPeerKey) return undefined;
    return db.contacts.get(displayPeerKey);
  }, [displayPeerKey]);
  const displayName = displayContact?.name || (displayPeerKey ? `${displayPeerKey.substring(0, 16)}...` : 'Unknown contact');
  const displayAvatar = displayContact?.avatar?.trim() || null;

  const attachStream = async (element: HTMLVideoElement | null, stream: MediaStream) => {
    if (!element) return;
    element.srcObject = stream;
    try {
      await element.play();
    } catch {
      // Browser autoplay policies may delay playback until user interaction.
    }
  };

  const clearCallTimeout = () => {
    if (callTimeoutRef.current) {
      clearTimeout(callTimeoutRef.current);
      callTimeoutRef.current = null;
    }
  };

  const clearConnectTimeout = () => {
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  };

  const clearStatusReset = () => {
    if (statusResetRef.current) {
      clearTimeout(statusResetRef.current);
      statusResetRef.current = null;
    }
  };

  const scheduleStatusReset = () => {
    clearStatusReset();
    statusResetRef.current = setTimeout(() => {
      setStatusText(null);
    }, STATUS_RESET_MS);
  };

  const presentStatus = (text: string, tone: StatusTone = 'neutral', autoReset = true) => {
    setStatusText(text);
    setStatusTone(tone);
    if (autoReset) {
      scheduleStatusReset();
    } else {
      clearStatusReset();
    }
  };

  const markCallContext = (peerPubKey: string | null, direction: 'incoming' | 'outgoing', video: boolean) => {
    callPeerRef.current = peerPubKey;
    callDirectionRef.current = direction;
    callMediaRef.current = video ? 'video' : 'audio';
    lastLoggedOutcomeRef.current = null;
    setCallDirection(direction);
    setCallMedia(video ? 'video' : 'audio');
    setIsVideo(video);
    if (peerPubKey) {
      setCallerPubKey(peerPubKey);
    }
  };

  const logTerminalOutcome = (outcome: 'connected' | 'missed' | 'declined' | 'ended' | 'failed') => {
    if (lastLoggedOutcomeRef.current === outcome) {
      return;
    }
    lastLoggedOutcomeRef.current = outcome;
    void logCallEvent({
      peerPubKey: callPeerRef.current,
      direction: callDirectionRef.current,
      media: callMediaRef.current,
      outcome,
    });
  };

  const resetCallState = (
    nextStatus?: string,
    options?: { tone?: StatusTone; allowRetry?: boolean; autoResetStatus?: boolean }
  ) => {
    callGenerationRef.current += 1;
    const retryTarget = options?.allowRetry && callDirectionRef.current === 'outgoing' && callPeerRef.current
      ? { peerPubKey: callPeerRef.current, video: callMediaRef.current === 'video' }
      : null;
    clearCallTimeout();
    clearConnectTimeout();
    rtcManagerRef.current?.endCall();
    rtcManagerRef.current = null;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    setCallState('idle');
    setCallerPubKey(null);
    setIncomingSDP(null);
    setIsMicOn(true);
    setIsVideoOn(true);
    setPeerConnectionState('new');
    setIceConnectionState('new');
    setShowDiagnostics(false);
    setCallDirection('outgoing');
    setCallMedia('audio');
    callPeerRef.current = null;
    pendingRemoteCandidatesRef.current = [];
    if (nextStatus) {
      presentStatus(nextStatus, options?.tone ?? 'neutral', options?.autoResetStatus ?? true);
    }
    setLastRetryTarget(retryTarget);
  };

  const createRtcManager = (generation: number) =>
    new WebRTCManager(
      (stream) => {
        if (callGenerationRef.current !== generation) {
          return;
        }
        void attachStream(remoteVideoRef.current, stream);
      },
      (connectionState) => {
        if (callGenerationRef.current !== generation) {
          return;
        }
        setPeerConnectionState(connectionState);
        if (connectionState === 'connected') {
          clearConnectTimeout();
          setCallState('active');
          presentStatus('Call connected', 'success');
          logTerminalOutcome('connected');
        } else if (connectionState === 'failed') {
          logTerminalOutcome('failed');
          resetCallState('Call failed', { tone: 'danger', allowRetry: true, autoResetStatus: false });
        } else if (connectionState === 'disconnected') {
          logTerminalOutcome('ended');
          resetCallState('Call disconnected', { tone: 'warning', allowRetry: true, autoResetStatus: false });
        } else if (connectionState === 'closed') {
          resetCallState();
        }
      },
      (iceState) => {
        if (callGenerationRef.current !== generation) {
          return;
        }
        setIceConnectionState(iceState);
        if (iceState === 'checking') {
          presentStatus('Negotiating connection...', 'neutral', false);
        } else if (iceState === 'connected' || iceState === 'completed') {
          presentStatus('Secure media path established', 'success');
        } else if (iceState === 'disconnected') {
          presentStatus('Connection interrupted...', 'warning', false);
        } else if (iceState === 'failed') {
          logTerminalOutcome('failed');
          resetCallState('Peer connection failed', { tone: 'danger', allowRetry: true, autoResetStatus: false });
        }
      }
    );

  const handleStartCallAction = async (video: boolean, targetPubKey = activePeerKey) => {
    if (!targetPubKey) {
      presentStatus('Open a direct chat before starting a call', 'warning', false);
      return;
    }
    if (myPublicKey && targetPubKey === myPublicKey) {
      presentStatus('Open another account or device to test calls. You cannot call yourself here.', 'warning', false);
      return;
    }
    if (!socketManager.isRealtimeReady()) {
      setLastRetryTarget({ peerPubKey: targetPubKey, video });
      presentStatus('Reconnecting secure signaling...', 'warning', false);
    }
    try {
      const signalingReady = await socketManager.recoverTransport(6000);
      if (!signalingReady) {
        throw new Error('Secure signaling is unavailable. Check your connection and try again.');
      }

      const generation = callGenerationRef.current + 1;
      callGenerationRef.current = generation;
      markCallContext(targetPubKey, 'outgoing', video);
      setLastRetryTarget({ peerPubKey: targetPubKey, video });
      presentStatus(video ? 'Starting video call...' : 'Starting audio call...', 'neutral', false);
      setCallState('outgoing');
      void logCallEvent({
        peerPubKey: targetPubKey,
        direction: 'outgoing',
        media: video ? 'video' : 'audio',
        outcome: 'started',
      });
      
      rtcManagerRef.current = createRtcManager(generation);

      const stream = await rtcManagerRef.current.startCall(targetPubKey, video);
      if (callGenerationRef.current !== generation) {
        rtcManagerRef.current?.endCall();
        return;
      }
      await attachStream(localVideoRef.current, stream);
      presentStatus('Ringing...', 'neutral', false);
      clearCallTimeout();
      callTimeoutRef.current = setTimeout(() => {
        if (callGenerationRef.current !== generation) {
          return;
        }
        if (targetPubKey) {
          socketManager.sendSignal(targetPubKey, 'call_end', { reason: 'timeout' });
        }
        logTerminalOutcome('missed');
        resetCallState('No answer', { tone: 'warning', allowRetry: true, autoResetStatus: false });
      }, CALL_TIMEOUT_MS);
      clearConnectTimeout();
      connectTimeoutRef.current = setTimeout(() => {
        if (callGenerationRef.current !== generation) {
          return;
        }
        if (targetPubKey) {
          socketManager.sendSignal(targetPubKey, 'call_end', { reason: 'connect_timeout' });
        }
        logTerminalOutcome('failed');
        resetCallState('Connection timeout', { tone: 'danger', allowRetry: true, autoResetStatus: false });
      }, CONNECT_TIMEOUT_MS);
    } catch (error) {
      console.error('Failed to start call', error);
      logTerminalOutcome('failed');
      resetCallState(errorToStatus(error) ?? 'Call setup failed', { tone: 'danger', allowRetry: true, autoResetStatus: false });
    }
  };

  const handleAccept = async () => {
    if (!callerPubKey || !incomingSDP) return;
    if (!socketManager.isRealtimeReady()) {
      presentStatus('Reconnecting secure signaling...', 'warning', false);
    }
    try {
      const signalingReady = await socketManager.recoverTransport(6000);
      if (!signalingReady) {
        throw new Error('Secure signaling is unavailable. Check your connection and try again.');
      }

      const generation = callGenerationRef.current + 1;
      callGenerationRef.current = generation;
      clearCallTimeout();
      markCallContext(callerPubKey, 'incoming', isVideo);
      setCallState('active');
      presentStatus('Connecting...', 'neutral', false);

      rtcManagerRef.current = createRtcManager(generation);

      const stream = await rtcManagerRef.current.handleOffer(callerPubKey, incomingSDP, isVideo);
      if (callGenerationRef.current !== generation) {
        rtcManagerRef.current?.endCall();
        return;
      }
      const bufferedCandidates = pendingRemoteCandidatesRef.current.filter(
        (entry) => entry.senderPubKey === callerPubKey
      );
      pendingRemoteCandidatesRef.current = pendingRemoteCandidatesRef.current.filter(
        (entry) => entry.senderPubKey !== callerPubKey
      );
      for (const entry of bufferedCandidates) {
        await rtcManagerRef.current.handleCandidate(entry.candidate);
      }
      await attachStream(localVideoRef.current, stream);
      clearConnectTimeout();
      connectTimeoutRef.current = setTimeout(() => {
        if (callGenerationRef.current !== generation) {
          return;
        }
        socketManager.sendSignal(callerPubKey, 'call_end', { reason: 'connect_timeout' });
        logTerminalOutcome('failed');
        resetCallState('Connection timeout', { tone: 'danger', autoResetStatus: false });
      }, CONNECT_TIMEOUT_MS);
    } catch (error) {
      console.error('Failed to answer call', error);
      socketManager.sendSignal(callerPubKey, 'call_reject', { reason: 'failed' });
      logTerminalOutcome('failed');
      resetCallState(errorToStatus(error) ?? 'Failed to answer', { tone: 'danger', autoResetStatus: false });
    }
  };

  const handleEndCall = () => {
    const targetPubKey = callerPubKey ?? activePeerKey;
    if (targetPubKey && callState !== 'idle') {
      socketManager.sendSignal(targetPubKey, 'call_end', {});
      logTerminalOutcome('ended');
    }
    resetCallState();
  };

  const handleRejectCall = () => {
    if (callerPubKey) {
      socketManager.sendSignal(callerPubKey, 'call_reject', {});
      logTerminalOutcome('declined');
    }
    resetCallState();
  };

  const onSignal = useEffectEvent(async (event: Event) => {
    const e = event as CustomEvent<WebRTCSignalDetail>;
    const { type, sender_pub_key, data } = e.detail;
    const parsedData = JSON.parse(data) as RTCIceCandidateInit & {
      isVideo?: boolean;
      sdp?: RTCSessionDescriptionInit;
      reason?: string;
    };

    if (type === 'call_offer') {
      if (callState !== 'idle') {
        socketManager.sendSignal(sender_pub_key, 'call_reject', { reason: 'busy' });
        return;
      }
      markCallContext(sender_pub_key, 'incoming', Boolean(parsedData.isVideo));
      clearCallTimeout();
      setCallState('incoming');
      setIncomingSDP(parsedData.sdp ?? null);
      presentStatus(`Incoming ${parsedData.isVideo ? 'video' : 'audio'} call`, 'success', false);
      void logCallEvent({
        peerPubKey: sender_pub_key,
        direction: 'incoming',
        media: parsedData.isVideo ? 'video' : 'audio',
        outcome: 'started',
      });
      callTimeoutRef.current = setTimeout(() => {
        socketManager.sendSignal(sender_pub_key, 'call_reject', { reason: 'missed' });
        logTerminalOutcome('missed');
        resetCallState('Missed call', { tone: 'warning', autoResetStatus: false });
      }, CALL_TIMEOUT_MS);
    } else if (type === 'call_answer' && parsedData.sdp) {
      if (callState !== 'outgoing' || !rtcManagerRef.current || callPeerRef.current !== sender_pub_key) {
        return;
      }
      const generation = callGenerationRef.current;
      clearCallTimeout();
      await rtcManagerRef.current?.handleAnswer(parsedData.sdp);
      if (callGenerationRef.current !== generation || callPeerRef.current !== sender_pub_key) {
        return;
      }
      presentStatus('Connecting...', 'neutral', false);
    } else if (type === 'call_reject') {
      if (callPeerRef.current !== sender_pub_key) {
        return;
      }
      const reason = parsedData.reason === 'busy'
        ? 'Contact is busy'
        : parsedData.reason === 'missed'
          ? 'Call missed'
          : parsedData.reason === 'connect_timeout'
            ? 'Connection timeout'
          : 'Call declined';
      logTerminalOutcome(parsedData.reason === 'missed' ? 'missed' : 'declined');
      resetCallState(reason, {
        tone: parsedData.reason === 'missed' ? 'warning' : 'danger',
        allowRetry: true,
        autoResetStatus: false,
      });
    } else if (type === 'call_end') {
      if (callPeerRef.current !== sender_pub_key) {
        return;
      }
      logTerminalOutcome('ended');
      resetCallState('Call ended', { tone: 'neutral', allowRetry: callDirectionRef.current === 'outgoing', autoResetStatus: false });
    } else if (type === 'ice_candidate') {
      if (callPeerRef.current !== sender_pub_key) {
        return;
      }
      if (!rtcManagerRef.current) {
        pendingRemoteCandidatesRef.current.push({
          senderPubKey: sender_pub_key,
          candidate: parsedData,
        });
        return;
      }
      await rtcManagerRef.current.handleCandidate(parsedData);
    }
  });

  const onStartCallEvent = useEffectEvent(async (event: Event) => {
    const e = event as CustomEvent<StartCallDetail>;
    await handleStartCallAction(Boolean(e.detail.video), e.detail.peerPubKey);
  });

  const onSocketDisconnect = useEffectEvent(() => {
    if (callState !== 'idle') {
      logTerminalOutcome('failed');
      resetCallState('Connection lost', { tone: 'danger', allowRetry: true, autoResetStatus: false });
    }
  });

  useEffect(() => {
    const handleSignal = (event: Event) => {
      void onSignal(event);
    };
    const handleStartCall = (event: Event) => {
      void onStartCallEvent(event);
    };
    const handleSocketDisconnect = () => {
      onSocketDisconnect();
    };

    window.addEventListener('webrtc_signal', handleSignal);
    window.addEventListener('start_call', handleStartCall);
    window.addEventListener('socket_disconnected', handleSocketDisconnect);
    return () => {
      window.removeEventListener('webrtc_signal', handleSignal);
      window.removeEventListener('start_call', handleStartCall);
      window.removeEventListener('socket_disconnected', handleSocketDisconnect);
      clearCallTimeout();
      clearConnectTimeout();
      clearStatusReset();
    };
  }, []);

  const handleToggleMic = () => {
    const nextValue = !isMicOn;
    setIsMicOn(nextValue);
    rtcManagerRef.current?.setMicEnabled(nextValue);
  };

  const handleToggleVideo = () => {
    const nextValue = !isVideoOn;
    setIsVideoOn(nextValue);
    rtcManagerRef.current?.setVideoEnabled(nextValue);
  };

  const handleRetryLastCall = () => {
    if (!lastRetryTarget) {
      return;
    }
    void handleStartCallAction(lastRetryTarget.video, lastRetryTarget.peerPubKey);
  };

  const statusToneClass = statusTone === 'success'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
    : statusTone === 'warning'
      ? 'border-amber-400/30 bg-amber-400/10 text-amber-100'
      : statusTone === 'danger'
        ? 'border-red-400/30 bg-red-500/10 text-red-100'
        : 'border-slate-700 bg-slate-900/85 text-slate-300';

  if (callState === 'idle') {
    return statusText ? (
      <div className={`absolute top-4 right-4 z-30 min-w-[220px] rounded-2xl border px-3 py-3 text-xs backdrop-blur-md ${statusToneClass}`}>
        <div>{statusText}</div>
        {lastRetryTarget ? (
          <button
            type="button"
            onClick={handleRetryLastCall}
            className="mt-2 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-medium text-white transition-all hover:bg-white/10"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Retry {lastRetryTarget.video ? 'video' : 'audio'} call
          </button>
        ) : null}
      </div>
    ) : null;
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-slate-950 p-4 sm:p-8">
      <div className="absolute top-4 flex items-center gap-2 text-primary-400 animate-pulse sm:top-8">
        <ShieldCheck className="w-5 h-5" />
        <span className="text-xs font-mono uppercase tracking-widest">End-to-End Encrypted Call</span>
      </div>

      {statusText ? (
        <div className={`absolute top-14 rounded-full border px-4 py-2 text-xs sm:top-16 ${statusToneClass}`}>
          {statusText}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setShowDiagnostics((current) => !current)}
        className="absolute right-4 top-4 inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/90 px-3 py-2 text-xs text-slate-300 transition-all hover:border-slate-500 hover:text-white sm:right-8 sm:top-8"
      >
        <Activity className="h-4 w-4" />
        Diagnostics
      </button>

      <div className="relative w-full max-w-4xl aspect-video bg-slate-900 rounded-3xl overflow-hidden shadow-2xl border border-slate-800">
        <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
        
          <div className="absolute bottom-4 right-4 aspect-video w-28 overflow-hidden rounded-2xl border-2 border-slate-700 bg-black shadow-xl sm:bottom-6 sm:right-6 sm:w-48">
          <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
        </div>

        {callState === 'outgoing' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-24 h-24 rounded-full bg-primary-500/20 flex items-center justify-center animate-bounce overflow-hidden border border-primary-400/20">
              {displayAvatar ? (
                <img src={displayAvatar} alt={displayName} className="h-full w-full object-cover" />
              ) : (
                <span className="text-4xl font-bold text-white">{displayName.charAt(0).toUpperCase()}</span>
              )}
            </div>
            <h2 className="text-2xl font-bold mt-6">Calling...</h2>
            <p className="text-slate-400 text-sm mt-2">{displayName}</p>
            <p className="text-slate-500 text-xs mt-3">Auto-cancels after 30 seconds if unanswered</p>
          </div>
        )}

        {showDiagnostics ? (
          <div className="absolute left-3 top-3 z-10 w-[calc(100%-24px)] max-w-72 rounded-2xl border border-slate-700 bg-slate-950/85 p-4 text-xs text-slate-300 backdrop-blur sm:left-6 sm:top-6 sm:w-72">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Call Diagnostics</div>
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Peer</span>
                <span className="max-w-[150px] truncate text-right text-white">{displayName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Direction</span>
                <span className="text-white">{callDirection}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Media</span>
                <span className="text-white">{callMedia}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Call state</span>
                <span className="text-white">{callState}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Peer state</span>
                <span className="text-white">{peerConnectionState}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">ICE state</span>
                <span className="text-white">{iceConnectionState}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Relay</span>
                <span className="text-white">{appConfig.rtcRelayConfigured ? 'configured' : 'missing'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Mic</span>
                <span className="text-white">{isMicOn ? 'enabled' : 'muted'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Camera</span>
                <span className="text-white">{isVideoOn ? 'enabled' : 'disabled'}</span>
              </div>
              {!appConfig.rtcRelayConfigured ? (
                <div className="rounded-xl border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-[11px] leading-5 text-amber-100">
                  TURN relay is not configured. Calls may fail on strict NATs, mobile networks, or corporate Wi-Fi even when messaging works.
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-8 flex items-center gap-4 sm:mt-12 sm:gap-6">
        <button 
          onClick={handleToggleMic}
          className={`p-5 rounded-full transition-all ${isMicOn ? 'bg-slate-800 hover:bg-slate-700' : 'bg-red-500/20 text-red-400'}`}
        >
          {isMicOn ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
        </button>
        
        <button 
          onClick={handleEndCall}
          className="p-6 bg-red-600 hover:bg-red-500 rounded-full shadow-lg shadow-red-600/30 transition-all hover:scale-110"
        >
          <PhoneOff className="w-8 h-8 text-white" />
        </button>

        <button 
          onClick={handleToggleVideo}
          className={`p-5 rounded-full transition-all ${isVideoOn ? 'bg-slate-800 hover:bg-slate-700' : 'bg-red-500/20 text-red-400'}`}
        >
          {isVideoOn ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
        </button>
      </div>

      {callState === 'incoming' && (
        <div className="fixed inset-0 z-[110] bg-slate-950/90 backdrop-blur-xl flex flex-col items-center justify-center">
           <div className="w-32 h-32 rounded-full bg-green-500/20 flex items-center justify-center animate-pulse mb-8 overflow-hidden border border-green-400/20">
              {displayAvatar ? (
                <img src={displayAvatar} alt={displayName} className="h-full w-full object-cover" />
              ) : (
                <span className="text-5xl font-bold text-white">{displayName.charAt(0).toUpperCase()}</span>
              )}
           </div>
           <h2 className="text-3xl font-bold mb-2">Incoming {isVideo ? 'Video' : 'Audio'} Call</h2>
           <p className="text-slate-400 mb-12">{displayName}</p>
           <p className="mb-8 text-xs text-slate-500">If you do not answer within 30 seconds, the call will be marked as missed.</p>
           <div className="flex gap-8">
              <button onClick={handleRejectCall} className="w-20 h-20 bg-red-600 rounded-full flex items-center justify-center"><PhoneOff className="w-8 h-8 text-white" /></button>
              <button onClick={handleAccept} className="w-20 h-20 bg-green-600 rounded-full flex items-center justify-center animate-bounce"><Phone className="w-8 h-8 text-white" /></button>
           </div>
        </div>
      )}
    </div>
  );
};
