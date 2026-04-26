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
  return deriveKeysFromSeed(seed);
}

export async function deriveKeysFromPhraseAsync(phrase: string): Promise<KeyPair> {
  if (!isValidSeedPhrase(phrase)) {
    throw new Error('Invalid seed phrase');
  }

  const seed = await mnemonicToSeed(phrase);
  return deriveKeysFromSeed(seed);
}

function deriveKeysFromSeed(seed: Uint8Array): KeyPair {
  const secretKeyBytes = new Uint8Array(seed.slice(0, 32));
  const keyPair = box.keyPair.fromSecretKey(secretKeyBytes);

  return {
    publicKey: encodeBase64(keyPair.publicKey),
    secretKey: encodeBase64(keyPair.secretKey),
  };
}
