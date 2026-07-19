use std::time::{Duration, SystemTime, UNIX_EPOCH};

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Error as UpdaterError, Update, Updater, UpdaterExt};
use tokio::sync::Mutex;
use url::Url;

use crate::shell::ShellState;

const STABLE_ENDPOINT: &str = "https://updates.chatto.run/desktop/stable/windows-x86_64.json";
const NIGHTLY_ENDPOINT: &str = "https://updates.chatto.run/desktop/nightly/windows-x86_64.json";
const UPDATE_STATE_EVENT: &str = "native://desktop-update-state";
const UPDATE_TIMEOUT: Duration = Duration::from_secs(30);

// Generated only for local builds. Production release workflows replace this
// public key at compile time and never possess the matching development key.
const INERT_DEVELOPMENT_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQyMzAzOUMwMEZBM0I5QjIKUldTeXVhTVB3RGt3MHE0TDl3KzlmNC9nRlV5ZlhEejErVjRMdnhzUjJ5UTdQUFRiVEV3UVVWQTMK";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpdateChannel {
    #[default]
    Stable,
    Nightly,
}

impl UpdateChannel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Nightly => "nightly",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum UpdatePhase {
    Idle,
    Checking,
    Downloading,
    Ready,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ErrorCode {
    Network,
    Metadata,
    Signature,
    Download,
    Install,
    Unavailable,
}

impl ErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Metadata => "metadata",
            Self::Signature => "signature",
            Self::Download => "download",
            Self::Install => "install",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopUpdateSnapshot {
    supported: bool,
    channel: UpdateChannel,
    phase: UpdatePhase,
    current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidate_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_checked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<ErrorCode>,
    restart_suppressed: bool,
}

#[derive(Default)]
struct DownloadProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

impl DownloadProgress {
    fn advance(&mut self, chunk_bytes: usize, advertised_total: Option<u64>) {
        self.downloaded_bytes = self
            .downloaded_bytes
            .saturating_add(u64::try_from(chunk_bytes).unwrap_or(u64::MAX));
        self.total_bytes = advertised_total.map(|total| total.max(self.downloaded_bytes));
    }
}

struct UpdateLifecycle {
    snapshot: DesktopUpdateSnapshot,
    operation_active: bool,
    check_started_at: Option<u64>,
}

impl UpdateLifecycle {
    fn new(current_version: String) -> Self {
        Self {
            snapshot: DesktopUpdateSnapshot {
                supported: true,
                channel: UpdateChannel::Stable,
                phase: UpdatePhase::Idle,
                current_version,
                candidate_version: None,
                downloaded_bytes: None,
                total_bytes: None,
                last_checked_at: None,
                error_code: None,
                restart_suppressed: false,
            },
            operation_active: false,
            check_started_at: None,
        }
    }

    fn is_busy(&self) -> bool {
        self.operation_active
    }

    fn begin_check(&mut self, started_at: u64) -> Result<(), ErrorCode> {
        if self.is_busy() {
            return Err(ErrorCode::Unavailable);
        }
        self.operation_active = true;
        self.check_started_at = Some(started_at);
        self.snapshot.phase = UpdatePhase::Checking;
        self.snapshot.candidate_version = None;
        self.snapshot.downloaded_bytes = None;
        self.snapshot.total_bytes = None;
        self.snapshot.error_code = None;
        Ok(())
    }

    fn begin_download(&mut self, candidate_version: String) -> Result<(), ErrorCode> {
        if !self.operation_active || self.snapshot.phase != UpdatePhase::Checking {
            return Err(ErrorCode::Unavailable);
        }
        self.snapshot.phase = UpdatePhase::Downloading;
        self.snapshot.candidate_version = Some(candidate_version);
        self.snapshot.downloaded_bytes = Some(0);
        self.snapshot.total_bytes = None;
        self.snapshot.last_checked_at = self.check_started_at;
        Ok(())
    }

    fn update_progress(&mut self, chunk_bytes: usize, advertised_total: Option<u64>) {
        if self.snapshot.phase != UpdatePhase::Downloading {
            return;
        }
        let mut progress = DownloadProgress {
            downloaded_bytes: self.snapshot.downloaded_bytes.unwrap_or(0),
            total_bytes: self.snapshot.total_bytes,
        };
        progress.advance(chunk_bytes, advertised_total);
        self.snapshot.downloaded_bytes = Some(progress.downloaded_bytes);
        self.snapshot.total_bytes = progress.total_bytes;
    }

    fn finish_ready(&mut self, downloaded_bytes: u64, total_bytes: Option<u64>) {
        self.operation_active = false;
        self.check_started_at = None;
        self.snapshot.phase = UpdatePhase::Ready;
        self.snapshot.downloaded_bytes = Some(downloaded_bytes);
        self.snapshot.total_bytes = total_bytes.map(|total| total.max(downloaded_bytes));
        self.snapshot.error_code = None;
    }

    fn finish_idle(&mut self) {
        self.operation_active = false;
        self.snapshot.phase = UpdatePhase::Idle;
        self.snapshot.candidate_version = None;
        self.snapshot.downloaded_bytes = None;
        self.snapshot.total_bytes = None;
        self.snapshot.last_checked_at = self.check_started_at.take();
        self.snapshot.error_code = None;
    }

    fn finish_install(&mut self) {
        let last_checked_at = self.snapshot.last_checked_at;
        self.finish_idle();
        self.snapshot.last_checked_at = last_checked_at;
    }

    fn finish_failure(&mut self, error: ErrorCode) {
        self.operation_active = false;
        self.check_started_at = None;
        self.snapshot.phase = UpdatePhase::Failed;
        self.snapshot.error_code = Some(error);
    }

    fn begin_install(&mut self) -> Result<(), ErrorCode> {
        if self.is_busy() || self.snapshot.phase != UpdatePhase::Ready {
            return Err(ErrorCode::Unavailable);
        }
        self.operation_active = true;
        self.snapshot.error_code = None;
        Ok(())
    }

    fn restore_ready(&mut self, error: ErrorCode) {
        self.operation_active = false;
        self.snapshot.phase = UpdatePhase::Ready;
        self.snapshot.error_code = Some(error);
    }

    fn set_channel(&mut self, channel: UpdateChannel) -> Result<bool, ErrorCode> {
        if self.snapshot.channel == channel {
            return Ok(false);
        }
        if self.is_busy() {
            return Err(ErrorCode::Unavailable);
        }
        self.snapshot.channel = channel;
        self.snapshot.phase = UpdatePhase::Idle;
        self.snapshot.candidate_version = None;
        self.snapshot.downloaded_bytes = None;
        self.snapshot.total_bytes = None;
        self.snapshot.error_code = None;
        Ok(true)
    }
}

struct UpdateManagerState {
    channel: UpdateChannel,
    lifecycle: UpdateLifecycle,
    pending_update: Option<Update>,
    downloaded_bytes: Option<Vec<u8>>,
}

/// Owns the one process-wide updater lifecycle.
///
/// The mutex protects the visible snapshot together with the exact verified
/// package that may be installed. Network and installer work always happens
/// after releasing the lock.
pub(crate) struct DesktopUpdateManager {
    inner: Mutex<UpdateManagerState>,
}

impl DesktopUpdateManager {
    pub(crate) fn new(current_version: String) -> Self {
        Self {
            inner: Mutex::new(UpdateManagerState {
                channel: UpdateChannel::Stable,
                lifecycle: UpdateLifecycle::new(current_version),
                pending_update: None,
                downloaded_bytes: None,
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FailureStage {
    Check,
    Download,
    Install,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FailureKind {
    Transport,
    InvalidResponse,
    InvalidSignature,
    Installer,
}

fn normalize_error(stage: FailureStage, kind: FailureKind) -> ErrorCode {
    match (stage, kind) {
        (FailureStage::Check, FailureKind::Transport) => ErrorCode::Network,
        (FailureStage::Check, _) => ErrorCode::Metadata,
        (FailureStage::Download, FailureKind::InvalidSignature) => ErrorCode::Signature,
        (FailureStage::Download, _) => ErrorCode::Download,
        (FailureStage::Install, _) => ErrorCode::Install,
    }
}

fn classify_updater_error(stage: FailureStage, error: &UpdaterError) -> ErrorCode {
    let kind = match error {
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) => FailureKind::Transport,
        UpdaterError::Minisign(_) | UpdaterError::Base64(_) | UpdaterError::SignatureUtf8(_) => {
            FailureKind::InvalidSignature
        }
        UpdaterError::AuthenticationFailed
        | UpdaterError::DebInstallFailed
        | UpdaterError::PackageInstallFailed => FailureKind::Installer,
        _ => FailureKind::InvalidResponse,
    };
    normalize_error(stage, kind)
}

fn endpoint(channel: UpdateChannel) -> Url {
    let value = match channel {
        UpdateChannel::Stable => STABLE_ENDPOINT,
        UpdateChannel::Nightly => NIGHTLY_ENDPOINT,
    };
    Url::parse(value).expect("hard-coded desktop update endpoint must be valid")
}

fn is_strictly_newer(current: &str, candidate: &str) -> bool {
    match (Version::parse(current), Version::parse(candidate)) {
        (Ok(current), Ok(candidate)) => candidate > current,
        _ => false,
    }
}

pub(crate) fn updater_public_key() -> &'static str {
    match option_env!("CHATTO_DESKTOP_UPDATER_PUBLIC_KEY") {
        Some(key) if !key.trim().is_empty() => key,
        _ => INERT_DEVELOPMENT_PUBLIC_KEY,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn public_snapshot(state: &UpdateManagerState, shell: &ShellState) -> DesktopUpdateSnapshot {
    let mut snapshot = state.lifecycle.snapshot.clone();
    snapshot.restart_suppressed = shell.has_active_call();
    snapshot
}

fn emit_snapshot(app: &AppHandle, snapshot: &DesktopUpdateSnapshot) {
    let _ = app.emit(UPDATE_STATE_EVENT, snapshot);
}

fn log_snapshot(snapshot: &DesktopUpdateSnapshot) {
    log::info!(
        "desktop updater channel={} phase={:?} current={} candidate={} error={}",
        snapshot.channel.as_str(),
        snapshot.phase,
        snapshot.current_version,
        snapshot.candidate_version.as_deref().unwrap_or("none"),
        snapshot.error_code.map(ErrorCode::as_str).unwrap_or("none")
    );
}

fn runtime_updater(app: &AppHandle, channel: UpdateChannel) -> Result<Updater, UpdaterError> {
    app.updater_builder()
        .endpoints(vec![endpoint(channel)])?
        .timeout(UPDATE_TIMEOUT)
        .build()
}

async fn fail_operation(
    app: &AppHandle,
    manager: &DesktopUpdateManager,
    shell: &ShellState,
    error: ErrorCode,
) -> ErrorCode {
    let snapshot = {
        let mut state = manager.inner.lock().await;
        state.pending_update = None;
        state.downloaded_bytes = None;
        state.lifecycle.finish_failure(error);
        public_snapshot(&state, shell)
    };
    log_snapshot(&snapshot);
    emit_snapshot(app, &snapshot);
    error
}

async fn restore_ready(
    app: &AppHandle,
    manager: &DesktopUpdateManager,
    shell: &ShellState,
    update: Update,
    bytes: Vec<u8>,
    error: ErrorCode,
) -> ErrorCode {
    let snapshot = {
        let mut state = manager.inner.lock().await;
        state.pending_update = Some(update);
        state.downloaded_bytes = Some(bytes);
        state.lifecycle.restore_ready(error);
        public_snapshot(&state, shell)
    };
    log_snapshot(&snapshot);
    emit_snapshot(app, &snapshot);
    error
}

#[tauri::command]
pub(crate) async fn get_desktop_update_state(
    manager: State<'_, DesktopUpdateManager>,
    shell: State<'_, ShellState>,
) -> Result<DesktopUpdateSnapshot, ErrorCode> {
    let state = manager.inner.lock().await;
    Ok(public_snapshot(&state, &shell))
}

#[tauri::command]
pub(crate) async fn set_desktop_update_channel(
    app: AppHandle,
    manager: State<'_, DesktopUpdateManager>,
    shell: State<'_, ShellState>,
    channel: UpdateChannel,
) -> Result<DesktopUpdateSnapshot, ErrorCode> {
    let snapshot = {
        let mut state = manager.inner.lock().await;
        let changed = state.lifecycle.set_channel(channel)?;
        if changed {
            state.channel = channel;
            state.pending_update = None;
            state.downloaded_bytes = None;
        }
        public_snapshot(&state, &shell)
    };
    log_snapshot(&snapshot);
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn check_for_desktop_update(
    app: AppHandle,
    manager: State<'_, DesktopUpdateManager>,
    shell: State<'_, ShellState>,
) -> Result<DesktopUpdateSnapshot, ErrorCode> {
    let (channel, checking_snapshot) = {
        let mut state = manager.inner.lock().await;
        state.lifecycle.begin_check(now_millis())?;
        state.pending_update = None;
        state.downloaded_bytes = None;
        (state.channel, public_snapshot(&state, &shell))
    };
    log_snapshot(&checking_snapshot);
    emit_snapshot(&app, &checking_snapshot);

    let updater = match runtime_updater(&app, channel) {
        Ok(updater) => updater,
        Err(error) => {
            let code = classify_updater_error(FailureStage::Check, &error);
            return Err(fail_operation(&app, &manager, &shell, code).await);
        }
    };
    let update = match updater.check().await {
        Ok(update) => update,
        Err(error) => {
            let code = classify_updater_error(FailureStage::Check, &error);
            return Err(fail_operation(&app, &manager, &shell, code).await);
        }
    };

    let Some(mut update) = update else {
        let snapshot = {
            let mut state = manager.inner.lock().await;
            state.lifecycle.finish_idle();
            public_snapshot(&state, &shell)
        };
        log_snapshot(&snapshot);
        emit_snapshot(&app, &snapshot);
        return Ok(snapshot);
    };

    if !is_strictly_newer(&update.current_version, &update.version) {
        let snapshot = {
            let mut state = manager.inner.lock().await;
            state.lifecycle.finish_idle();
            public_snapshot(&state, &shell)
        };
        log_snapshot(&snapshot);
        emit_snapshot(&app, &snapshot);
        return Ok(snapshot);
    }

    update.timeout = Some(UPDATE_TIMEOUT);

    let candidate_version = update.version.clone();
    let downloading_snapshot = {
        let mut state = manager.inner.lock().await;
        state.lifecycle.begin_download(candidate_version.clone())?;
        public_snapshot(&state, &shell)
    };
    log_snapshot(&downloading_snapshot);
    emit_snapshot(&app, &downloading_snapshot);

    let bytes = match update
        .download(
            |chunk_bytes, content_length| {
                if let Ok(mut state) = manager.inner.try_lock() {
                    state.lifecycle.update_progress(chunk_bytes, content_length);
                    let snapshot = public_snapshot(&state, &shell);
                    emit_snapshot(&app, &snapshot);
                }
            },
            || {},
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            let code = classify_updater_error(FailureStage::Download, &error);
            return Err(fail_operation(&app, &manager, &shell, code).await);
        }
    };

    let snapshot = {
        let mut state = manager.inner.lock().await;
        let downloaded_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        let total_bytes = state.lifecycle.snapshot.total_bytes;
        state.lifecycle.finish_ready(downloaded_bytes, total_bytes);
        state.pending_update = Some(update);
        state.downloaded_bytes = Some(bytes);
        public_snapshot(&state, &shell)
    };
    log_snapshot(&snapshot);
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

fn same_candidate(expected: &Update, offered: &Update) -> bool {
    expected.version == offered.version
        && expected.signature == offered.signature
        && expected.download_url == offered.download_url
}

/// Revalidates the immutable candidate and installs only its already verified
/// bytes. This command is the sole installation authority exposed to the UI.
#[tauri::command]
pub(crate) async fn install_desktop_update(
    app: AppHandle,
    manager: State<'_, DesktopUpdateManager>,
    shell: State<'_, ShellState>,
) -> Result<(), ErrorCode> {
    let (channel, update, bytes) = {
        let mut state = manager.inner.lock().await;
        state.lifecycle.begin_install()?;
        let Some(update) = state.pending_update.take() else {
            state.lifecycle.finish_failure(ErrorCode::Unavailable);
            return Err(ErrorCode::Unavailable);
        };
        let Some(bytes) = state.downloaded_bytes.take() else {
            state.pending_update = Some(update);
            state.lifecycle.finish_failure(ErrorCode::Unavailable);
            return Err(ErrorCode::Unavailable);
        };
        (state.channel, update, bytes)
    };

    let updater = match runtime_updater(&app, channel) {
        Ok(updater) => updater,
        Err(error) => {
            let code = classify_updater_error(FailureStage::Check, &error);
            return Err(restore_ready(&app, &manager, &shell, update, bytes, code).await);
        }
    };
    let offered = match updater.check().await {
        Ok(Some(offered)) if same_candidate(&update, &offered) => offered,
        Ok(_) => {
            return Err(fail_operation(&app, &manager, &shell, ErrorCode::Unavailable).await);
        }
        Err(error) => {
            let code = classify_updater_error(FailureStage::Check, &error);
            return Err(restore_ready(&app, &manager, &shell, update, bytes, code).await);
        }
    };
    drop(offered);

    if let Err(error) = update.install(&bytes) {
        let code = classify_updater_error(FailureStage::Install, &error);
        return Err(restore_ready(&app, &manager, &shell, update, bytes, code).await);
    }

    let snapshot = {
        let mut state = manager.inner.lock().await;
        state.lifecycle.finish_install();
        public_snapshot(&state, &shell)
    };
    log_snapshot(&snapshot);
    emit_snapshot(&app, &snapshot);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    #[test]
    fn channels_use_fixed_first_party_https_endpoints() {
        assert_eq!(
            endpoint(UpdateChannel::Stable).as_str(),
            "https://updates.chatto.run/desktop/stable/windows-x86_64.json"
        );
        assert_eq!(
            endpoint(UpdateChannel::Nightly).as_str(),
            "https://updates.chatto.run/desktop/nightly/windows-x86_64.json"
        );
        assert_eq!(UPDATE_STATE_EVENT, "native://desktop-update-state");
    }

    #[test]
    fn channels_serialize_lowercase_and_reject_arbitrary_values() {
        assert_eq!(
            serde_json::to_string(&UpdateChannel::Stable).unwrap(),
            "\"stable\""
        );
        assert_eq!(
            serde_json::to_string(&UpdateChannel::Nightly).unwrap(),
            "\"nightly\""
        );
        assert_eq!(
            serde_json::from_str::<UpdateChannel>("\"nightly\"").unwrap(),
            UpdateChannel::Nightly
        );
        assert!(serde_json::from_str::<UpdateChannel>("\"beta\"").is_err());
        assert!(serde_json::from_str::<UpdateChannel>("\"STABLE\"").is_err());
        assert!(
            serde_json::from_str::<UpdateChannel>("\"https://example.com/update.json\"").is_err()
        );
    }

    #[test]
    fn inert_development_key_is_valid_tauri_minisign_public_text() {
        let decoded = STANDARD
            .decode(INERT_DEVELOPMENT_PUBLIC_KEY)
            .expect("development updater public key base64");
        let decoded = String::from_utf8(decoded).expect("development updater public key UTF-8");
        let mut lines = decoded.lines();
        assert!(lines
            .next()
            .is_some_and(|line| line.starts_with("untrusted comment: minisign public key: ")));
        let key_line = lines
            .next()
            .filter(|line| line.starts_with("RWS"))
            .expect("minisign public key line");
        assert_eq!(STANDARD.decode(key_line).unwrap().len(), 42);
        assert!(lines.next().is_none());
    }

    #[test]
    fn only_strictly_greater_versions_are_offered() {
        assert!(is_strictly_newer("0.5.0", "0.5.1"));
        assert!(!is_strictly_newer("0.5.0", "0.5.0"));
        assert!(!is_strictly_newer("0.5.1", "0.5.0"));
        assert!(!is_strictly_newer("0.5.1-nightly.20260719.42", "0.5.0"));
        assert!(is_strictly_newer("0.5.0-nightly.20260719.42", "0.5.0"));
        assert!(!is_strictly_newer("not-a-version", "0.5.1"));
        assert!(!is_strictly_newer("0.5.0", "not-a-version"));
    }

    #[test]
    fn lifecycle_transitions_are_explicit_and_single_flight() {
        let mut state = UpdateLifecycle::new("0.5.0".to_string());

        assert_eq!(state.snapshot.phase, UpdatePhase::Idle);
        state.begin_check(1_721_376_000_000).unwrap();
        assert_eq!(state.snapshot.phase, UpdatePhase::Checking);
        assert_eq!(state.begin_download("0.5.1".to_string()), Ok(()));
        assert_eq!(
            state.begin_download("0.5.2".to_string()),
            Err(ErrorCode::Unavailable)
        );
        assert_eq!(
            state.set_channel(UpdateChannel::Nightly),
            Err(ErrorCode::Unavailable)
        );
        assert_eq!(state.set_channel(UpdateChannel::Stable), Ok(false));
        assert_eq!(
            state.begin_check(1_721_376_000_001),
            Err(ErrorCode::Unavailable)
        );
        assert_eq!(state.snapshot.phase, UpdatePhase::Downloading);
        assert_eq!(state.snapshot.candidate_version.as_deref(), Some("0.5.1"));

        state.finish_ready(40, Some(40));
        assert_eq!(state.snapshot.phase, UpdatePhase::Ready);
        assert!(!state.is_busy());

        let encoded = serde_json::to_value(&state.snapshot).unwrap();
        assert_eq!(encoded["restartSuppressed"], false);
        assert!(encoded["lastCheckedAt"].is_number());

        state.begin_check(1_721_376_100_000).unwrap();
        state.finish_failure(ErrorCode::Network);
        assert_eq!(state.snapshot.phase, UpdatePhase::Failed);
        assert_eq!(state.snapshot.error_code, Some(ErrorCode::Network));
        assert!(!state.is_busy());
    }

    #[test]
    fn failure_categories_are_normalized_by_operation_and_kind() {
        assert_eq!(
            normalize_error(FailureStage::Check, FailureKind::Transport),
            ErrorCode::Network
        );
        assert_eq!(
            normalize_error(FailureStage::Check, FailureKind::InvalidResponse),
            ErrorCode::Metadata
        );
        assert_eq!(
            normalize_error(FailureStage::Download, FailureKind::Transport),
            ErrorCode::Download
        );
        assert_eq!(
            normalize_error(FailureStage::Download, FailureKind::InvalidSignature),
            ErrorCode::Signature
        );
        assert_eq!(
            normalize_error(FailureStage::Install, FailureKind::Installer),
            ErrorCode::Install
        );
    }

    #[test]
    fn progress_is_bounded_when_content_length_is_absent_or_changes() {
        let mut progress = DownloadProgress::default();

        progress.advance(10, None);
        assert_eq!(progress.downloaded_bytes, 10);
        assert_eq!(progress.total_bytes, None);

        progress.advance(5, Some(12));
        assert_eq!(progress.downloaded_bytes, 15);
        assert_eq!(progress.total_bytes, Some(15));

        progress.advance(5, Some(100));
        assert_eq!(progress.downloaded_bytes, 20);
        assert_eq!(progress.total_bytes, Some(100));

        progress.advance(5, Some(18));
        assert_eq!(progress.downloaded_bytes, 25);
        assert_eq!(progress.total_bytes, Some(25));
    }
}
