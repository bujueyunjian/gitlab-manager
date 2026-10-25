use std::{collections::HashSet, time::Duration};

use futures_util::{StreamExt, stream};
use reqwest::{
    Client, Method,
    header::{HeaderMap, HeaderValue},
    redirect::Policy,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use url::Url;

use crate::{
    error::{Error, Result, invalid},
    models::*,
};

/// Share the webhook-name capability boundary between inspection and write planning.
pub fn supports_webhook_names(version: &str) -> Result<bool> {
    let version = semver::Version::parse(version)
        .map_err(|_| invalid("GitLab 版本号格式无效，请重新检查连接"))?;
    Ok((version.major, version.minor) >= (17, 1))
}

/// Instance-scoped HTTP client; credentials remain in sensitive request headers.
#[derive(Clone)]
pub struct GitLab {
    client: Client,
    base: Url,
}

pub fn normalize_url(input: &str) -> Result<Url> {
    let mut url = Url::parse(input.trim()).map_err(|_| invalid("请输入完整的 GitLab 实例地址"))?;
    // Self-managed instances can explicitly use HTTP; keep the protocol chosen by the user.
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid("实例地址必须使用 HTTP 或 HTTPS"));
    }
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid("实例地址不能包含账号、密码、查询参数或片段"));
    }
    if url.path().trim_end_matches('/').ends_with("/api/v4") {
        return Err(invalid("请填写 GitLab 网页的实例根地址，不要包含 /api/v4"));
    }
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

/// Validate receiver addresses for both exact presence checks and webhook changes.
pub fn validate_webhook_url(value: &str) -> Result<()> {
    let url = Url::parse(value).map_err(|_| invalid("Webhook 地址无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "Webhook 地址必须为 HTTP / HTTPS，不能包含账号密码或片段",
        ));
    }
    Ok(())
}

impl GitLab {
    /// Build an authenticated client that validates certificates and never follows redirects.
    pub fn new(base_url: &str, token: String) -> Result<Self> {
        if token.trim().is_empty() {
            return Err(invalid("请输入访问令牌"));
        }
        let mut headers = HeaderMap::new();
        let mut value =
            HeaderValue::from_str(&token).map_err(|_| invalid("访问令牌包含无效字符"))?;
        value.set_sensitive(true);
        headers.insert("PRIVATE-TOKEN", value);
        let client = Client::builder()
            .default_headers(headers)
            .redirect(Policy::none()) // Never forward a credential to a redirected origin.
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("GitLab-Manager/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            client,
            base: normalize_url(base_url)?,
        })
    }

    pub fn api_url(&self, path: &str) -> Result<Url> {
        self.base
            .join(&format!("api/v4/{path}"))
            .map_err(|_| invalid("无法构建 GitLab API 地址"))
    }

    /// Return only status-derived public errors without reading upstream failure response bodies.
    async fn send(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
    ) -> Result<reqwest::Response> {
        // 1. Keep authenticated requests inside the configured instance, including pagination.
        if url.origin() != self.base.origin()
            || !url
                .path()
                .starts_with(&format!("{}api/v4/", self.base.path()))
        {
            return Err(invalid("GitLab 返回了实例范围之外的分页地址"));
        }
        // 2. Send the requested operation and preserve successful responses for their typed readers.
        let request = self.client.request(method.clone(), url);
        let response = match body {
            Some(body) => request.json(body),
            None => request,
        }
        .send()
        .await?;
        if response.status().is_success() {
            return Ok(response);
        }
        // 3. Error bodies may reflect encoded credentials; public messages use trusted metadata only.
        let status = response.status().as_u16();
        let reason = match status {
            300..=399 => "实例地址发生重定向，请检查连接配置",
            400 => "请求参数无效，请核对配置",
            401 => "身份验证失败，请检查访问令牌",
            403 => "权限不足，请检查令牌范围和项目权限",
            404 => "接口或资源不存在，或当前账号无权访问",
            405 => "接口不支持此操作",
            409 => "资源状态冲突，请重新预览",
            422 => "配置未通过服务端校验，请核对输入",
            429 => "请求频率受限，请稍后手动重试",
            500..=599 => "GitLab 服务端发生错误",
            _ => "GitLab 未能完成请求",
        };
        let message = format!("{} 请求失败：{reason}", method.as_str());
        Err(Error::Api { status, message })
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let response = self.send(Method::GET, self.api_url(path)?, None).await?;
        Ok(serde_json::from_str(&response.text().await?)?)
    }

    /// Validate API access using the server version; unavailable legacy metadata stays unknown.
    pub async fn token_info(&self, version: &str) -> Result<Option<TokenInfo>> {
        // 1. Select the documented token endpoint capability from the reported version.
        let version = semver::Version::parse(version)
            .map_err(|_| invalid("GitLab 返回的版本号格式无效，无法确认接口支持情况"))?;
        if (version.major, version.minor) < (15, 5) {
            // /user and /version also accept read_user, which is insufficient for repository APIs.
            self.get::<Vec<Project>>("projects?membership=true&per_page=1")
                .await?;
            return Ok(None);
        }

        // 2. Keep all modern endpoint failures visible instead of assuming legacy support.
        let token: TokenInfo = self.get("personal_access_tokens/self").await?;
        if !token
            .scopes
            .iter()
            .any(|scope| scope == "api" || scope == "read_api")
        {
            return Err(invalid("访问令牌需要 api 或 read_api 范围"));
        }
        Ok(Some(token))
    }

    pub async fn write(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let response = self.send(method, self.api_url(path)?, body).await?;
        if response.status().as_u16() == 202 {
            return Err(Error::Api {
                status: 202,
                message: "请求已受理，尚未确认执行完成".into(),
            });
        }
        if response.status().as_u16() == 204 {
            return Ok(Value::Null);
        }
        let body = response.text().await?;
        if body.trim().is_empty() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_str(&body)?)
    }

    pub async fn list<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Vec<T>> {
        let mut url = self.api_url(path)?;
        url.query_pairs_mut()
            .append_pair("per_page", "100")
            .extend_pairs(query.iter().map(|(k, v)| (*k, v)));
        let mut visited = HashSet::new();
        let mut records = Vec::new();
        loop {
            if !visited.insert(url.as_str().to_owned()) {
                return Err(invalid("GitLab 分页出现循环，读取已停止"));
            }
            let response = self.send(Method::GET, url.clone(), None).await?;
            let next = response
                .headers()
                .get("link")
                .map(|h| h.to_str().map_err(|_| invalid("GitLab 分页响应头无效")))
                .transpose()?
                .and_then(next_link)
                .map(str::to_owned);
            if next.is_none()
                && response
                    .headers()
                    .get("x-next-page")
                    .is_some_and(|h| !h.is_empty())
            {
                return Err(invalid("GitLab 分页信息不完整，无法确认已读取全部记录"));
            }
            let page: Vec<T> = serde_json::from_str(&response.text().await?)?;
            records.extend(page);
            match next {
                Some(next) => {
                    url = url
                        .join(&next)
                        .map_err(|_| invalid("GitLab 分页地址无效"))?
                }
                None => break,
            }
        }
        Ok(records)
    }

    /// Read all matching pages and filter by the same effective role shown in the repository list.
    pub async fn projects(&self, filter: &ProjectFilter) -> Result<Vec<Project>> {
        // 1. Use GitLab's minimum level to narrow candidates while retaining search and archive filters.
        let mut query = vec![
            ("membership", "true".into()),
            ("order_by", "path".into()),
            ("sort", "asc".into()),
        ];
        if !filter.search.trim().is_empty() {
            query.push(("search", filter.search.trim().into()));
        }
        if let Some(value) = filter.archived {
            query.push(("archived", value.to_string()));
        }
        if let Some(value) = filter.access_level {
            query.push(("min_access_level", value.to_string()));
        }

        // 2. Complete pagination before filtering, so counts and display pages contain every match.
        let mut projects: Vec<Project> = self.list("projects", &query).await?;

        // 3. Direct and inherited group permissions contribute their highest level; missing levels stay unknown.
        if let Some(level) = filter.access_level {
            projects.retain(|project| {
                project.permissions.as_ref().and_then(|permissions| {
                    [
                        permissions.project_access.as_ref(),
                        permissions.group_access.as_ref(),
                    ]
                    .into_iter()
                    .flatten()
                    .map(|access| access.access_level)
                    .max()
                }) == Some(level)
            });
        }
        Ok(projects)
    }

    pub async fn project(&self, id: u64) -> Result<Project> {
        self.get(&format!("projects/{id}")).await
    }

    pub async fn hooks(&self, id: u64) -> Result<Vec<Hook>> {
        self.list(&format!("projects/{id}/hooks"), &[]).await
    }

    /// Return exact URL or name matches with four project reads in flight and stable ordering.
    pub async fn check_webhooks(
        &self,
        project_ids: Vec<u64>,
        query: &WebhookQuery,
    ) -> Result<Vec<ProjectWebhookCheck>> {
        // 1. Validate the inspection scope; receiver URLs are compared, never requested.
        let value = query.value.trim();
        match query.field {
            WebhookMatchField::Url => validate_webhook_url(value)?,
            WebhookMatchField::Name if value.is_empty() => {
                return Err(invalid("请输入 Webhook 名称"));
            }
            WebhookMatchField::Name => {}
        }
        if project_ids.is_empty() {
            return Err(invalid("请选择要检查的仓库"));
        }
        let mut seen = HashSet::new();
        let ids: Vec<_> = project_ids
            .into_iter()
            .filter(|id| seen.insert(*id))
            .collect();

        // 2. Read every hook page per project, preserving failures separately from missing URLs.
        let mut checked = stream::iter(ids.into_iter().enumerate())
            .map(|(index, project_id)| async move {
                let result = match self.hooks(project_id).await {
                    Ok(hooks) => {
                        let hooks: Vec<_> = hooks
                            .into_iter()
                            .filter(|hook| match query.field {
                                WebhookMatchField::Url => hook.url == value,
                                WebhookMatchField::Name => hook.name.as_deref() == Some(value),
                            })
                            .collect();
                        let count = hooks.len();
                        if count == 0 {
                            WebhookPresence::Missing
                        } else {
                            WebhookPresence::Present { count, hooks }
                        }
                    }
                    Err(error) => WebhookPresence::Error {
                        message: error.to_string(),
                    },
                };
                (index, ProjectWebhookCheck { project_id, result })
            })
            .buffer_unordered(4)
            .collect::<Vec<_>>()
            .await;

        // 3. Return one outcome per unique project in the caller's original order.
        checked.sort_unstable_by_key(|(index, _)| *index);
        Ok(checked.into_iter().map(|(_, result)| result).collect())
    }

    pub async fn members(&self, id: u64, inherited: bool) -> Result<Vec<Member>> {
        let suffix = if inherited { "/all" } else { "" };
        self.list(&format!("projects/{id}/members{suffix}"), &[])
            .await
    }

    pub async fn shares(&self, id: u64) -> Result<Vec<Share>> {
        Ok(self
            .get::<ProjectShares>(&format!("projects/{id}"))
            .await?
            .shared_with_groups)
    }

    /// Resolve a repository reference without applying the repository-list role filter.
    pub async fn resolve(&self, input: &str) -> Result<Vec<Project>> {
        match project_reference(&self.base, input)? {
            ProjectReference::Path(path) => {
                let encoded: String =
                    url::form_urlencoded::byte_serialize(path.as_bytes()).collect();
                Ok(vec![self.get(&format!("projects/{encoded}")).await?])
            }
            ProjectReference::Name(name) => {
                let projects = self
                    .projects(&ProjectFilter {
                        search: name.clone(),
                        archived: None,
                        access_level: None,
                    })
                    .await?;
                // Exact name/path matching avoids silently authorizing a similarly named application.
                Ok(projects
                    .into_iter()
                    .filter(|p| p.name == name || p.path == name)
                    .collect())
            }
        }
    }
}

fn next_link(header: &str) -> Option<&str> {
    header.split(',').find_map(|part| {
        let mut parts = part.trim().split(';');
        let link = parts.next()?.trim();
        parts
            .any(|p| p.trim() == "rel=\"next\"")
            .then(|| link.strip_prefix('<')?.strip_suffix('>'))
            .flatten()
    })
}

#[derive(Debug, PartialEq)]
pub enum ProjectReference {
    Path(String),
    Name(String),
}

/// Accept clone/web addresses and namespace paths without guessing a project from its name.
pub fn project_reference(base: &Url, input: &str) -> Result<ProjectReference> {
    let input = input.trim();
    if input.is_empty() {
        return Err(invalid("仓库地址或应用名不能为空"));
    }
    let path = if let Some(rest) = input.strip_prefix("git@") {
        let (host, path) = rest
            .split_once(':')
            .ok_or_else(|| invalid("SSH 仓库地址格式不正确"))?;
        if Some(host) != base.host_str() {
            return Err(invalid("仓库不属于当前 GitLab 实例"));
        }
        path.to_owned()
    } else if input.contains("://") {
        let url = Url::parse(input).map_err(|_| invalid("仓库地址无效"))?;
        if url.host_str() != base.host_str() || !["https", "http", "ssh"].contains(&url.scheme()) {
            return Err(invalid("仓库不属于当前 GitLab 实例"));
        }
        if url.query().is_some() || url.fragment().is_some() || url.password().is_some() {
            return Err(invalid("仓库地址不能包含密码、查询参数或片段"));
        }
        if url.scheme() != "ssh" && url.origin() != base.origin() {
            return Err(invalid("仓库地址与当前实例的协议或端口不一致"));
        }
        let prefix = if url.scheme() == "ssh" {
            "/"
        } else {
            base.path()
        };
        url.path()
            .strip_prefix(prefix)
            .ok_or_else(|| invalid("仓库地址不属于当前实例路径"))?
            .to_owned()
    } else if input.contains('/') {
        input.trim_matches('/').to_owned()
    } else {
        return Ok(ProjectReference::Name(input.to_owned()));
    };
    let decoded = percent_encoding::percent_decode_str(&path)
        .decode_utf8()
        .map_err(|_| invalid("仓库路径编码无效"))?;
    let path = decoded
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or(decoded.trim_end_matches('/'));
    if !path.contains('/')
        || path.contains("/-/")
        || path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(invalid(
            "请填写仓库主页或克隆地址，不要使用分支、文件或设置页面地址",
        ));
    }
    if path.contains(['?', '#', '&', '\\']) {
        return Err(invalid("仓库路径包含无效字符"));
    }
    Ok(ProjectReference::Path(path.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_repository_links_and_keeps_names_ambiguous() {
        let base = normalize_url("https://gitlab.example.com").unwrap();
        for input in [
            "https://gitlab.example.com/team/app.git",
            "git@gitlab.example.com:team/app.git",
            "team/app",
        ] {
            assert_eq!(
                project_reference(&base, input).unwrap(),
                ProjectReference::Path("team/app".into())
            );
        }
        assert_eq!(
            project_reference(&base, "app").unwrap(),
            ProjectReference::Name("app".into())
        );
        assert!(project_reference(&base, "https://other.example.com/team/app").is_err());
        assert!(
            project_reference(&base, "https://gitlab.example.com/team/app/-/tree/main").is_err()
        );
    }

    #[test]
    fn supports_self_managed_relative_url_roots() {
        for scheme in ["http", "https"] {
            let address = format!("{scheme}://gitlab.example.com:8080/gitlab");
            let base = normalize_url(&address).unwrap();
            assert_eq!(base.as_str(), format!("{address}/"));
            assert_eq!(
                project_reference(&base, &format!("{address}/team/app")).unwrap(),
                ProjectReference::Path("team/app".into())
            );
            let client = GitLab::new(&address, "fictional-access-token".into()).unwrap();
            assert_eq!(
                client.api_url("user").unwrap().as_str(),
                format!("{address}/api/v4/user")
            );
        }
    }

    #[test]
    fn rejects_unsafe_instance_urls() {
        let mut credential_url = Url::parse("https://gitlab.example.com").unwrap();
        credential_url.set_username("example-user").unwrap();
        credential_url
            .set_password(Some("invalid-placeholder"))
            .unwrap();
        assert!(normalize_url(credential_url.as_str()).is_err());
        for input in [
            "ftp://gitlab.example.com",
            "file:///gitlab",
            "http://gitlab.example.com?token=fictional-access-token",
            "http://gitlab.example.com#fragment",
            "http://gitlab.example.com/gitlab/api/v4",
        ] {
            assert!(normalize_url(input).is_err(), "accepted {input}");
        }
    }

    #[test]
    fn follows_only_the_explicit_next_link() {
        assert_eq!(
            next_link(
                "<https://gitlab.example.com/api/v4/projects?page=2>; rel=\"next\", <https://gitlab.example.com/api/v4/projects?page=9>; rel=\"last\""
            ),
            Some("https://gitlab.example.com/api/v4/projects?page=2")
        );
        assert_eq!(
            next_link("<https://gitlab.example.com/api/v4/projects?page=1>; rel=\"prev\""),
            None
        );
    }
}
