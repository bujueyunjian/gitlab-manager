use serde::{Serialize, Serializer};

/// Keep the original cause in Rust, but never expose URLs, headers or tokens over IPC.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Validation(String),
    #[error("GitLab 返回 HTTP {status}：{message}")]
    Api { status: u16, message: String },
    #[error("无法完成网络请求，请检查网络与实例地址")]
    Network(#[from] reqwest::Error),
    #[error("GitLab 响应格式不符合接口契约")]
    Json(#[from] serde_json::Error),
    #[error("无法读写本地数据库")]
    Database(#[from] rusqlite::Error),
    #[error("无法读写应用数据目录")]
    Io(#[from] std::io::Error),
    #[error("无法打开离线手册，请检查安装文件与默认浏览器设置")]
    Manual(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("无法传递读取进度，请重新发起查询")]
    Progress(#[source] tauri::Error),
    #[error("无法访问系统凭据存储")]
    Credentials(#[from] keyring::Error),
    #[error("{0}")]
    State(String),
    #[error("保存失败，且系统凭据恢复失败，请重新配置此连接")]
    Rollback {
        #[source]
        original: Box<Error>,
        rollback: Box<Error>,
    },
}

impl Error {
    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::Api { status: 404, .. })
    }

    /// A server error or an interrupted response cannot prove a write did not happen.
    pub fn write_is_uncertain(&self) -> bool {
        match self {
            Self::Network(error) => !error.is_connect(),
            Self::Api { status, .. } => *status == 202 || *status >= 500,
            Self::Json(_) => true,
            _ => false,
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct PublicError {
            message: String,
            status: Option<u16>,
        }
        PublicError {
            message: self.to_string(),
            status: match self {
                Self::Api { status, .. } => Some(*status),
                _ => None,
            },
        }
        .serialize(serializer)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}
