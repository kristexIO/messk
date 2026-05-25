import { generateMnemonic, mnemonicToSeed, mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { Buffer } from 'buffer';
import { box } from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import type { KeyPair } from './crypto';

// Required for bip39 in browser environments that do not expose Buffer.
window.Buffer = window.Buffer || Buffer;

export function generateSeedPhrase(): string {
  return generateMnemonic(128);
}

export function isValidSeedPhrase(phrase: string): boolean {
  return validateMnemonic(phrase);
}

export function deriveKeysFromPhrase(phrase: string): KeyPair {
  if (!isValidSeedPhrase(phrase)) {
    throw new Error('Invalid seed phrase');
  }

  const seed = mnemonicToSeedSync(phrase);
  try {
    return deriveKeysFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}

export async function deriveKeysFromPhraseAsync(phrase: string): Promise<KeyPair> {
  if (!isValidSeedPhrase(phrase)) {
    throw new Error('Invalid seed phrase');
  }

  const seed = await mnemonicToSeed(phrase);
  try {
    return deriveKeysFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}

function deriveKeysFromSeed(seed: Uint8Array): KeyPair {
  const secretKeyBytes = new Uint8Array(32);
  secretKeyBytes.set(seed.subarray(0, 32));
  let keyPair: ReturnType<typeof box.keyPair.fromSecretKey> | null = null;
  try {
    keyPair = box.keyPair.fromSecretKey(secretKeyBytes);

    return {
      publicKey: encodeBase64(keyPair.publicKey),
      secretKey: encodeBase64(keyPair.secretKey),
    };
  } finally {
    secretKeyBytes.fill(0);
    keyPair?.secretKey.fill(0);
  }
}
