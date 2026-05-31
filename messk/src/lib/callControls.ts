export type AccessibleCallState = 'idle' | 'incoming' | 'outgoing' | 'active';
export type AccessibleCallMedia = 'audio' | 'video' | 'screen';
export type AccessibleCallTone = 'neutral' | 'success' | 'warning' | 'danger';

export type CallControlAccessibility = {
  overlayTitle: string;
  overlayDescription: string;
  diagnosticsLabel: string;
  micLabel: string;
  videoLabel: string;
  screenShareLabel: string;
  endLabel: string;
  acceptLabel: string;
  rejectLabel: string;
  retryLabel: string;
  statusRole: 'status' | 'alert';
  statusLive: 'polite' | 'assertive';
};

export function accessibleCallMediaLabel(media: AccessibleCallMedia): string {
  if (media === 'screen') {
    return 'screen share';
  }
  return `${media} call`;
}

export function buildCallControlAccessibility(input: {
  callState: AccessibleCallState;
  callMedia: AccessibleCallMedia;
  isMicOn: boolean;
  isVideoOn: boolean;
  isScreenSharing: boolean;
  showDiagnostics: boolean;
  statusTone: AccessibleCallTone;
}): CallControlAccessibility {
  const mediaLabel = accessibleCallMediaLabel(input.callMedia);
  const urgentStatus = input.statusTone === 'danger' || input.statusTone === 'warning';

  return {
    overlayTitle: input.callState === 'incoming'
      ? `Incoming ${mediaLabel}`
      : `End-to-end encrypted ${mediaLabel}`,
    overlayDescription: 'Use keyboard-accessible controls to answer, reject, mute, end, or retry the call. Sensitive signaling details stay hidden.',
    diagnosticsLabel: input.showDiagnostics ? 'Hide call diagnostics' : 'Show call diagnostics',
    micLabel: input.isMicOn ? 'Microphone is on. Press to mute.' : 'Microphone is muted. Press to unmute.',
    videoLabel: input.isVideoOn ? 'Camera is on. Press to disable camera.' : 'Camera is off. Press to enable camera.',
    screenShareLabel: input.isScreenSharing
      ? 'Screen sharing is on. Press to stop sharing.'
      : input.callState === 'active'
        ? 'Screen sharing is off. Press to share screen.'
        : 'Screen sharing is available after the call connects.',
    endLabel: 'End call',
    acceptLabel: `Accept incoming ${mediaLabel}`,
    rejectLabel: `Reject incoming ${mediaLabel}`,
    retryLabel: `Retry ${mediaLabel}`,
    statusRole: urgentStatus ? 'alert' : 'status',
    statusLive: urgentStatus ? 'assertive' : 'polite',
  };
}

