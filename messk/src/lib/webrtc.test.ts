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
  muted = false;
  readyState: MediaStreamTrackState = 'live';
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  readonly kind: 'audio' | 'video';

  constructor(kind: 'audio' | 'video') {
    this.kind = kind;
  }

  stop() {
    this.readyState = 'ended';
  }
}

type FakeTransceiver = {
  receiver: { track: FakeTrack };
  sender: RTCRtpSender;
  direction: RTCRtpTransceiverDirection;
};

class FakePeerConnection {
  static latest: FakePeerConnection | null = null;
  addedTracks: FakeTrack[] = [];
  addedTransceivers: string[] = [];
  replacedTracks: Array<FakeTrack | null> = [];
  transceivers: FakeTransceiver[] = [];
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
    const existing = this.transceivers.find((transceiver) => transceiver.receiver.track.kind === track.kind);
    if (existing) {
      return existing.sender;
    }

    const transceiver = this.makeTransceiver(track.kind);
    this.transceivers.push(transceiver);
    return transceiver.sender;
  }

  addTransceiver(kind: string, init?: RTCRtpTransceiverInit) {
    this.addedTransceivers.push(kind);
    const transceiver = this.makeTransceiver(
      kind as 'audio' | 'video',
      init?.direction ?? 'sendrecv'
    );
    this.transceivers.push(transceiver);
    return transceiver as unknown as RTCRtpTransceiver;
  }

  getTransceivers() {
    return this.transceivers as unknown as RTCRtpTransceiver[];
  }

  private makeTransceiver(
    kind: 'audio' | 'video',
    direction: RTCRtpTransceiverDirection = 'sendrecv'
  ): FakeTransceiver {
    return {
      receiver: { track: new FakeTrack(kind) },
      direction,
      sender: {
        replaceTrack: vi.fn(async (replacement: FakeTrack | null) => {
          this.replacedTracks.push(replacement);
        }),
      } as unknown as RTCRtpSender,
    };
  }

  async createOffer() {
    return { type: 'offer' as RTCSdpType, sdp: 'offer-sdp' };
  }

  async createAnswer() {
    return { type: 'answer' as RTCSdpType, sdp: 'answer-sdp' };
  }

  async setRemoteDescription() {
    if (!this.transceivers.some((transceiver) => transceiver.receiver.track.kind === 'video')) {
      this.transceivers.push(this.makeTransceiver('video', 'recvonly'));
    }
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
    Object.defineProperty(globalThis, 'RTCSessionDescription', {
      configurable: true,
      value: class {
        constructor(init: RTCSessionDescriptionInit) {
          Object.assign(this, init);
        }
      },
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

  it('can publish a screen track after answering an audio call', async () => {
    const manager = new WebRTCManager(() => undefined);

    await manager.handleOffer('peer', { type: 'offer', sdp: 'offer-sdp' }, 'audio');
    const videoTransceiver = FakePeerConnection.latest?.transceivers.find(
      (transceiver) => transceiver.receiver.track.kind === 'video'
    );

    expect(videoTransceiver?.direction).toBe('sendrecv');

    await manager.startScreenShare();

    expect(FakePeerConnection.latest?.replacedTracks).toEqual([screenTrack]);
  });

  it('adds a streamless incoming screen track to the existing remote audio stream', async () => {
    const displayedStreams: FakeMediaStream[] = [];
    const manager = new WebRTCManager((stream) => {
      displayedStreams.push(stream as unknown as FakeMediaStream);
    });
    const incomingAudio = new FakeTrack('audio');
    const incomingScreen = new FakeTrack('video');

    await manager.startCall('peer', 'audio');
    FakePeerConnection.latest?.ontrack?.({
      track: incomingAudio,
      streams: [new FakeMediaStream([incomingAudio])],
    } as unknown as RTCTrackEvent);
    FakePeerConnection.latest?.ontrack?.({
      track: incomingScreen,
      streams: [],
    } as unknown as RTCTrackEvent);

    const displayedStream = displayedStreams.at(-1);
    expect(displayedStream?.getAudioTracks()).toEqual([incomingAudio]);
    expect(displayedStream?.getVideoTracks()).toEqual([incomingScreen]);
  });
});
