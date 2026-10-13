//! HTTP to printers on the LAN (Moonraker, OctoPrint, PrusaLink, SDCP
//! uploads): one shared client, printers' self-signed HTTPS accepted (see
//! [`super::tls`]), and their addresses turned into base URLs.

use std::sync::OnceLock;
use std::time::Duration;

/// Requests to a printer that take longer than this have failed. Uploads
/// set their own, longer, timeouts.
const TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .use_preconfigured_tls(super::tls::https_config())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TIMEOUT)
            .user_agent(concat!("FarmSlicer/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("the HTTP client builds")
    })
}

/// A printer's base URL from what an admin typed as its address: a URL
/// (`http://host/octoprint/`, kept as is but for a trailing slash), or
/// `host` / `host:port`, which gets `http://` and `default_port` when it
/// names none. `None` for an empty or unparseable address.
pub fn base_url(address: &str, default_port: u16) -> Option<url::Url> {
    let address = address.trim();
    if address.is_empty() {
        return None;
    }
    let mut url = if address.contains("://") {
        url::Url::parse(address).ok()?
    } else {
        let mut url = url::Url::parse(&format!("http://{address}")).ok()?;
        // `url` forgets a typed default port (`host:80`); look at the text.
        let authority = address.split('/').next().unwrap_or(address);
        let typed_port = match authority.rsplit_once(':') {
            Some((host, port)) => !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && (!host.starts_with('[') || host.ends_with(']')),
            None => false,
        };
        if !typed_port {
            url.set_port(Some(default_port)).ok()?;
        }
        url
    };
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&format!("{path}/"));
    url.set_query(None);
    url.set_fragment(None);
    Some(url)
}

/// `base` joined with a path relative to it (`server/info`).
pub fn join(base: &url::Url, path: &str) -> url::Url {
    base.join(path.trim_start_matches('/')).unwrap_or_else(|_| base.clone())
}

/// What went wrong with a request, briefly, for people.
pub fn explain(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".to_string()
    } else if e.is_connect() {
        // The innermost cause says the most ("Connection refused").
        let mut source: &dyn std::error::Error = e;
        while let Some(next) = source.source() {
            source = next;
        }
        format!("can't connect: {source}")
    } else {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_become_base_urls() {
        let b = |a| base_url(a, 7125).map(|u| u.to_string());
        assert_eq!(b("192.168.1.20").as_deref(), Some("http://192.168.1.20:7125/"));
        assert_eq!(b(" voron.local:80 ").as_deref(), Some("http://voron.local/"));
        assert_eq!(b("[fd00::5]").as_deref(), Some("http://[fd00::5]:7125/"));
        assert_eq!(b("[fd00::5]:8080").as_deref(), Some("http://[fd00::5]:8080/"));
        assert_eq!(b("http://voron.local").as_deref(), Some("http://voron.local/"));
        assert_eq!(b("https://pi.lan/octoprint").as_deref(), Some("https://pi.lan/octoprint/"));
        assert_eq!(b(""), None);
        assert_eq!(b("ftp://x"), None);
        let base = base_url("https://pi.lan/octoprint", 80).unwrap();
        assert_eq!(join(&base, "/api/job").as_str(), "https://pi.lan/octoprint/api/job");
    }
}
