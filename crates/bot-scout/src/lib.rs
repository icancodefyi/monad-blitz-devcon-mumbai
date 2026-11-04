//! Read-only, citation-first research agent.

use std::{collections::HashSet, net::IpAddr, time::Duration};

use async_trait::async_trait;
use donads_core::{Bot, BotDescriptor, BotError, BotResult, Task};
use reqwest::{Client, Url, header::CONTENT_TYPE, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::json;

const MAX_SOURCES: usize = 5;
const MAX_SOURCE_BYTES: usize = 1_000_000;
const MAX_FINDINGS: usize = 6;
const AGENT_VERSION: &str = "scout-extractive-v1";

/// Scout researches user-supplied public URLs without publishing or taking action.
pub struct Scout;

#[derive(Debug, Deserialize)]
struct ScoutInput {
    sources: Vec<String>,
}

#[derive(Debug, Serialize)]
struct SourceRecord {
    id: usize,
    title: String,
    url: String,
    status: &'static str,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct Finding {
    text: String,
    citations: Vec<usize>,
}

struct FetchedSource {
    record: SourceRecord,
    text: String,
}

impl Default for Scout {
    fn default() -> Self {
        Self::new().expect("Scout's static HTTP configuration must be valid")
    }
}

impl Scout {
    /// Builds the bounded HTTP client used for public, read-only research.
    ///
    /// # Errors
    ///
    /// Returns an error if the static HTTP client configuration cannot be built.
    pub fn new() -> Result<Self, reqwest::Error> {
        build_http_client(None).map(|_| Self)
    }

    async fn fetch_source(&self, id: usize, raw_url: &str) -> FetchedSource {
        let url = match validate_public_url(raw_url) {
            Ok(url) => url,
            Err(error) => return failed_source(id, raw_url, error),
        };
        let client = match client_for_url(&url).await {
            Ok(client) => client,
            Err(error) => return failed_source(id, raw_url, error),
        };
        let response = match client.get(url.clone()).send().await {
            Ok(response) => response,
            Err(error) => return failed_source(id, raw_url, format!("request failed: {error}")),
        };
        if response.status().is_redirection() {
            return failed_source(id, raw_url, "redirects are not followed for safety".into());
        }
        if !response.status().is_success() {
            return failed_source(
                id,
                raw_url,
                format!("source returned HTTP {}", response.status()),
            );
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !content_type.starts_with("text/html") && !content_type.starts_with("text/plain") {
            return failed_source(id, raw_url, "source is not HTML or plain text".into());
        }
        let bytes = match response.bytes().await {
            Ok(bytes) if bytes.len() <= MAX_SOURCE_BYTES => bytes,
            Ok(_) => return failed_source(id, raw_url, "source exceeds the 1 MB limit".into()),
            Err(error) => {
                return failed_source(id, raw_url, format!("could not read source: {error}"));
            }
        };
        let raw = String::from_utf8_lossy(&bytes);
        let title = extract_title(&raw)
            .unwrap_or_else(|| url.host_str().unwrap_or("Untitled source").to_owned());
        let text = if content_type.starts_with("text/html") {
            html_to_text(&raw)
        } else {
            normalize_whitespace(&raw)
        };
        if text.len() < 40 {
            return failed_source(
                id,
                raw_url,
                "source did not contain enough readable text".into(),
            );
        }
        FetchedSource {
            record: SourceRecord {
                id,
                title,
                url: url.to_string(),
                status: "fetched",
                error: None,
            },
            text,
        }
    }
}

fn build_http_client(
    resolution: Option<(&str, std::net::SocketAddr)>,
) -> Result<Client, reqwest::Error> {
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .redirect(Policy::none())
        .no_proxy()
        .user_agent("DONADS-Scout/0.1 (+read-only research)");
    if let Some((host, address)) = resolution {
        builder = builder.resolve(host, address);
    }
    builder.build()
}

async fn client_for_url(url: &Url) -> Result<Client, String> {
    let host = url.host_str().ok_or_else(|| "URL has no host".to_owned())?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            return Err("private network sources are not allowed".into());
        }
        return build_http_client(None)
            .map_err(|error| format!("could not prepare source request: {error}"));
    }

    let port = url
        .port_or_known_default()
        .ok_or_else(|| "URL uses an unsupported port".to_owned())?;
    let addresses: Vec<_> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("could not resolve source host: {error}"))?
        .collect();
    if addresses.is_empty() {
        return Err("source host did not resolve to an address".into());
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("source host resolves to a private or reserved network".into());
    }
    build_http_client(Some((host, addresses[0])))
        .map_err(|error| format!("could not prepare source request: {error}"))
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.is_documentation()
                || octets[0] == 0
                || octets[0] >= 240
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99))
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
                || ip.segments()[0..2] == [0x2001, 0x0db8])
        }
    }
}

#[async_trait]
impl Bot for Scout {
    fn descriptor(&self) -> BotDescriptor {
        BotDescriptor {
            id: "scout",
            name: "Scout",
            specialty: "Source-linked research and monitoring",
            available: true,
        }
    }

    async fn execute(&self, task: &Task) -> Result<BotResult, BotError> {
        let input: ScoutInput = serde_json::from_value(task.input.clone()).map_err(|_| {
            BotError::InvalidInput("input.sources must be an array of public URLs".into())
        })?;
        if input.sources.is_empty() {
            return Err(BotError::InvalidInput(
                "provide at least one source URL".into(),
            ));
        }
        if input.sources.len() > MAX_SOURCES {
            return Err(BotError::InvalidInput(format!(
                "Scout accepts at most {MAX_SOURCES} sources per task"
            )));
        }

        let mut sources = Vec::with_capacity(input.sources.len());
        for (index, url) in input.sources.iter().enumerate() {
            sources.push(self.fetch_source(index + 1, url).await);
        }
        let successful: Vec<_> = sources
            .iter()
            .filter(|source| source.record.status == "fetched")
            .collect();
        if successful.is_empty() {
            let details = sources
                .iter()
                .filter_map(|source| source.record.error.as_deref())
                .collect::<Vec<_>>()
                .join("; ");
            return Err(BotError::Analysis(format!(
                "no sources could be researched: {details}"
            )));
        }

        let findings = select_findings(&task.prompt, &successful);
        let failed_count = sources.len() - successful.len();
        let summary = format!(
            "Scout reviewed {} source(s) and produced {} cited finding(s){}.",
            successful.len(),
            findings.len(),
            if failed_count == 0 {
                String::new()
            } else {
                format!("; {failed_count} source(s) failed")
            }
        );
        let source_records: Vec<_> = sources.into_iter().map(|source| source.record).collect();

        Ok(BotResult {
            summary,
            data: json!({
                "report": {
                    "title": report_title(&task.prompt),
                    "findings": findings,
                    "sources": source_records,
                    "limitations": "Scout summarizes supplied public pages. Verify citations before acting; inaccessible and dynamic content may be incomplete."
                },
                "agent_version": AGENT_VERSION,
                "read_only": true
            }),
        })
    }
}

fn validate_public_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "invalid URL".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only HTTP and HTTPS sources are allowed".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs containing credentials are not allowed".into());
    }
    let host = url.host_str().ok_or_else(|| "URL has no host".to_owned())?;
    let lowercase_host = host.to_ascii_lowercase();
    let has_local_suffix = lowercase_host
        .rsplit_once('.')
        .is_some_and(|(_, suffix)| suffix == "local");
    if lowercase_host == "localhost" || has_local_suffix {
        return Err("local network sources are not allowed".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        let blocked = match ip {
            IpAddr::V4(ip) => {
                ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
            }
            IpAddr::V6(ip) => ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local(),
        };
        if blocked {
            return Err("private network sources are not allowed".into());
        }
    }
    Ok(url)
}

fn failed_source(id: usize, url: &str, error: String) -> FetchedSource {
    FetchedSource {
        record: SourceRecord {
            id,
            title: "Unavailable source".into(),
            url: url.into(),
            status: "failed",
            error: Some(error),
        },
        text: String::new(),
    }
}

fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let content_start = lower[start..].find('>')? + start + 1;
    let end = lower[content_start..].find("</title>")? + content_start;
    let title = normalize_whitespace(&html[content_start..end]);
    (!title.is_empty()).then_some(title)
}

fn html_to_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for character in html.chars() {
        match character {
            '<' => {
                in_tag = true;
                text.push(' ');
            }
            '>' => in_tag = false,
            _ if !in_tag => text.push(character),
            _ => {}
        }
    }
    normalize_whitespace(
        &text
            .replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'"),
    )
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn select_findings(prompt: &str, sources: &[&FetchedSource]) -> Vec<Finding> {
    let query_terms: HashSet<_> = prompt
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| term.len() >= 4)
        .map(str::to_ascii_lowercase)
        .collect();
    let mut candidates = Vec::new();
    for source in sources {
        for sentence in source.text.split(['.', '!', '?']) {
            let sentence = normalize_whitespace(sentence);
            if !(50..=360).contains(&sentence.len()) {
                continue;
            }
            let lower = sentence.to_ascii_lowercase();
            let relevance = query_terms
                .iter()
                .filter(|term| lower.contains(term.as_str()))
                .count();
            candidates.push((relevance, source.record.id, sentence));
        }
    }
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|(_, _, text)| seen.insert(text.to_ascii_lowercase()))
        .take(MAX_FINDINGS)
        .map(|(_, source_id, text)| Finding {
            text,
            citations: vec![source_id],
        })
        .collect()
}

fn report_title(prompt: &str) -> String {
    let prompt = normalize_whitespace(prompt);
    let shortened: String = prompt.chars().take(96).collect();
    if shortened.is_empty() {
        "Scout research report".into()
    } else {
        shortened
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use super::{html_to_text, is_public_ip, validate_public_url};

    #[test]
    fn rejects_private_and_non_http_sources() {
        assert!(validate_public_url("http://127.0.0.1/secret").is_err());
        assert!(validate_public_url("file:///etc/passwd").is_err());
        assert!(validate_public_url("https://docs.monad.xyz").is_ok());
    }

    #[test]
    fn converts_basic_html_to_readable_text() {
        assert_eq!(
            html_to_text("<h1>Monad</h1><p>Fast &amp; parallel.</p>"),
            "Monad Fast & parallel."
        );
    }

    #[test]
    fn rejects_private_reserved_and_mapped_addresses_after_resolution() {
        for ip in [
            IpAddr::V4(Ipv4Addr::new(10, 1, 2, 3)),
            IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(198, 18, 0, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            "::ffff:127.0.0.1".parse().expect("valid mapped address"),
        ] {
            assert!(!is_public_ip(ip), "{ip} should be blocked");
        }
        assert!(is_public_ip(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
        assert!(is_public_ip(
            "2606:4700:4700::1111"
                .parse()
                .expect("valid public address")
        ));
    }
}
