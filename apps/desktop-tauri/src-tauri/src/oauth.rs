use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::StreamExt;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use url::Url;

const MAX_CALLBACK_REQUEST_BYTES: usize = 16 * 1024;
const MAX_TOKEN_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_ACCESS_TOKEN_BYTES: usize = 16 * 1024;
const CALLBACK_WAIT: Duration = Duration::from_secs(180);
const CALLBACK_READ_WAIT: Duration = Duration::from_secs(10);
const TOKEN_EXCHANGE_WAIT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOAuthRequest {
    pub server_url: String,
    pub authorize_path: String,
    pub code_challenge: String,
    pub code_verifier: String,
    pub state: String,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOAuthUser {
    pub id: String,
    pub login: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOAuthResult {
    pub access_token: String,
    pub user: Option<NativeOAuthUser>,
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host == "127.0.0.1"
        || host == "[::1]"
        || host == "::1"
}

fn validated_server_url(raw: &str) -> Result<Url, String> {
    let error = || "Server URL is not allowed.".to_string();
    let url = Url::parse(raw).map_err(|_| error())?;
    let host = url.host_str().ok_or_else(error)?;
    let secure = url.scheme() == "https";
    let loopback_development = url.scheme() == "http" && is_loopback_host(host);

    if (!secure && !loopback_development)
        || !url.username().is_empty()
        || url.password().is_some()
        || (url.path() != "/" && !url.path().is_empty())
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(error());
    }

    Ok(url)
}

fn build_authorization_url(
    server: &Url,
    request: &NativeOAuthRequest,
    redirect_uri: &str,
) -> Result<Url, String> {
    let error = || "OAuth authorization URL is not allowed.".to_string();
    if !request.authorize_path.starts_with('/')
        || request.authorize_path.starts_with("//")
        || request.authorize_path.contains('?')
        || request.authorize_path.contains('#')
    {
        return Err(error());
    }

    let mut authorize_url = server.join(&request.authorize_path).map_err(|_| error())?;
    if authorize_url.origin() != server.origin() {
        return Err(error());
    }
    authorize_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("code_challenge", &request.code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &request.state);
    Ok(authorize_url)
}

fn validate_pkce_request(request: &NativeOAuthRequest) -> Result<(), String> {
    let valid_verifier = (43..=128).contains(&request.code_verifier.len())
        && request
            .code_verifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~'));
    let expected_challenge =
        URL_SAFE_NO_PAD.encode(Sha256::digest(request.code_verifier.as_bytes()));
    if !valid_verifier
        || request.code_challenge.len() != 43
        || request.code_challenge != expected_challenge
        || !(16..=512).contains(&request.state.len())
    {
        return Err("OAuth PKCE parameters are not valid.".into());
    }
    Ok(())
}

fn parse_callback_request(request: &[u8], expected_state: &str) -> Result<String, String> {
    if request.len() > MAX_CALLBACK_REQUEST_BYTES {
        return Err("OAuth callback request was too large.".into());
    }
    let request = std::str::from_utf8(request)
        .map_err(|_| "OAuth callback request was not valid.".to_string())?;
    let request_line = request
        .lines()
        .next()
        .ok_or_else(|| "OAuth callback request was not valid.".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next();
    let target = parts.next();
    let version = parts.next();
    if method != Some("GET") || version != Some("HTTP/1.1") || parts.next().is_some() {
        return Err("OAuth callback request was not valid.".into());
    }
    let target = target.ok_or_else(|| "OAuth callback request was not valid.".to_string())?;
    if !target.starts_with('/') || target.starts_with("//") {
        return Err("OAuth callback request was not valid.".into());
    }
    let callback = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "OAuth callback request was not valid.".to_string())?;
    if callback.path() != "/servers/callback" || callback.fragment().is_some() {
        return Err("OAuth callback request was not valid.".into());
    }

    let state = callback
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    if state != expected_state {
        return Err("OAuth callback state did not match.".into());
    }
    if callback.query_pairs().any(|(key, _)| key == "error") {
        return Err("Authorization was denied by the server.".into());
    }

    let code = callback
        .query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    if code.is_empty() || code.len() > 4096 {
        return Err("OAuth callback did not include an authorization code.".into());
    }
    Ok(code)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    user: Option<NativeOAuthUser>,
}

fn parse_token_response(body: &[u8]) -> Result<NativeOAuthResult, String> {
    if body.len() > MAX_TOKEN_RESPONSE_BYTES {
        return Err("OAuth token response was too large.".into());
    }
    let response: TokenResponse = serde_json::from_slice(body)
        .map_err(|_| "OAuth token response was not valid.".to_string())?;
    let access_token = response
        .access_token
        .filter(|token| !token.is_empty() && token.len() <= MAX_ACCESS_TOKEN_BYTES)
        .ok_or_else(|| "OAuth token response did not include an access token.".to_string())?;
    Ok(NativeOAuthResult {
        access_token,
        user: response.user,
    })
}

async fn read_callback_request(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut request = Vec::with_capacity(2048);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|_| "Could not read the OAuth callback.".to_string())?;
        if read == 0 {
            return Err("OAuth callback ended before its request was complete.".into());
        }
        request.extend_from_slice(&chunk[..read]);
        if request.len() > MAX_CALLBACK_REQUEST_BYTES {
            return Err("OAuth callback request was too large.".into());
        }
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            return Ok(request);
        }
    }
}

async fn write_callback_page(stream: &mut TcpStream, success: bool) {
    let body = if success {
        "<!doctype html><meta charset=utf-8><title>Chatto sign-in complete</title><h1>Sign-in complete</h1><p>You can close this window and return to Chatto.</p>"
    } else {
        "<!doctype html><meta charset=utf-8><title>Chatto sign-in failed</title><h1>Sign-in failed</h1><p>Return to Chatto and try again.</p>"
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn read_bounded_token_body(response: reqwest::Response) -> Result<(bool, Vec<u8>), String> {
    let success = response.status().is_success();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_TOKEN_RESPONSE_BYTES as u64)
    {
        return Err("OAuth token response was too large.".into());
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Could not read the OAuth token response.".to_string())?;
        if body.len() + chunk.len() > MAX_TOKEN_RESPONSE_BYTES {
            return Err("OAuth token response was too large.".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok((success, body))
}

async fn exchange_code(
    server: &Url,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<NativeOAuthResult, String> {
    let token_url = server
        .join("/oauth/token")
        .map_err(|_| "OAuth token endpoint is not valid.".to_string())?;
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(TOKEN_EXCHANGE_WAIT)
        .build()
        .map_err(|_| "Could not initialize the OAuth token client.".to_string())?;
    let response = client
        .post(token_url)
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirect_uri,
        }))
        .send()
        .await
        .map_err(|_| "OAuth token exchange failed.".to_string())?;
    let (success, body) = read_bounded_token_body(response).await?;
    if !success {
        return Err("OAuth token exchange was rejected by the server.".into());
    }
    parse_token_response(&body)
}

#[tauri::command]
pub async fn start_server_oauth(
    app: AppHandle,
    request: NativeOAuthRequest,
) -> Result<NativeOAuthResult, String> {
    let server = validated_server_url(&request.server_url)?;
    validate_pkce_request(&request)?;

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| "Could not start the OAuth callback listener.".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "Could not inspect the OAuth callback listener.".to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/servers/callback");
    let authorize_url = build_authorization_url(&server, &request, &redirect_uri)?;

    app.opener()
        .open_url(authorize_url.as_str(), None::<&str>)
        .map_err(|_| "Could not open the system browser for sign-in.".to_string())?;

    let (mut stream, _) = timeout(CALLBACK_WAIT, listener.accept())
        .await
        .map_err(|_| "Timed out waiting for OAuth sign-in.".to_string())?
        .map_err(|_| "Could not accept the OAuth callback.".to_string())?;
    let callback_request =
        match timeout(CALLBACK_READ_WAIT, read_callback_request(&mut stream)).await {
            Ok(Ok(request)) => request,
            Ok(Err(error)) => {
                write_callback_page(&mut stream, false).await;
                return Err(error);
            }
            Err(_) => {
                write_callback_page(&mut stream, false).await;
                return Err("Timed out reading the OAuth callback.".into());
            }
        };
    let code = match parse_callback_request(&callback_request, &request.state) {
        Ok(code) => code,
        Err(error) => {
            write_callback_page(&mut stream, false).await;
            return Err(error);
        }
    };

    let result = exchange_code(&server, &code, &request.code_verifier, &redirect_uri).await;
    write_callback_page(&mut stream, result.is_ok()).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> NativeOAuthRequest {
        NativeOAuthRequest {
            server_url: "https://chatto.example".into(),
            authorize_path: "/oauth/authorize".into(),
            code_challenge: "challenge".into(),
            code_verifier: "verifier".into(),
            state: "expected-state".into(),
        }
    }

    #[test]
    fn validates_https_and_loopback_server_origins() {
        assert_eq!(
            validated_server_url("https://chatto.example")
                .unwrap()
                .as_str(),
            "https://chatto.example/"
        );
        assert!(validated_server_url("http://localhost:8080").is_ok());
        assert!(validated_server_url("http://127.0.0.1:8080").is_ok());
        assert!(validated_server_url("http://[::1]:8080").is_ok());
    }

    #[test]
    fn rejects_unsafe_server_urls_without_echoing_them() {
        for raw in [
            "http://chatto.example",
            "file:///tmp/chatto",
            "https://user:secret@chatto.example",
            "https://chatto.example/path",
            "https://chatto.example?token=secret",
            "https://chatto.example/#token=secret",
        ] {
            let error = validated_server_url(raw).unwrap_err();
            assert_eq!(error, "Server URL is not allowed.");
            assert!(!error.contains(raw));
        }
    }

    #[test]
    fn builds_same_origin_authorization_url() {
        let request = request();
        let url = build_authorization_url(
            &validated_server_url(&request.server_url).unwrap(),
            &request,
            "http://127.0.0.1:49152/servers/callback",
        )
        .unwrap();

        assert_eq!(url.origin().ascii_serialization(), "https://chatto.example");
        assert_eq!(url.path(), "/oauth/authorize");
        assert_eq!(
            url.query_pairs()
                .find(|(key, _)| key == "response_type")
                .unwrap()
                .1,
            "code"
        );
        assert_eq!(
            url.query_pairs()
                .find(|(key, _)| key == "redirect_uri")
                .unwrap()
                .1,
            "http://127.0.0.1:49152/servers/callback"
        );
        assert_eq!(
            url.query_pairs().find(|(key, _)| key == "state").unwrap().1,
            "expected-state"
        );
    }

    #[test]
    fn rejects_cross_origin_authorization_path() {
        let mut request = request();
        request.authorize_path = "https://evil.example/oauth/authorize".into();
        let error = build_authorization_url(
            &validated_server_url(&request.server_url).unwrap(),
            &request,
            "http://127.0.0.1:49152/servers/callback",
        )
        .unwrap_err();
        assert_eq!(error, "OAuth authorization URL is not allowed.");
    }

    #[test]
    fn parses_a_bounded_loopback_callback() {
        let code = parse_callback_request(
            b"GET /servers/callback?code=auth-code&state=expected-state HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "expected-state",
        )
        .unwrap();
        assert_eq!(code, "auth-code");
    }

    #[test]
    fn rejects_callback_state_mismatch() {
        let error = parse_callback_request(
            b"GET /servers/callback?code=auth-code&state=wrong HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "expected-state",
        )
        .unwrap_err();
        assert_eq!(error, "OAuth callback state did not match.");
    }

    #[test]
    fn reports_provider_denial_without_reflecting_the_description() {
        let error = parse_callback_request(
            b"GET /servers/callback?error=access_denied&error_description=sensitive&state=expected-state HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "expected-state",
        )
        .unwrap_err();
        assert_eq!(error, "Authorization was denied by the server.");
    }

    #[test]
    fn bounds_and_parses_token_responses() {
        assert_eq!(
            parse_token_response(
                br#"{"access_token":"token","user":{"id":"user-1","login":"ada","displayName":"Ada"}}"#,
            )
            .unwrap(),
            NativeOAuthResult {
                access_token: "token".into(),
                user: Some(NativeOAuthUser {
                    id: "user-1".into(),
                    login: "ada".into(),
                    display_name: Some("Ada".into()),
                    avatar_url: None,
                }),
            }
        );
        assert_eq!(
            parse_token_response(&vec![b'x'; MAX_TOKEN_RESPONSE_BYTES + 1]).unwrap_err(),
            "OAuth token response was too large."
        );
    }
}
