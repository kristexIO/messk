use serde::{Deserialize, Serialize};

pub const USERNAME_MIN_LEN: usize = 5;
pub const USERNAME_MAX_LEN: usize = 32;
pub const NICKNAME_MAX_LEN: usize = 64;
pub const AVATAR_MAX_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserProfile {
    pub nickname: String,
    pub username: Option<String>,
    pub avatar: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileValidationError {
    NicknameTooLong,
    UsernameTooShort,
    UsernameTooLong,
    UsernameInvalidCharacter,
    AvatarTooLarge,
}

impl UserProfile {
    pub fn new(
        nickname: &str,
        username: Option<&str>,
        avatar: &str,
    ) -> Result<Self, ProfileValidationError> {
        let nickname = sanitize_nickname(nickname)?;
        let username = sanitize_username(username)?;
        validate_avatar(avatar)?;
        Ok(Self {
            nickname,
            username,
            avatar: avatar.trim().to_string(),
        })
    }
}

pub fn sanitize_nickname(value: &str) -> Result<String, ProfileValidationError> {
    let nickname = value.trim();
    if nickname.chars().count() > NICKNAME_MAX_LEN {
        return Err(ProfileValidationError::NicknameTooLong);
    }
    Ok(nickname.to_string())
}

pub fn sanitize_username(value: Option<&str>) -> Result<Option<String>, ProfileValidationError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let username = value.trim().trim_start_matches('@');
    if username.is_empty() {
        return Ok(None);
    }
    let len = username.chars().count();
    if len < USERNAME_MIN_LEN {
        return Err(ProfileValidationError::UsernameTooShort);
    }
    if len > USERNAME_MAX_LEN {
        return Err(ProfileValidationError::UsernameTooLong);
    }
    if !username
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return Err(ProfileValidationError::UsernameInvalidCharacter);
    }
    Ok(Some(username.to_ascii_lowercase()))
}

pub fn validate_avatar(value: &str) -> Result<(), ProfileValidationError> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(());
    }
    if value.len() > AVATAR_MAX_BYTES {
        return Err(ProfileValidationError::AvatarTooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_accepts_web_compatible_username() {
        let profile = UserProfile::new(" Alice ", Some("@Alice_01"), "").unwrap();
        assert_eq!(profile.nickname, "Alice");
        assert_eq!(profile.username.as_deref(), Some("alice_01"));
    }

    #[test]
    fn profile_rejects_short_or_invalid_usernames() {
        assert_eq!(
            UserProfile::new("A", Some("abc"), "").unwrap_err(),
            ProfileValidationError::UsernameTooShort
        );
        assert_eq!(
            UserProfile::new("A", Some("alice-01"), "").unwrap_err(),
            ProfileValidationError::UsernameInvalidCharacter
        );
    }
}
