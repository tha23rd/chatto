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
    let encoded = serde_json::to_string(&capability["permissions"]).unwrap();
    for forbidden in ["shell:", "fs:", "process:", "updater:", "autostart:"] {
        assert!(
            !encoded.contains(forbidden),
            "unexpected permission: {forbidden}"
        );
    }
}
