use crate::crypto::{self, CryptoError, X3dhInitiation};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use crypto_secretbox::{KeyInit, Nonce, XSalsa20Poly1305, aead::Aead};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Error)]
pub enum RatchetError {
    #[error("crypto error: {0}")]
    Crypto(#[from] CryptoError),
    #[error("base64 payload is invalid")]
    InvalidBase64(#[from] base64::DecodeError),
    #[error("ratchet JSON is invalid")]
    Json(#[from] serde_json::Error),
    #[error("message key derivation failed")]
    KeyDeriveFailed,
    #[error("secretbox operation failed")]
    SecretboxFailed,
    #[error("message payload is too short")]
    PayloadTooShort,
    #[error("send chain is missing")]
    MissingSendChain,
    #[error("receive chain is missing")]
    MissingReceiveChain,
    #[error("peer ratchet key is missing")]
    MissingPeerRatchetKey,
    #[error("random bytes generation failed")]
    RandomFailed,
    #[error("message skipped too far ahead")]
    TooManySkippedMessages,
    #[error("plaintext is not valid UTF-8")]
    Utf8(#[from] std::string::FromUtf8Error),
}

impl From<crypto_secretbox::Error> for RatchetError {
    fn from(_: crypto_secretbox::Error) -> Self {
        Self::SecretboxFailed
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RatchetHeader {
    #[serde(rename = "ratchetPubKey")]
    pub ratchet_pub_key: String,
    pub n: u32,
    pub pn: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RatchetMessage {
    pub header: RatchetHeader,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct X3dhParams {
    #[serde(rename = "ephemeralPub")]
    pub ephemeral_public_key: String,
    #[serde(rename = "preKeyPubUsed")]
    pub pre_key_public_key: Option<String>,
    #[serde(rename = "pqcCiphertext", skip_serializing_if = "Option::is_none")]
    pub pqc_ciphertext: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RatchetPayload {
    pub header: RatchetHeader,
    pub ciphertext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x3dh: Option<X3dhParams>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub root_key: [u8; 32],
    pub send_chain_key: Option<[u8; 32]>,
    pub recv_chain_key: Option<[u8; 32]>,
    pub send_ratchet_public_key: String,
    pub send_ratchet_secret_key: String,
    pub recv_ratchet_public_key: Option<String>,
    pub send_chain_index: u32,
    pub recv_chain_index: u32,
    pub previous_send_chain_length: u32,
    pub skipped_keys: HashMap<String, [u8; 32]>,
}

impl Session {
    pub fn new_sender(
        _peer_public_key: String,
        shared_secret: [u8; 32],
        peer_pre_key_public_key: Option<String>,
    ) -> Result<Self, RatchetError> {
        let ratchet_key = crypto::generate_box_keypair()?;
        Ok(Self {
            root_key: shared_secret,
            send_chain_key: Some(shared_secret),
            recv_chain_key: None,
            send_ratchet_public_key: ratchet_key.public_key,
            send_ratchet_secret_key: ratchet_key.secret_key.expose().to_string(),
            recv_ratchet_public_key: peer_pre_key_public_key,
            send_chain_index: 0,
            recv_chain_index: 0,
            previous_send_chain_length: 0,
            skipped_keys: HashMap::new(),
        })
    }

    pub fn new_responder(
        _peer_public_key: String,
        shared_secret: [u8; 32],
        initial_peer_ratchet_public_key: String,
    ) -> Result<Self, RatchetError> {
        let ratchet_key = crypto::generate_box_keypair()?;
        Ok(Self {
            root_key: shared_secret,
            send_chain_key: None,
            recv_chain_key: Some(shared_secret),
            send_ratchet_public_key: ratchet_key.public_key,
            send_ratchet_secret_key: ratchet_key.secret_key.expose().to_string(),
            recv_ratchet_public_key: Some(initial_peer_ratchet_public_key),
            send_chain_index: 0,
            recv_chain_index: 0,
            previous_send_chain_length: 0,
            skipped_keys: HashMap::new(),
        })
    }
}

pub fn encrypt_initial_direct_payload_with_session(
    peer_public_key: &str,
    handshake: &X3dhInitiation,
    plaintext: &str,
) -> Result<(String, Session), RatchetError> {
    let mut session = Session::new_sender(
        peer_public_key.to_string(),
        handshake.shared_secret,
        handshake.pre_key_public_key.clone(),
    )?;
    let message = encrypt(&mut session, plaintext)?;
    let payload = RatchetPayload {
        header: message.header,
        ciphertext: message.ciphertext,
        x3dh: Some(X3dhParams {
            ephemeral_public_key: handshake.ephemeral_public_key.clone(),
            pre_key_public_key: handshake.pre_key_public_key.clone(),
            pqc_ciphertext: None,
        }),
    };
    Ok((serde_json::to_string(&payload)?, session))
}

pub fn encrypt_existing_direct_payload(
    session: &mut Session,
    plaintext: &str,
) -> Result<String, RatchetError> {
    let message = encrypt(session, plaintext)?;
    let payload = RatchetPayload {
        header: message.header,
        ciphertext: message.ciphertext,
        x3dh: None,
    };
    Ok(serde_json::to_string(&payload)?)
}

pub fn encrypt(session: &mut Session, plaintext: &str) -> Result<RatchetMessage, RatchetError> {
    ensure_send_chain(session)?;
    let send_chain_key = session
        .send_chain_key
        .ok_or(RatchetError::MissingSendChain)?;
    let (next_chain_key, message_key) = kdf_chain(&send_chain_key)?;
    session.send_chain_key = Some(next_chain_key);

    let header = RatchetHeader {
        ratchet_pub_key: session.send_ratchet_public_key.clone(),
        n: session.send_chain_index,
        pn: session.previous_send_chain_length,
    };
    session.send_chain_index += 1;

    let authenticated_plaintext = serde_json::json!({
        "v": 1,
        "header": header,
        "plaintext": plaintext,
    })
    .to_string();

    Ok(RatchetMessage {
        ciphertext: encrypt_secretbox(&message_key, authenticated_plaintext.as_bytes())?,
        header,
    })
}

pub fn decrypt(
    session: &mut Session,
    message: &RatchetMessage,
) -> Result<Option<String>, RatchetError> {
    let skipped_key_id = skipped_key_id(&message.header.ratchet_pub_key, message.header.n);
    if let Some(message_key) = session.skipped_keys.remove(&skipped_key_id) {
        return decrypt_with_message_key(&message.ciphertext, &message_key, &message.header);
    }

    let mut draft = session.clone();
    if draft.recv_ratchet_public_key.as_deref() != Some(&message.header.ratchet_pub_key) {
        if draft.recv_chain_key.is_some() {
            skip_message_keys(&mut draft, message.header.pn)?;
        }

        let dh_output = crypto::nacl_box_before(
            &message.header.ratchet_pub_key,
            &draft.send_ratchet_secret_key,
        )?;
        let (new_root_key, new_recv_chain_key) = kdf_root(&draft.root_key, &dh_output)?;
        draft.root_key = new_root_key;
        draft.recv_chain_key = Some(new_recv_chain_key);
        draft.recv_ratchet_public_key = Some(message.header.ratchet_pub_key.clone());
        draft.recv_chain_index = 0;

        let new_send_ratchet = crypto::generate_box_keypair()?;
        let send_dh_output = crypto::nacl_box_before(
            &message.header.ratchet_pub_key,
            new_send_ratchet.secret_key.expose(),
        )?;
        let (final_root_key, new_send_chain_key) = kdf_root(&draft.root_key, &send_dh_output)?;
        draft.root_key = final_root_key;
        draft.send_chain_key = Some(new_send_chain_key);
        draft.send_ratchet_public_key = new_send_ratchet.public_key;
        draft.send_ratchet_secret_key = new_send_ratchet.secret_key.expose().to_string();
        draft.previous_send_chain_length = draft.send_chain_index;
        draft.send_chain_index = 0;
    }

    skip_message_keys(&mut draft, message.header.n)?;
    let recv_chain_key = draft
        .recv_chain_key
        .ok_or(RatchetError::MissingReceiveChain)?;
    let (next_recv_chain_key, message_key) = kdf_chain(&recv_chain_key)?;
    draft.recv_chain_key = Some(next_recv_chain_key);
    draft.recv_chain_index += 1;

    let plaintext = decrypt_with_message_key(&message.ciphertext, &message_key, &message.header)?;
    if plaintext.is_some() {
        *session = draft;
    }
    Ok(plaintext)
}

fn ensure_send_chain(session: &mut Session) -> Result<(), RatchetError> {
    if session.send_chain_key.is_some() {
        return Ok(());
    }

    let peer_ratchet = session
        .recv_ratchet_public_key
        .clone()
        .ok_or(RatchetError::MissingPeerRatchetKey)?;
    let new_send_ratchet = crypto::generate_box_keypair()?;
    let dh_output = crypto::nacl_box_before(&peer_ratchet, new_send_ratchet.secret_key.expose())?;
    let (new_root_key, new_send_chain_key) = kdf_root(&session.root_key, &dh_output)?;
    session.root_key = new_root_key;
    session.send_chain_key = Some(new_send_chain_key);
    session.send_ratchet_public_key = new_send_ratchet.public_key;
    session.send_ratchet_secret_key = new_send_ratchet.secret_key.expose().to_string();
    session.previous_send_chain_length = session.send_chain_index;
    session.send_chain_index = 0;
    Ok(())
}

fn skip_message_keys(session: &mut Session, until: u32) -> Result<(), RatchetError> {
    if until < session.recv_chain_index {
        return Ok(());
    }
    if until - session.recv_chain_index > 50 {
        return Err(RatchetError::TooManySkippedMessages);
    }

    let Some(mut chain_key) = session.recv_chain_key else {
        return Err(RatchetError::MissingReceiveChain);
    };
    let ratchet_public_key = session
        .recv_ratchet_public_key
        .clone()
        .ok_or(RatchetError::MissingPeerRatchetKey)?;

    for index in session.recv_chain_index..until {
        let (next_chain_key, message_key) = kdf_chain(&chain_key)?;
        session
            .skipped_keys
            .insert(skipped_key_id(&ratchet_public_key, index), message_key);
        chain_key = next_chain_key;
    }

    session.recv_chain_key = Some(chain_key);
    session.recv_chain_index = until;
    Ok(())
}

fn skipped_key_id(ratchet_public_key: &str, n: u32) -> String {
    format!("{ratchet_public_key}:{n}")
}

fn kdf_root(
    root_key: &[u8; 32],
    dh_output: &[u8; 32],
) -> Result<([u8; 32], [u8; 32]), RatchetError> {
    let hkdf = Hkdf::<Sha256>::new(Some(root_key), dh_output);
    let mut out = [0u8; 64];
    hkdf.expand(b"RatchetRootKey", &mut out)
        .map_err(|_| RatchetError::KeyDeriveFailed)?;
    let mut new_root_key = [0u8; 32];
    let mut chain_key = [0u8; 32];
    new_root_key.copy_from_slice(&out[0..32]);
    chain_key.copy_from_slice(&out[32..64]);
    Ok((new_root_key, chain_key))
}

fn kdf_chain(chain_key: &[u8; 32]) -> Result<([u8; 32], [u8; 32]), RatchetError> {
    let message_key = hmac_sha256(chain_key, &[0x01])?;
    let next_chain_key = hmac_sha256(chain_key, &[0x02])?;
    Ok((next_chain_key, message_key))
}

fn hmac_sha256(key: &[u8; 32], data: &[u8]) -> Result<[u8; 32], RatchetError> {
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(key).map_err(|_| RatchetError::KeyDeriveFailed)?;
    mac.update(data);
    let bytes = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn encrypt_secretbox(message_key: &[u8; 32], plaintext: &[u8]) -> Result<String, RatchetError> {
    let cipher = XSalsa20Poly1305::new(message_key.into());
    let mut nonce_bytes = [0u8; 24];
    getrandom::fill(&mut nonce_bytes).map_err(|_| RatchetError::RandomFailed)?;
    let nonce: &Nonce = (&nonce_bytes).into();
    let ciphertext = cipher.encrypt(nonce, plaintext)?;

    let mut packed = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(&ciphertext);
    Ok(STANDARD.encode(packed))
}

fn decrypt_with_message_key(
    ciphertext: &str,
    message_key: &[u8; 32],
    expected_header: &RatchetHeader,
) -> Result<Option<String>, RatchetError> {
    let packed = STANDARD.decode(ciphertext)?;
    if packed.len() < 24 + 16 {
        return Err(RatchetError::PayloadTooShort);
    }

    let nonce: &Nonce = (&packed[..24])
        .try_into()
        .map_err(|_| RatchetError::PayloadTooShort)?;
    let cipher = XSalsa20Poly1305::new(message_key.into());
    let plaintext = match cipher.decrypt(nonce, &packed[24..]) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let decoded = String::from_utf8(plaintext)?;

    let envelope: serde_json::Value = match serde_json::from_str(&decoded) {
        Ok(value) => value,
        Err(_) => return Ok(Some(decoded)),
    };
    if envelope.get("v").and_then(|value| value.as_u64()) != Some(1) {
        return Ok(Some(decoded));
    }
    let Some(plaintext) = envelope.get("plaintext").and_then(|value| value.as_str()) else {
        return Ok(Some(decoded));
    };
    let Some(header_value) = envelope.get("header") else {
        return Ok(Some(decoded));
    };
    let header: RatchetHeader = serde_json::from_value(header_value.clone())?;
    if &header != expected_header {
        return Ok(None);
    }
    Ok(Some(plaintext.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_x3dh_ratchet_message_round_trips() {
        let alice = crypto::generate_box_keypair().unwrap();
        let bob = crypto::generate_box_keypair().unwrap();
        let bob_prekey = crypto::generate_box_keypair().unwrap();

        let initiated = crypto::x3dh_initiate(
            alice.secret_key.expose(),
            &bob.public_key,
            Some(&bob_prekey.public_key),
        )
        .unwrap();
        let responded = crypto::x3dh_respond(
            bob.secret_key.expose(),
            Some(bob_prekey.secret_key.expose()),
            &alice.public_key,
            &initiated.ephemeral_public_key,
        )
        .unwrap();

        let mut sender = Session::new_sender(
            bob.public_key.clone(),
            initiated.shared_secret,
            initiated.pre_key_public_key,
        )
        .unwrap();
        let message = encrypt(&mut sender, "hello from rust").unwrap();
        let mut receiver = Session::new_responder(
            alice.public_key,
            responded,
            message.header.ratchet_pub_key.clone(),
        )
        .unwrap();

        assert_eq!(
            decrypt(&mut receiver, &message).unwrap(),
            Some("hello from rust".to_string())
        );
    }

    #[test]
    fn initial_payload_serializes_like_web_client_shape() {
        let alice = crypto::generate_box_keypair().unwrap();
        let bob = crypto::generate_box_keypair().unwrap();
        let initiated =
            crypto::x3dh_initiate(alice.secret_key.expose(), &bob.public_key, None).unwrap();
        let (payload, _) =
            encrypt_initial_direct_payload_with_session(&bob.public_key, &initiated, "payload")
                .unwrap();
        let parsed: RatchetPayload = serde_json::from_str(&payload).unwrap();

        assert_eq!(
            parsed.x3dh.unwrap().ephemeral_public_key,
            initiated.ephemeral_public_key
        );
        assert_eq!(parsed.header.n, 0);
        assert_eq!(parsed.header.pn, 0);
    }
}
