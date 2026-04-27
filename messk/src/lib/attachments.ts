import { randomBytes, secretbox } from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { socketManager } from './socket';
import { fetchWithTimeout } from './http';

export interface EncryptedFile {
  url: string;
  key: string; // Base64 symmetric key
  name: string;
  type: string;
  size: number;
}

/**
 * Strips EXIF and other metadata by re-drawing image to a canvas
 */
async function scrubImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) return file;
  
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        resolve(blob || file);
      }, file.type);
    };
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
}

/**
 * Encrypt a file using a random symmetric key
 */
export async function encryptFile(file: File): Promise<{ encryptedBlob: Blob; key: string }> {
  const scrubbedFile = await scrubImage(file);
  const key = randomBytes(secretbox.keyLength);
  const nonce = randomBytes(secretbox.nonceLength);
  
  const arrayBuffer = await scrubbedFile.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);
  
  const encrypted = secretbox(data, nonce, key);
  
  // Pack nonce + encrypted data
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce);
  result.set(encrypted, nonce.length);
  
  return {
    encryptedBlob: new Blob([result], { type: 'application/octet-stream' }),
    key: encodeBase64(key)
  };
}

/**
 * Decrypt a file from a URL using a symmetric key
 */
export async function decryptFile(url: string, keyBase64: string): Promise<Blob> {
  const response = await fetchWithTimeout(url, {
    headers: socketManager.getSessionHeaders()
  });
  if (!response.ok) {
    throw new Error(`Failed to download file (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const fullData = new Uint8Array(arrayBuffer);
  
  const key = decodeBase64(keyBase64);
  const nonce = fullData.slice(0, secretbox.nonceLength);
  const encrypted = fullData.slice(secretbox.nonceLength);
  
  const decrypted = secretbox.open(encrypted, nonce, key);
  if (!decrypted) {
    throw new Error('Failed to decrypt file');
  }
  
  return new Blob([new Uint8Array(decrypted)]);
}
