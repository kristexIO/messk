import { beforeEach, describe, expect, it, vi } from 'vitest';
import { socketManager } from './socket';
import { WebRTCManager } from './webrtc';

vi.mock('./socket', () => ({
  socketManager: {
    ensureRealtimeReady: vi.fn(async () => true),
    sendSignal: vi.fn(() => true),
    isRealtimeReady: vi.fn(() => true),
  },
}));

vi.mock('./config', () => ({
  appConfig: {
    rtcIceServers: [],
  },
}));

class FakeMediaStream {
  private readonly tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }

  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }

  getTracks() {
    return [...this.tracks];
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }
}

class FakeTrack {
  enabled = true;
  readyState: MediaStreamTrackState = 'live';
  onended: (() => void) | null = null;
  readonly kind: 'audio' | 'video';

  constructor(kind: 'audio' | 'video') {
    this.kind = kind;
  }

  stop() {
    this.readyState = 'ended';
  }
}

class FakePeerConnection {
  static latest: FakePeerConnection | null = null;
  addedTracks: FakeTrack[] = [];
  addedTransceivers: string[] = [];
  replacedTracks: Array<FakeTrack | null> = [];
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  constructor() {
    FakePeerConnection.latest = this;
  }

  addTrack(track: FakeTrack) {
    this.addedTracks.push(track);
    return {
      replaceTrack: vi.fn(async (replacement: FakeTrack | null) => {
        this.replacedTracks.push(replacement);
      }),
    } as unknown as RTCRtpSender;
  }

  addTransceiver(kind: string) {
    this.addedTransceivers.push(kind);
    return {
      sender: {
        replaceTrack: vi.fn(async (replacement: FakeTrack | null) => {
          this.replacedTracks.push(replacement);
        }),
      },
    } as unknown as RTCRtpTransceiver;
  }

  async createOffer() {
    return { type: 'offer' as RTCSdpType, sdp: 'offer-sdp' };
  }

  async setLocalDescription() {}

  close() {}
}

describe('WebRTCManager call media modes', () => {
  const audioTrack = new FakeTrack('audio');
  const screenTrack = new FakeTrack('video');
  const getUserMedia = vi.fn(async () => new FakeMediaStream([audioTrack]));
  const getDisplayMedia = vi.fn(async () => new FakeMediaStream([screenTrack]));

  beforeEach(() => {
    vi.clearAllMocks();
    FakePeerConnection.latest = null;
    Object.defineProperty(globalThis, 'MediaStream', {
      configurable: true,
      value: FakeMediaStream,
    });
    Object.defineProperty(globalThis, 'RTCPeerConnection', {
      configurable: true,
      value: FakePeerConnection,
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, getDisplayMedia },
    });
  });

  it('keeps an ordinary audio call microphone-only', async () => {
    const manager = new WebRTCManager(() => undefined);

    await manager.startCall('peer', 'audio');

    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: false }));
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(FakePeerConnection.latest?.addedTracks).toEqual([audioTrack]);
    expect(FakePeerConnection.latest?.addedTransceivers).toEqual(['video']);
    expect(socketManager.sendSignal).toHaveBeenCalledWith(
      'peer',
      'call_offer',
      expect.objectContaining({ isVideo: false, mediaMode: 'audio' })
    );
  });

  it('sends a selected display track for a screen-share call', async () => {
    const manager = new WebRTCManager(() => undefined);

    await manager.startCall('peer', 'screen');

    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(FakePeerConnection.latest?.addedTracks).toEqual([audioTrack, screenTrack]);
    expect(socketManager.sendSignal).toHaveBeenCalledWith(
      'peer',
      'call_offer',
      expect.objectContaining({ isVideo: true, isScreenShare: true, mediaMode: 'screen' })
    );
  });

  it('can start screen sharing inside an audio call without opening a camera', async () => {
    const manager = new WebRTCManager(() => undefined);

    await manager.startCall('peer', 'audio');
    await manager.startScreenShare();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(FakePeerConnection.latest?.replacedTracks).toEqual([screenTrack]);
  });
});
