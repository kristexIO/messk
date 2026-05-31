import { describe, expect, it } from 'vitest';
import { accessibleCallMediaLabel, buildCallControlAccessibility } from './callControls';

describe('call control accessibility contract', () => {
  it('builds keyboard and screen-reader labels for call controls', () => {
    const labels = buildCallControlAccessibility({
      callState: 'active',
      callMedia: 'video',
      isMicOn: true,
      isVideoOn: false,
      isScreenSharing: false,
      showDiagnostics: false,
      statusTone: 'success',
    });

    expect(labels.overlayTitle).toBe('End-to-end encrypted video call');
    expect(labels.micLabel).toMatch(/mute/i);
    expect(labels.videoLabel).toMatch(/enable camera/i);
    expect(labels.screenShareLabel).toMatch(/share screen/i);
    expect(labels.statusRole).toBe('status');
    expect(labels.statusLive).toBe('polite');
  });

  it('uses assertive alerts for warning and danger status changes', () => {
    expect(buildCallControlAccessibility({
      callState: 'outgoing',
      callMedia: 'audio',
      isMicOn: false,
      isVideoOn: false,
      isScreenSharing: false,
      showDiagnostics: true,
      statusTone: 'danger',
    })).toMatchObject({
      diagnosticsLabel: 'Hide call diagnostics',
      statusRole: 'alert',
      statusLive: 'assertive',
    });
  });

  it('keeps assistive labels generic and free of signaling secrets', () => {
    const text = JSON.stringify(buildCallControlAccessibility({
      callState: 'incoming',
      callMedia: 'screen',
      isMicOn: true,
      isVideoOn: false,
      isScreenSharing: false,
      showDiagnostics: false,
      statusTone: 'warning',
    }));

    expect(accessibleCallMediaLabel('screen')).toBe('screen share');
    expect(text).toContain('Sensitive signaling details stay hidden');
    expect(text).not.toMatch(/seed|secret|token|sdp|ice|candidate|public key|message text/i);
  });
});

