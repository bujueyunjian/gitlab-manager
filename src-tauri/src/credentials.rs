use crate::error::{Error, Result};

// Keep persisted service names stable across product renames. Development stays isolated.
#[cfg(debug_assertions)]
const SERVICE: &str = "io.gitlabworkbench.desktop.development";
#[cfg(not(debug_assertions))]
const SERVICE: &str = "io.gitlabworkbench.desktop";

/// Tests use an in-memory implementation so they never touch a developer's keychain.
pub trait Credentials: Send + Sync {
    fn get(&self, id: &str) -> Result<String>;
    fn set(&self, id: &str, value: &str) -> Result<()>;
    fn delete(&self, id: &str) -> Result<()>;
}

pub struct SystemCredentials;

impl Credentials for SystemCredentials {
    fn get(&self, id: &str) -> Result<String> {
        keyring::Entry::new(SERVICE, id)?
            .get_password()
            .map_err(Error::from)
    }

    fn set(&self, id: &str, value: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, id)?.set_password(value)?;
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, id)?.delete_credential()?;
        Ok(())
    }
}
