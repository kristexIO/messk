use anyhow::{Result, anyhow};

#[cfg(windows)]
pub fn protect_secret(plaintext: &[u8]) -> Result<Vec<u8>> {
    use std::{ffi::c_void, ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData},
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    // DPAPI binds the ciphertext to the current Windows user profile.
    let ok = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(anyhow!("Windows DPAPI encryption failed"));
    }

    let protected =
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut c_void);
    }
    Ok(protected)
}

#[cfg(windows)]
pub fn unprotect_secret(ciphertext: &[u8]) -> Result<Vec<u8>> {
    use std::{ffi::c_void, ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    let ok = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(anyhow!("Windows DPAPI decryption failed"));
    }

    let plaintext =
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut c_void);
    }
    Ok(plaintext)
}

#[cfg(not(windows))]
pub fn protect_secret(plaintext: &[u8]) -> Result<Vec<u8>> {
    Ok(plaintext.to_vec())
}

#[cfg(not(windows))]
pub fn unprotect_secret(ciphertext: &[u8]) -> Result<Vec<u8>> {
    Ok(ciphertext.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protects_and_unprotects_secret() {
        let protected = protect_secret(b"seed phrase").unwrap();
        let opened = unprotect_secret(&protected).unwrap();
        assert_eq!(opened, b"seed phrase");
    }
}
