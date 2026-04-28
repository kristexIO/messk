import { socketManager } from './socket';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

export class WebRTCManager {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionReady = false;
  private onRemoteStream: (stream: MediaStream) => void;
  private onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  private onIceConnectionStateChange?: (state: RTCIceConnectionState) => void;

  constructor(
    onRemoteStream: (stream: MediaStream) => void,
    onConnectionStateChange?: (state: RTCPeerConnectionState) => void,
    onIceConnectionStateChange?: (state: RTCIceConnectionState) => void
  ) {
    this.onRemoteStream = onRemoteStream;
    this.onConnectionStateChange = onConnectionStateChange;
    this.onIceConnectionStateChange = onIceConnectionStateChange;
  }

  private async requestMedia(isVideo: boolean) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not allow microphone or camera access for calls.');
    }

    const preferredConstraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: isVideo
        ? {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
        : false,
    };

    try {
      return await navigator.mediaDevices.getUserMedia(preferredConstraints);
    } catch {
      if (!isVideo) {
        return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      } catch {
        return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
    }
  }

  async startCall(recipientPubKey: string, isVideo: boolean) {
    if (!(await socketManager.ensureRealtimeReady())) {
      throw new Error('Secure signaling is not ready yet');
    }

    this.peerConnection = this.createPeerConnection(recipientPubKey);
    this.remoteDescriptionReady = false;
    
    this.localStream = await this.requestMedia(isVideo);

    this.localStream.getTracks().forEach(track => {
      if (this.localStream) this.peerConnection?.addTrack(track, this.localStream);
    });

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    if (!socketManager.sendSignal(recipientPubKey, 'call_offer', {
      sdp: {
        type: offer.type,
        sdp: offer.sdp ?? '',
      },
      isVideo
    })) {
      throw new Error('Secure signaling is not ready yet');
    }

    return this.localStream;
  }

  async handleOffer(senderPubKey: string, offer: RTCSessionDescriptionInit, isVideo: boolean) {
    if (!(await socketManager.ensureRealtimeReady())) {
      throw new Error('Secure signaling is not ready yet');
    }

    this.peerConnection = this.createPeerConnection(senderPubKey);
    this.remoteDescriptionReady = false;
    
    this.localStream = await this.requestMedia(isVideo);

    this.localStream.getTracks().forEach(track => {
      if (this.localStream) this.peerConnection?.addTrack(track, this.localStream);
    });

    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    this.remoteDescriptionReady = true;
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

    return this.localStream;
  }

  async handleAnswer(answer: RTCSessionDescriptionInit) {
    await this.peerConnection?.setRemoteDescription(new RTCSessionDescription(answer));
    this.remoteDescriptionReady = true;
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
    this.localStream?.getVideoTracks().forEach((track) => {
      track.enabled = enabled;
    });
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
      this.remoteStream = event.streams[0];
      this.onRemoteStream(this.remoteStream);
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
    this.localStream?.getTracks().forEach(track => track.stop());
    this.peerConnection?.close();
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.pendingCandidates = [];
    this.remoteDescriptionReady = false;
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
