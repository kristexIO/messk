import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptFile, encryptFile, trustedAttachmentDownloadUrl } from './attachments';
import { appConfig } from './config';

describe('encrypted attachments', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round trips an encrypted attachment and rejects modified ciphertext', async () => {
    const plaintext = new File(['ciphertext integrity'], 'note.txt', { type: 'text/plain' });
    const encrypted = await encryptFile(plaintext);
    const bytes = new Uint8Array(await encrypted.encryptedBlob.arrayBuffer());

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, { status: 200 })));
    const decrypted = await decryptFile('/download/note', encrypted.key);
    await expect(decrypted.text()).resolves.toBe('ciphertext integrity');

    const tampered = bytes.slice();
    tampered[tampered.length - 1] ^= 1;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(tampered, { status: 200 })));
    await expect(decryptFile('/download/note', encrypted.key)).rejects.toThrow('Failed to decrypt file');
  });

  it('rejects external or non-download URLs before attaching session headers', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(trustedAttachmentDownloadUrl('/download/file.bin?token=test')).toBe(
      `${appConfig.backendOrigin}/download/file.bin?token=test`
    );
    await expect(decryptFile('https://attacker.example/collect', 'invalid')).rejects.toThrow(
      'not a trusted backend download route'
    );
    await expect(decryptFile(`${appConfig.backendOrigin}/profile`, 'invalid')).rejects.toThrow(
      'not a trusted backend download route'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
