import { socketManager } from './socket';
import { appConfig } from './config';

const ICE_SERVERS: RTCIceServer[] = appConfig.rtcIceServers;

export type CallMediaMode = 'audio' | 'video' | 'screen';
export type LocalVideoSource = 'camera' | 'screen' | null;

export class WebRTCManager {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private videoSender: RTCRtpSender | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionReady = false;
  private onRemoteStream: (stream: MediaStream) => void;
  private onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  private onIceConnectionStateChange?: (state: RTCIceConnectionState) => void;
  private onLocalVideoChange?: (stream: MediaStream | null, source: LocalVideoSource) => void;
  private onRemoteVideoStateChange?: (visible: boolean) => void;

  constructor(
    onRemoteStream: (stream: MediaStream) => void,
    onConnectionStateChange?: (state: RTCPeerConnectionState) => void,
    onIceConnectionStateChange?: (state: RTCIceConnectionState) => void,
    onLocalVideoChange?: (stream: MediaStream | null, source: LocalVideoSource) => void,
    onRemoteVideoStateChange?: (visible: boolean) => void
  ) {
    this.onRemoteStream = onRemoteStream;
    this.onConnectionStateChange = onConnectionStateChange;
    this.onIceConnectionStateChange = onIceConnectionStateChange;
    this.onLocalVideoChange = onLocalVideoChange;
    this.onRemoteVideoStateChange = onRemoteVideoStateChange;
  }

  private async requestMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not allow microphone access for calls.');
    }

    const constraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    };

    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
  }

  private async requestCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not allow camera access for calls.');
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      return stream.getVideoTracks()[0] ?? null;
    } catch {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      return stream.getVideoTracks()[0] ?? null;
    }
  }

  private async requestScreenTrack() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('This browser does not support screen sharing.');
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: {
        frameRate: { ideal: 15, max: 30 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
      throw new Error('No screen was selected for sharing.');
    }
    return track;
  }

  private async setupLocalMedia(mode: CallMediaMode, isOfferer: boolean) {
    const audioStream = await this.requestMicrophone();
    this.localStream = new MediaStream(audioStream.getAudioTracks());
    this.localStream.getAudioTracks().forEach((track) => {
      this.peerConnection?.addTrack(track, this.localStream as MediaStream);
    });

    if (mode === 'video') {
      try {
        this.cameraTrack = await this.requestCamera();
      } catch {
        this.cameraTrack = null;
      }
      if (this.cameraTrack) {
        this.localStream.addTrack(this.cameraTrack);
        this.videoSender = this.peerConnection?.addTrack(this.cameraTrack, this.localStream) ?? null;
      } else if (isOfferer) {
        this.videoSender = this.peerConnection?.addTransceiver('video', { direction: 'sendrecv' }).sender ?? null;
      }
    } else if (mode === 'screen' && isOfferer) {
      this.screenTrack = await this.requestScreenTrack();
      this.localStream.addTrack(this.screenTrack);
      this.videoSender = this.peerConnection?.addTrack(this.screenTrack, this.localStream) ?? null;
      this.bindScreenEnded();
    } else if (isOfferer) {
      this.videoSender = this.peerConnection?.addTransceiver('video', { direction: 'sendrecv' }).sender ?? null;
    }

    return this.localStream;
  }

  async startCall(recipientPubKey: string, mode: CallMediaMode) {
    if (!(await socketManager.ensureRealtimeReady())) {
      throw new Error('Secure signaling is not ready yet');
    }

    this.peerConnection = this.createPeerConnection(recipientPubKey);
    this.remoteDescriptionReady = false;

    const stream = await this.setupLocalMedia(mode, true);
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    if (!socketManager.sendSignal(recipientPubKey, 'call_offer', {
      sdp: {
        type: offer.type,
        sdp: offer.sdp ?? '',
      },
      isVideo: mode !== 'audio',
      isScreenShare: mode === 'screen',
      mediaMode: mode,
    })) {
      throw new Error('Secure signaling is not ready yet');
    }

    return stream;
  }

  async handleOffer(senderPubKey: string, offer: RTCSessionDescriptionInit, mode: CallMediaMode) {
    if (!(await socketManager.ensureRealtimeReady())) {
      throw new Error('Secure signaling is not ready yet');
    }

    this.peerConnection = this.createPeerConnection(senderPubKey);
    this.remoteDescriptionReady = false;

    const stream = await this.setupLocalMedia(mode === 'screen' ? 'audio' : mode, false);

    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    this.remoteDescriptionReady = true;
    this.videoSender = this.prepareVideoSenderForSharing();
    await this.flushPendingCandidates();
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    if (!socketManager.sendSignal(senderPubKey, 'call_answer', {
      sdp: {
        type: answer.type,
        sdp: answer.sdp ?? '',
      },
    })) {
      throw new Error('Secure signaling is not ready yet');
    }

    return stream;
  }

  async handleAnswer(answer: RTCSessionDescriptionInit) {
    await this.peerConnection?.setRemoteDescription(new RTCSessionDescription(answer));
    this.remoteDescriptionReady = true;
    this.videoSender = this.videoSender ?? this.findVideoSender();
    await this.flushPendingCandidates();
  }

  async handleCandidate(candidate: RTCIceCandidateInit) {
    if (!this.peerConnection || !this.remoteDescriptionReady) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  setMicEnabled(enabled: boolean) {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  setVideoEnabled(enabled: boolean) {
    if (this.cameraTrack) {
      this.cameraTrack.enabled = enabled;
    }
  }

  async startScreenShare() {
    if (!this.peerConnection) {
      throw new Error('A connected call is required before sharing your screen.');
    }
    const sender = this.videoSender ?? this.findVideoSender();
    if (!sender) {
      throw new Error('Screen sharing requires a newly started call.');
    }

    const track = await this.requestScreenTrack();
    try {
      await sender.replaceTrack(track);
    } catch (error) {
      track.stop();
      throw error;
    }
    this.screenTrack?.stop();
    this.screenTrack = track;
    this.bindScreenEnded();
    const previewStream = new MediaStream([track]);
    this.onLocalVideoChange?.(previewStream, 'screen');
    return previewStream;
  }

  async stopScreenShare() {
    if (!this.screenTrack) {
      return;
    }
    const sender = this.videoSender ?? this.findVideoSender();
    const replacement = this.cameraTrack && this.cameraTrack.enabled ? this.cameraTrack : null;
    await sender?.replaceTrack(replacement);
    const stoppedTrack = this.screenTrack;
    this.screenTrack = null;
    stoppedTrack.onended = null;
    stoppedTrack.stop();
    this.onLocalVideoChange?.(
      replacement ? new MediaStream([replacement]) : null,
      replacement ? 'camera' : null
    );
  }

  private bindScreenEnded() {
    if (!this.screenTrack) return;
    this.screenTrack.onended = () => {
      void this.stopScreenShare();
    };
  }

  private findVideoSender() {
    return this.findVideoTransceiver()?.sender ?? null;
  }

  private prepareVideoSenderForSharing() {
    const transceiver = this.findVideoTransceiver();
    if (!transceiver) {
      return null;
    }

    if (transceiver.direction !== 'sendrecv') {
      transceiver.direction = 'sendrecv';
    }

    return transceiver.sender;
  }

  private findVideoTransceiver() {
    return this.peerConnection?.getTransceivers().find(
      (transceiver) => transceiver.receiver.track.kind === 'video'
    ) ?? null;
  }

  private createPeerConnection(peerPubKey: string) {
    this.pendingCandidates = [];
    this.remoteDescriptionReady = false;
    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 8,
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && socketManager.isRealtimeReady()) {
        socketManager.sendSignal(peerPubKey, 'ice_candidate', event.candidate.toJSON());
      }
    };

    pc.ontrack = (event) => {
      const associatedStream = event.streams[0];
      this.remoteStream = this.remoteStream ?? associatedStream ?? new MediaStream();
      const incomingTracks = associatedStream?.getTracks() ?? [event.track];
      incomingTracks.forEach((track) => {
        if (!this.remoteStream?.getTracks().includes(track)) {
          this.remoteStream?.addTrack(track);
        }
      });
      if (!this.remoteStream.getTracks().includes(event.track)) {
        this.remoteStream.addTrack(event.track);
      }
      this.onRemoteStream(this.remoteStream);
      if (event.track.kind === 'video') {
        const updateVideoState = () => {
          this.onRemoteVideoStateChange?.(event.track.readyState === 'live' && !event.track.muted);
        };
        event.track.onunmute = updateVideoState;
        event.track.onmute = updateVideoState;
        event.track.onended = updateVideoState;
        updateVideoState();
      }
    };

    pc.onconnectionstatechange = () => {
      this.onConnectionStateChange?.(pc.connectionState);
    };

    pc.oniceconnectionstatechange = () => {
      this.onIceConnectionStateChange?.(pc.iceConnectionState);
    };

    return pc;
  }

  endCall() {
    this.localStream?.getTracks().forEach((track) => track.stop());
    if (this.screenTrack && !this.localStream?.getTracks().includes(this.screenTrack)) {
      this.screenTrack.stop();
    }
    this.peerConnection?.close();
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.cameraTrack = null;
    this.screenTrack = null;
    this.videoSender = null;
    this.pendingCandidates = [];
    this.remoteDescriptionReady = false;
    this.onRemoteVideoStateChange?.(false);
    this.onLocalVideoChange?.(null, null);
  }

  private async flushPendingCandidates() {
    if (!this.peerConnection || !this.remoteDescriptionReady || this.pendingCandidates.length === 0) {
      return;
    }

    const candidates = [...this.pendingCandidates];
    this.pendingCandidates = [];
    for (const candidate of candidates) {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }
}
