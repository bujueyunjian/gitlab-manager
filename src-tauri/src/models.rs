use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub revision: String,
    pub user: User,
    pub scopes: Vec<String>,
    pub expires_at: Option<String>,
    pub version: String,
    pub checked_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub id: Option<String>,
    pub name: String,
    pub base_url: String,
    pub token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct User {
    pub id: u64,
    pub username: String,
    pub name: String,
    pub is_admin: Option<bool>,
}

#[derive(Deserialize)]
pub struct TokenInfo {
    pub scopes: Vec<String>,
    pub expires_at: Option<String>,
}

#[derive(Deserialize)]
pub struct Version {
    pub version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Access {
    pub access_level: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Permissions {
    pub project_access: Option<Access>,
    pub group_access: Option<Access>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub path_with_namespace: String,
    pub description: Option<String>,
    pub web_url: String,
    pub archived: bool,
    pub visibility: String,
    pub permissions: Option<Permissions>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Hook {
    pub id: u64,
    pub name: Option<String>,
    pub url: String,
    pub push_events: bool,
    pub merge_requests_events: bool,
    pub pipeline_events: bool,
    pub issues_events: bool,
    pub tag_push_events: bool,
    pub enable_ssl_verification: bool,
    // GitLab added these fields in 19.0. Missing means unknown, not “no secret”.
    pub token_present: Option<bool>,
    pub signing_token_present: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Member {
    pub id: u64,
    pub name: String,
    pub username: String,
    pub access_level: u32,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Group {
    pub id: u64,
    pub name: String,
    pub full_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Share {
    pub group_id: u64,
    pub group_name: String,
    pub group_full_path: String,
    pub group_access_level: u32,
    pub expires_at: Option<String>,
}

#[derive(Deserialize)]
pub struct ProjectShares {
    pub shared_with_groups: Vec<Share>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectResources {
    pub project: Project,
    pub hooks: ReadResult<Vec<Hook>>,
    pub members: ReadResult<MemberList>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ReadResult<T> {
    Ready { data: T },
    Error { message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberList {
    pub direct: Vec<Member>,
    pub all: Vec<Member>,
    pub shares: Vec<Share>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFilter {
    pub search: String,
    pub archived: Option<bool>,
    pub min_access_level: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub input: String,
    pub candidates: Vec<Project>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Resource {
    Hook,
    Member,
    Share,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Create,
    Update,
    Delete,
    Skip,
    Conflict,
    Blocked,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Unknown,
    Skipped,
    Blocked,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub field: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookChoice {
    pub id: u64,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    pub project_id: u64,
    pub project_path: String,
    pub resource: Resource,
    pub target_id: Option<u64>,
    pub subject: Option<String>,
    pub action: Action,
    pub status: ItemStatus,
    pub message: String,
    pub before: Option<Value>,
    // Only public API fields belong here. Authentication is held separately in memory.
    pub body: Value,
    pub changes: Vec<Change>,
    pub candidates: Vec<HookChoice>,
    pub secret_required: bool,
    pub attempts: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub connection_id: String,
    pub connection_revision: String,
    pub title: String,
    pub items: Vec<PlanItem>,
    pub created_at: String,
}

/// The secret is deliberately outside the serializable plan and task models.
pub struct PreparedPlan {
    pub plan: Plan,
    pub secret: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub connection_id: String,
    pub connection_revision: String,
    pub connection_name: String,
    pub title: String,
    pub status: String,
    pub items: Vec<PlanItem>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookTarget {
    pub project_id: u64,
    pub hook_id: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRequest {
    pub connection_id: String,
    pub project_ids: Vec<u64>,
    pub targets: Vec<HookTarget>,
    pub mode: String,
    pub match_url: String,
    pub name: Option<String>,
    pub url: Option<String>,
    pub events: Option<HookEvents>,
    pub ssl: Option<bool>,
    pub secret: Option<String>,
    pub choices: std::collections::HashMap<u64, u64>,
    pub creation: Option<HookDefaults>,
}

#[derive(Clone, Deserialize)]
pub struct HookDefaults {
    pub name: String,
    pub events: HookEvents,
    pub ssl: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookEvents {
    pub push_events: bool,
    pub merge_requests_events: bool,
    pub pipeline_events: bool,
    pub issues_events: bool,
    pub tag_push_events: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberTarget {
    pub project_id: u64,
    pub user_id: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub connection_id: String,
    pub project_ids: Vec<u64>,
    pub subject_ids: Vec<u64>,
    pub targets: Vec<MemberTarget>,
    pub subject_type: String,
    pub mode: String,
    pub access_level: Option<u32>,
    pub update_expiry: bool,
    pub expires_at: Option<String>,
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
