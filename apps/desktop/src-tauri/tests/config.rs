use std::{fs, path::PathBuf};

use serde_json::Value;

fn manifest_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn json(relative: &str) -> Value {
    serde_json::from_slice(&fs::read(manifest_path(relative)).unwrap()).unwrap()
}

#[test]
fn production_config_has_no_remotely_configured_window() {
    let config = json("tauri.conf.json");
    assert_eq!(config["app"]["windows"], serde_json::json!([]));
    assert_eq!(config["bundle"]["targets"], serde_json::json!(["nsis"]));
}

#[test]
fn production_csp_blocks_remote_code_and_frames() {
    let config = json("tauri.conf.json");
    let csp = config["app"]["security"]["csp"].as_str().unwrap();
    assert!(csp.contains("script-src 'self' 'wasm-unsafe-eval'"));
    assert!(csp.contains("frame-src 'none'"));
    assert!(csp.contains("object-src 'none'"));
    assert!(!csp.contains("script-src https:"));
    assert!(!csp.contains("frame-src https:"));
}

#[test]
fn one_named_capability_excludes_powerful_plugins() {
    let capabilities = manifest_path("capabilities");
    let files: Vec<_> = fs::read_dir(&capabilities)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    assert_eq!(files.len(), 1);

    let capability = json("capabilities/default.json");
    assert_eq!(capability["identifier"], "default");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    let permissions = capability["permissions"].as_array().unwrap();
    for permission in permissions {
        let identifier = permission
            .as_str()
            .or_else(|| permission["identifier"].as_str())
            .expect("capability permission identifier");
        for forbidden in ["shell:", "fs:", "process:", "updater:", "autostart:"] {
            assert!(
                !identifier.starts_with(forbidden),
                "unexpected permission: {identifier}"
            );
        }
    }
}

fn parse_http_scope_pattern(
    value: &str,
) -> Result<urlpattern::UrlPattern, urlpattern::quirks::Error> {
    let mut init =
        urlpattern::UrlPatternInit::parse_constructor_string::<regex::Regex>(value, None)?;
    if init
        .search
        .as_ref()
        .map(|part| part.is_empty())
        .unwrap_or(true)
    {
        init.search.replace("*".to_string());
    }
    if init
        .hash
        .as_ref()
        .map(|part| part.is_empty())
        .unwrap_or(true)
    {
        init.hash.replace("*".to_string());
    }
    if init
        .pathname
        .as_ref()
        .map(|part| part.is_empty() || part == "/")
        .unwrap_or(true)
    {
        init.pathname.replace("*".to_string());
    }
    urlpattern::UrlPattern::parse(init, Default::default())
}

#[test]
fn http_capability_url_patterns_are_valid() {
    let capability = json("capabilities/default.json");
    let http_permission = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|permission| permission["identifier"] == "http:default")
        .expect("http:default capability permission");

    let mut ipv6_loopback_pattern = None;
    for entry in http_permission["allow"].as_array().unwrap() {
        let value = entry["url"].as_str().expect("HTTP allow URL pattern");
        let pattern = parse_http_scope_pattern(value)
            .unwrap_or_else(|error| panic!("invalid HTTP allow URL pattern {value:?}: {error}"));
        if value == r"http://[\:\:1]:*" {
            ipv6_loopback_pattern = Some(pattern);
        }
    }

    let ipv6_loopback_pattern =
        ipv6_loopback_pattern.expect("escaped IPv6 loopback HTTP allow URL pattern");
    let ipv6_endpoint = url::Url::parse("http://[::1]:4000/api/connect").unwrap();
    assert!(ipv6_loopback_pattern
        .test(urlpattern::UrlPatternMatchInput::Url(ipv6_endpoint))
        .unwrap());
}
