//! Small secret store for the device token, registration secret and pairing record.
//!
//! Windows: Credential Manager through the `keyring` crate (DPAPI-protected, per Windows user).
//! Other platforms (development only): files in the per-user data directory with mode 0600.

const SERVICE: &str = "LIKApcs-Client";

fn valid_name(name: &str) -> Result<(), String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid secret name".into());
    }
    Ok(())
}

#[cfg(windows)]
pub fn get(name: &str) -> Result<Option<String>, String> {
    valid_name(name)?;
    let entry = keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(windows)]
pub fn set(name: &str, value: &str) -> Result<(), String> {
    valid_name(name)?;
    let entry = keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn delete(name: &str) -> Result<(), String> {
    valid_name(name)?;
    let entry = keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(windows))]
fn secrets_dir() -> std::path::PathBuf {
    let base = std::env::var("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
                .join(".local")
                .join("share")
        });
    base.join("likapcs-client").join("secrets")
}

#[cfg(not(windows))]
pub fn get(name: &str) -> Result<Option<String>, String> {
    valid_name(name)?;
    match std::fs::read_to_string(secrets_dir().join(name)) {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(windows))]
pub fn set(name: &str, value: &str) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    valid_name(name)?;
    let dir = secrets_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    let path = dir.join(name);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    file.write_all(value.as_bytes()).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub fn delete(name: &str) -> Result<(), String> {
    valid_name(name)?;
    match std::fs::remove_file(secrets_dir().join(name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
