use base64::{Engine as _, engine::general_purpose::STANDARD};
use bip39::{Language, Mnemonic};
use crypto_box::{
    Nonce, PublicKey, SalsaBox, SecretKey,
    aead::{Aead, Error as AeadError},
};
use crypto_secretbox::{
    Key as SecretboxKey, Nonce as SecretboxNonce, XSalsa20Poly1305,
    aead::KeyInit as SecretboxKeyInit,
};
use curve25519_dalek::MontgomeryPoint;
use hkdf::Hkdf;
use salsa20::{
    cipher::{
        array::Array,
        consts::{U10, U16},
    },
    hsalsa,
};
use sha2::Sha256;
use thiserror::Error;
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Debug, Clone)]
pub struct Identity {
    pub public_key: String,
    pub secret_key: SecretString,
    pub seed_phrase: SecretString,
}

#[derive(Debug, Clone)]
pub struct BoxKeyPair {
    pub public_key: String,
    pub secret_key: SecretString,
}

#[derive(Debug, Clone, Zeroize, ZeroizeOnDrop)]
pub struct X3dhInitiation {
    pub shared_secret: [u8; 32],
    pub ephemeral_public_key: String,
    pub pre_key_public_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("seed phrase is invalid")]
    InvalidSeedPhrase,
    #[error("base64 payload is invalid")]
    InvalidBase64(#[from] base64::DecodeError),
    #[error("key must be 32 bytes")]
    InvalidKeyLength,
    #[error("encrypted payload is too short")]
    PayloadTooShort,
    #[error("random bytes generation failed")]
    RandomFailed,
    #[error("key derivation failed")]
    KeyDeriveFailed,
    #[error("box decrypt failed")]
    DecryptFailed,
    #[error("file encrypt failed")]
    EncryptFailed,
    #[error("plaintext is not valid UTF-8")]
    Utf8(#[from] std::string::FromUtf8Error),
}

impl From<AeadError> for CryptoError {
    fn from(_: AeadError) -> Self {
        Self::DecryptFailed
    }
}

pub fn generate_identity() -> Result<Identity, CryptoError> {
    let mnemonic =
        Mnemonic::generate_in(Language::English, 12).map_err(|_| CryptoError::InvalidSeedPhrase)?;
    let phrase = SecretString::new(mnemonic.to_string());
    identity_from_seed_phrase(phrase.expose())
}

pub fn generate_box_keypair() -> Result<BoxKeyPair, CryptoError> {
    let mut secret_bytes = [0u8; 32];
    getrandom::fill(&mut secret_bytes).map_err(|_| CryptoError::RandomFailed)?;
    let secret_key = SecretKey::from(secret_bytes);
    let public_key = secret_key.public_key();
    let pair = BoxKeyPair {
        public_key: encode_key(public_key.as_bytes()),
        secret_key: SecretString::new(encode_key(secret_key.as_bytes())),
    };
    secret_bytes.zeroize();
    Ok(pair)
}

pub fn identity_from_seed_phrase(phrase: &str) -> Result<Identity, CryptoError> {
    let normalized = SecretString::new(phrase.trim().to_lowercase());
    let mnemonic = Mnemonic::parse_in(Language::English, normalized.expose())
        .map_err(|_| CryptoError::InvalidSeedPhrase)?;
    let mut seed = mnemonic.to_seed("");
    let mut secret_bytes = [0u8; 32];
    secret_bytes.copy_from_slice(&seed[..32]);
    let secret_key = SecretKey::from(secret_bytes);
    let public_key = secret_key.public_key();
    let identity = Identity {
        public_key: STANDARD.encode(public_key.as_bytes()),
        secret_key: SecretString::new(STANDARD.encode(secret_key.as_bytes())),
        seed_phrase: SecretString::new(normalized.expose().to_owned()),
    };
    secret_bytes.zeroize();
    seed.zeroize();
    Ok(identity)
}

pub fn decrypt_box_payload(
    payload_b64: &str,
    recipient_secret_b64: &str,
    sender_public_b64: &str,
) -> Result<String, CryptoError> {
    let payload = STANDARD.decode(payload_b64)?;
    if payload.len() <= 24 {
        return Err(CryptoError::PayloadTooShort);
    }

    let mut secret_bytes = decode_key(recipient_secret_b64)?;
    let secret = SecretKey::from(secret_bytes);
    secret_bytes.zeroize();
    let sender = PublicKey::from(decode_key(sender_public_b64)?);
    let cipher = SalsaBox::new(&sender, &secret);
    let nonce: &Nonce = (&payload[..24])
        .try_into()
        .map_err(|_| CryptoError::PayloadTooShort)?;
    let plaintext = cipher.decrypt(nonce, &payload[24..])?;
    Ok(String::from_utf8(plaintext)?)
}

pub fn encrypt_file_secretbox(plaintext: &[u8]) -> Result<(Vec<u8>, String), CryptoError> {
    let mut key = [0u8; 32];
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut key).map_err(|_| CryptoError::RandomFailed)?;
    if getrandom::fill(&mut nonce).is_err() {
        key.zeroize();
        return Err(CryptoError::RandomFailed);
    }

    let secretbox_key =
        SecretboxKey::try_from(&key[..]).map_err(|_| CryptoError::InvalidKeyLength)?;
    let secretbox_nonce =
        SecretboxNonce::try_from(&nonce[..]).map_err(|_| CryptoError::PayloadTooShort)?;
    let cipher = XSalsa20Poly1305::new(&secretbox_key);
    let ciphertext = match cipher
        .encrypt(&secretbox_nonce, plaintext)
        .map_err(|_| CryptoError::EncryptFailed)
    {
        Ok(value) => value,
        Err(error) => {
            key.zeroize();
            nonce.zeroize();
            return Err(error);
        }
    };

    let mut packed = Vec::with_capacity(nonce.len() + ciphertext.len());
    packed.extend_from_slice(&nonce);
    packed.extend_from_slice(&ciphertext);
    let key_b64 = STANDARD.encode(key);
    key.zeroize();
    nonce.zeroize();
    Ok((packed, key_b64))
}

pub fn decrypt_file_secretbox(payload: &[u8], key_b64: &str) -> Result<Vec<u8>, CryptoError> {
    if payload.len() <= 24 {
        return Err(CryptoError::PayloadTooShort);
    }
    let mut key = decode_key(key_b64)?;
    let secretbox_key =
        SecretboxKey::try_from(&key[..]).map_err(|_| CryptoError::InvalidKeyLength)?;
    let secretbox_nonce =
        SecretboxNonce::try_from(&payload[..24]).map_err(|_| CryptoError::PayloadTooShort)?;
    let cipher = XSalsa20Poly1305::new(&secretbox_key);
    let result = cipher
        .decrypt(&secretbox_nonce, &payload[24..])
        .map_err(|_| CryptoError::DecryptFailed);
    key.zeroize();
    result
}

pub fn x3dh_initiate(
    my_identity_secret_b64: &str,
    peer_identity_public_b64: &str,
    peer_pre_key_public_b64: Option<&str>,
) -> Result<X3dhInitiation, CryptoError> {
    let ephemeral = generate_box_keypair()?;

    let (dh1, dh3, pre_key_public_key) = if let Some(pre_key) = peer_pre_key_public_b64
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        (
            nacl_box_before(pre_key, my_identity_secret_b64)?,
            nacl_box_before(pre_key, ephemeral.secret_key.expose())?,
            Some(pre_key.to_string()),
        )
    } else {
        ([0u8; 32], [0u8; 32], None)
    };

    let dh2 = nacl_box_before(peer_identity_public_b64, ephemeral.secret_key.expose())?;
    let shared_secret = derive_x3dh_root_key_from_components(dh1, dh2, dh3);

    Ok(X3dhInitiation {
        shared_secret: shared_secret?,
        ephemeral_public_key: ephemeral.public_key,
        pre_key_public_key,
    })
}

pub fn x3dh_respond(
    my_identity_secret_b64: &str,
    my_pre_key_secret_b64: Option<&str>,
    peer_identity_public_b64: &str,
    peer_ephemeral_public_b64: &str,
) -> Result<[u8; 32], CryptoError> {
    let (dh1, dh3) = if let Some(pre_key_secret) = my_pre_key_secret_b64
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        (
            nacl_box_before(peer_identity_public_b64, pre_key_secret)?,
            nacl_box_before(peer_ephemeral_public_b64, pre_key_secret)?,
        )
    } else {
        ([0u8; 32], [0u8; 32])
    };

    let dh2 = nacl_box_before(peer_ephemeral_public_b64, my_identity_secret_b64)?;
    derive_x3dh_root_key_from_components(dh1, dh2, dh3)
}

pub fn nacl_box_before(
    peer_public_b64: &str,
    own_secret_b64: &str,
) -> Result<[u8; 32], CryptoError> {
    let peer_public = decode_key(peer_public_b64)?;
    let mut own_secret = decode_key(own_secret_b64)?;
    let mut shared_secret = MontgomeryPoint(peer_public).mul_clamped(own_secret);
    own_secret.zeroize();
    let zero_nonce = Array::<u8, U16>::default();
    let mut key = hsalsa::<U10>((&shared_secret.0).into(), &zero_nonce);
    let mut out = [0u8; 32];
    out.copy_from_slice(&key);
    key.zeroize();
    shared_secret.0.zeroize();
    Ok(out)
}

pub fn decode_key(value: &str) -> Result<[u8; 32], CryptoError> {
    let mut bytes = STANDARD.decode(value)?;
    if bytes.len() != 32 {
        bytes.zeroize();
        return Err(CryptoError::InvalidKeyLength);
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    bytes.zeroize();
    Ok(key)
}

pub fn encode_key(bytes: &[u8; 32]) -> String {
    STANDARD.encode(bytes)
}

fn combine_x3dh_components(dh1: [u8; 32], dh2: [u8; 32], dh3: [u8; 32]) -> [u8; 128] {
    let mut combined = [0u8; 128];
    combined[0..32].copy_from_slice(&dh1);
    combined[32..64].copy_from_slice(&dh2);
    combined[64..96].copy_from_slice(&dh3);
    combined
}

fn derive_x3dh_root_key_from_components(
    mut dh1: [u8; 32],
    mut dh2: [u8; 32],
    mut dh3: [u8; 32],
) -> Result<[u8; 32], CryptoError> {
    let mut combined = combine_x3dh_components(dh1, dh2, dh3);
    dh1.zeroize();
    dh2.zeroize();
    dh3.zeroize();
    let result = derive_x3dh_root_key(&combined);
    combined.zeroize();
    result
}

fn derive_x3dh_root_key(input_key_material: &[u8]) -> Result<[u8; 32], CryptoError> {
    let salt = [0u8; 32];
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), input_key_material);
    let mut out = [0u8; 32];
    match hkdf.expand(b"messk-x3dh-v2-root-key", &mut out) {
        Ok(()) => Ok(out),
        Err(_) => {
            out.zeroize();
            Err(CryptoError::KeyDeriveFailed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_stable_public_key_from_seed_phrase() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let first = identity_from_seed_phrase(phrase).unwrap();
        let second = identity_from_seed_phrase(phrase).unwrap();

        assert_eq!(first.public_key, second.public_key);
        assert_eq!(first.secret_key.expose(), second.secret_key.expose());
    }

    #[test]
    fn file_secretbox_round_trips_web_compatible_shape() {
        let plaintext = b"encrypted attachment body";
        let (payload, key) = encrypt_file_secretbox(plaintext).unwrap();
        assert!(payload.len() > 24);
        let decrypted = decrypt_file_secretbox(&payload, &key).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn file_secretbox_rejects_modified_ciphertext() {
        let (mut payload, key) = encrypt_file_secretbox(b"authenticated attachment").unwrap();
        let last = payload.len() - 1;
        payload[last] ^= 1;

        assert!(matches!(
            decrypt_file_secretbox(&payload, &key),
            Err(CryptoError::DecryptFailed)
        ));
    }

    #[test]
    fn x3dh_initiator_and_responder_derive_same_secret_with_prekey() {
        let alice = generate_box_keypair().unwrap();
        let bob = generate_box_keypair().unwrap();
        let bob_prekey = generate_box_keypair().unwrap();

        let initiated = x3dh_initiate(
            alice.secret_key.expose(),
            &bob.public_key,
            Some(&bob_prekey.public_key),
        )
        .unwrap();
        let responded = x3dh_respond(
            bob.secret_key.expose(),
            Some(bob_prekey.secret_key.expose()),
            &alice.public_key,
            &initiated.ephemeral_public_key,
        )
        .unwrap();

        assert_eq!(initiated.shared_secret, responded);
    }

    #[test]
    fn x3dh_initiator_and_responder_derive_same_secret_without_prekey() {
        let alice = generate_box_keypair().unwrap();
        let bob = generate_box_keypair().unwrap();

        let initiated = x3dh_initiate(alice.secret_key.expose(), &bob.public_key, None).unwrap();
        let responded = x3dh_respond(
            bob.secret_key.expose(),
            None,
            &alice.public_key,
            &initiated.ephemeral_public_key,
        )
        .unwrap();

        assert_eq!(initiated.shared_secret, responded);
    }

    #[test]
    fn x3dh_initiation_zeroize_clears_derived_secret() {
        let mut initiation = X3dhInitiation {
            shared_secret: [7u8; 32],
            ephemeral_public_key: "public".to_string(),
            pre_key_public_key: Some("prekey".to_string()),
        };

        initiation.zeroize();

        assert_eq!(initiation.shared_secret, [0u8; 32]);
        assert!(initiation.ephemeral_public_key.is_empty());
        assert!(
            initiation
                .pre_key_public_key
                .as_deref()
                .unwrap_or_default()
                .is_empty()
        );
    }
}
