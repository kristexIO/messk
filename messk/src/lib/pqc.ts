/**
 * PQC is intentionally disabled until this module is backed by a real,
 * interoperable ML-KEM implementation.
 */
export class PQCManager {
  static async generateKeyPair(): Promise<{ publicKey: string; secretKey: string }> {
    throw new Error('PQC is disabled until a real ML-KEM implementation is available');
  }

  static async encapsulate(peerPubKey: string): Promise<{ ciphertext: string; sharedSecret: Uint8Array }> {
    void peerPubKey;
    throw new Error('PQC is disabled until a real ML-KEM implementation is available');
  }

  static async decapsulate(ciphertext: string, mySecretKey: string): Promise<Uint8Array> {
    void ciphertext;
    void mySecretKey;
    throw new Error('PQC is disabled until a real ML-KEM implementation is available');
  }
}
