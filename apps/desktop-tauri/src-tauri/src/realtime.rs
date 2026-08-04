use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::{mpsc, oneshot, Mutex, OwnedSemaphorePermit, Semaphore};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        protocol::{frame::coding::CloseCode, CloseFrame, WebSocketConfig},
        Message,
    },
};
use url::{Host, Url};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const RECEIVE_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const RECEIVE_CANCELLATION_POLL: Duration = Duration::from_secs(1);
#[cfg(not(test))]
const RECEIVE_HEARTBEAT: Duration = Duration::from_secs(25);
#[cfg(test)]
const RECEIVE_HEARTBEAT: Duration = Duration::from_millis(25);
const MAX_ACTIVE_CONNECTIONS: usize = 64;
const MAX_MESSAGE_SIZE: usize = 1024 * 1024;
const OUTBOUND_QUEUE_CAPACITY: usize = 16;

type ConnectionId = u32;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeClose {
    code: u16,
    reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum RealtimeEvent {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close(Option<RealtimeClose>),
    Error,
    Idle,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeClose {
    code: u16,
    reason: String,
}

enum ConnectionCommand {
    Binary(Vec<u8>),
    Receive(oneshot::Sender<RealtimeEvent>),
    Disconnect(NativeClose),
}

struct RealtimeConnectionManagerInner {
    next_id: AtomicU32,
    connections: Mutex<HashMap<ConnectionId, mpsc::Sender<ConnectionCommand>>>,
    connection_slots: Arc<Semaphore>,
}

/// Owns bounded command queues for the process's native realtime connections.
///
/// A connection is removed from this map before an explicit disconnect and
/// after its task exits for every other reason. Inbound WebSocket reads happen
/// only while one renderer receive request is pending, so WebView IPC and TCP
/// backpressure bound memory if either side becomes busy.
#[derive(Clone)]
pub struct RealtimeConnectionManager {
    inner: Arc<RealtimeConnectionManagerInner>,
}

impl Default for RealtimeConnectionManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(RealtimeConnectionManagerInner {
                next_id: AtomicU32::new(1),
                connections: Mutex::new(HashMap::new()),
                connection_slots: Arc::new(Semaphore::new(MAX_ACTIVE_CONNECTIONS)),
            }),
        }
    }
}

impl RealtimeConnectionManager {
    async fn connect(&self, value: String) -> Result<ConnectionId, String> {
        let endpoint = validate_realtime_url(&value)?;
        let slot = self.acquire_connection_slot()?;
        let connection = tokio::time::timeout(
            CONNECT_TIMEOUT,
            connect_async_with_config(endpoint.as_str(), Some(websocket_config()), false),
        )
        .await
        .map_err(|_| "Native realtime connection timed out.".to_string())?
        .map_err(|_| "Native realtime connection failed.".to_string())?;
        let (socket, _) = connection;
        let (commands, command_receiver) = mpsc::channel(OUTBOUND_QUEUE_CAPACITY);
        let id = self.insert(commands).await?;
        let manager = self.clone();

        tauri::async_runtime::spawn(async move {
            let _slot = slot;
            let (mut writer, mut reader) = socket.split();
            let mut commands = command_receiver;
            let mut pending_receive: Option<oneshot::Sender<RealtimeEvent>> = None;
            let mut receive_idle_since = tokio::time::Instant::now();

            loop {
                tokio::select! {
                    biased;
                    command = commands.recv() => {
                        match command {
                            Some(ConnectionCommand::Binary(data)) => {
                                let sent = tokio::time::timeout(
                                    COMMAND_TIMEOUT,
                                    writer.send(Message::Binary(data.into())),
                                ).await;
                                if !matches!(sent, Ok(Ok(()))) {
                                    respond(&mut pending_receive, RealtimeEvent::Error);
                                    break;
                                }
                            }
                            Some(ConnectionCommand::Receive(response)) => {
                                if pending_receive.is_some() {
                                    let _ = response.send(RealtimeEvent::Error);
                                } else {
                                    pending_receive = Some(response);
                                }
                            }
                            Some(ConnectionCommand::Disconnect(close)) => {
                                let frame = CloseFrame {
                                    code: CloseCode::from(close.code),
                                    reason: close.reason.into(),
                                };
                                let _ = tokio::time::timeout(
                                    COMMAND_TIMEOUT,
                                    writer.send(Message::Close(Some(frame))),
                                ).await;
                                break;
                            }
                            None => break,
                        }
                    }
                    message = reader.next(), if pending_receive.is_some() => {
                        let (event, flush, close) = match message {
                            Some(Ok(Message::Text(data))) => {
                                (RealtimeEvent::Text(data.to_string()), false, false)
                            }
                            Some(Ok(Message::Binary(data))) => {
                                (RealtimeEvent::Binary(data.to_vec()), false, false)
                            }
                            Some(Ok(Message::Ping(data))) => {
                                (RealtimeEvent::Ping(data.to_vec()), true, false)
                            }
                            Some(Ok(Message::Pong(data))) => {
                                (RealtimeEvent::Pong(data.to_vec()), false, false)
                            }
                            Some(Ok(Message::Close(frame))) => {
                                let close = frame.map(|frame| RealtimeClose {
                                    code: frame.code.into(),
                                    reason: frame.reason.to_string(),
                                });
                                (RealtimeEvent::Close(close), true, true)
                            }
                            Some(Ok(Message::Frame(_))) => continue,
                            Some(Err(_)) | None => {
                                respond(&mut pending_receive, RealtimeEvent::Error);
                                break;
                            }
                        };

                        if !respond(&mut pending_receive, event) {
                            break;
                        }
                        receive_idle_since = tokio::time::Instant::now();
                        let flushed = !flush || matches!(
                            tokio::time::timeout(COMMAND_TIMEOUT, writer.flush()).await,
                            Ok(Ok(()))
                        );
                        if !flushed || close {
                            break;
                        }
                    }
                    _ = tokio::time::sleep(RECEIVE_CANCELLATION_POLL), if pending_receive.is_some() => {
                        if pending_receive.as_ref().is_some_and(oneshot::Sender::is_closed) {
                            break;
                        }
                    }
                    _ = tokio::time::sleep(RECEIVE_HEARTBEAT), if pending_receive.is_some() => {
                        if !respond(&mut pending_receive, RealtimeEvent::Idle) {
                            break;
                        }
                        receive_idle_since = tokio::time::Instant::now();
                    }
                    _ = tokio::time::sleep_until(receive_idle_since + RECEIVE_IDLE_TIMEOUT), if pending_receive.is_none() => {
                        break;
                    }
                }
            }

            manager.remove(id).await;
        });

        Ok(id)
    }

    async fn receive(&self, id: ConnectionId) -> Result<RealtimeEvent, String> {
        let Some(commands) = self.sender(id).await else {
            return Err("Native realtime connection is not open.".to_string());
        };
        let (response, event) = oneshot::channel();
        queue_command(&commands, ConnectionCommand::Receive(response))?;
        event
            .await
            .map_err(|_| "Native realtime connection is not open.".to_string())
    }

    async fn disconnect(&self, id: ConnectionId, mut close: NativeClose) {
        let Some(commands) = self.remove(id).await else {
            return;
        };
        if close.reason.len() > 123 {
            close.reason.clear();
        }
        let _ = tokio::time::timeout(
            COMMAND_TIMEOUT,
            commands.send(ConnectionCommand::Disconnect(close)),
        )
        .await;
    }

    fn acquire_connection_slot(&self) -> Result<OwnedSemaphorePermit, String> {
        Arc::clone(&self.inner.connection_slots)
            .try_acquire_owned()
            .map_err(|_| "Native realtime connection limit reached.".to_string())
    }

    async fn insert(
        &self,
        commands: mpsc::Sender<ConnectionCommand>,
    ) -> Result<ConnectionId, String> {
        let mut connections = self.inner.connections.lock().await;
        if connections.len() >= MAX_ACTIVE_CONNECTIONS {
            return Err("Native realtime connection limit reached.".to_string());
        }

        loop {
            let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
            if id != 0 && !connections.contains_key(&id) {
                connections.insert(id, commands);
                return Ok(id);
            }
        }
    }

    async fn sender(&self, id: ConnectionId) -> Option<mpsc::Sender<ConnectionCommand>> {
        self.inner.connections.lock().await.get(&id).cloned()
    }

    async fn remove(&self, id: ConnectionId) -> Option<mpsc::Sender<ConnectionCommand>> {
        self.inner.connections.lock().await.remove(&id)
    }

    #[cfg(test)]
    async fn active_connection_count(&self) -> usize {
        self.inner.connections.lock().await.len()
    }
}

fn respond(pending: &mut Option<oneshot::Sender<RealtimeEvent>>, event: RealtimeEvent) -> bool {
    pending
        .take()
        .is_some_and(|response| response.send(event).is_ok())
}

fn validate_realtime_url(value: &str) -> Result<Url, String> {
    let invalid = || "Realtime URL is not allowed.".to_string();
    let endpoint = Url::parse(value).map_err(|_| invalid())?;
    if !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(invalid());
    }

    let loopback = endpoint.host().is_some_and(|host| match host {
        Host::Domain(name) => name == "localhost",
        Host::Ipv4(address) => address == std::net::Ipv4Addr::LOCALHOST,
        Host::Ipv6(address) => address == std::net::Ipv6Addr::LOCALHOST,
    });
    if endpoint.scheme() != "wss" && !(endpoint.scheme() == "ws" && loopback) {
        return Err(invalid());
    }
    Ok(endpoint)
}

fn websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .read_buffer_size(16 * 1024)
        .write_buffer_size(16 * 1024)
        .max_write_buffer_size(MAX_MESSAGE_SIZE)
        .max_message_size(Some(MAX_MESSAGE_SIZE))
        .max_frame_size(Some(MAX_MESSAGE_SIZE))
}

fn queue_command(
    commands: &mpsc::Sender<ConnectionCommand>,
    command: ConnectionCommand,
) -> Result<(), String> {
    commands.try_send(command).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => "Native realtime connection is busy.".to_string(),
        mpsc::error::TrySendError::Closed(_) => {
            "Native realtime connection is not open.".to_string()
        }
    })
}

#[tauri::command]
pub async fn realtime_connect(
    state: State<'_, RealtimeConnectionManager>,
    url: String,
) -> Result<ConnectionId, String> {
    state.connect(url).await
}

#[tauri::command]
pub async fn realtime_receive(
    state: State<'_, RealtimeConnectionManager>,
    id: ConnectionId,
) -> Result<RealtimeEvent, String> {
    state.receive(id).await
}

#[tauri::command]
pub async fn realtime_send(
    state: State<'_, RealtimeConnectionManager>,
    id: ConnectionId,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.len() > MAX_MESSAGE_SIZE {
        return Err("Native realtime message is too large.".to_string());
    }
    let Some(commands) = state.sender(id).await else {
        return Err("Native realtime connection is not open.".to_string());
    };
    queue_command(&commands, ConnectionCommand::Binary(data))
}

#[tauri::command]
pub async fn realtime_disconnect(
    state: State<'_, RealtimeConnectionManager>,
    id: ConnectionId,
    close: NativeClose,
) -> Result<(), String> {
    state.disconnect(id, close).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::{net::TcpListener, time::timeout};
    use tokio_tungstenite::accept_async;

    use super::*;

    #[tokio::test]
    async fn interrupted_socket_is_removed_from_native_state() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let socket = accept_async(stream).await.unwrap();
            drop(socket);
        });
        let manager = RealtimeConnectionManager::default();

        let id = manager
            .connect(format!("ws://{address}/api/realtime"))
            .await
            .unwrap();
        let event = manager.receive(id).await.unwrap();
        server.await.unwrap();

        timeout(Duration::from_secs(2), async {
            while manager.active_connection_count().await != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("interrupted connection should be removed");
        assert!(matches!(event, RealtimeEvent::Error));
    }

    #[tokio::test]
    async fn quiet_socket_yields_idle_without_closing_native_state() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            while socket.next().await.is_some() {}
        });
        let manager = RealtimeConnectionManager::default();

        let id = manager
            .connect(format!("ws://{address}/api/realtime"))
            .await
            .unwrap();
        let event = timeout(Duration::from_secs(2), manager.receive(id))
            .await
            .expect("quiet connections should periodically release the IPC receive")
            .unwrap();

        assert!(matches!(event, RealtimeEvent::Idle));
        assert_eq!(manager.active_connection_count().await, 1);
        manager
            .disconnect(
                id,
                NativeClose {
                    code: 1000,
                    reason: String::new(),
                },
            )
            .await;
        server.await.unwrap();
    }

    #[tokio::test]
    async fn oversized_close_reason_still_removes_native_state() {
        let manager = RealtimeConnectionManager::default();
        let (commands, mut receiver) = mpsc::channel(1);
        let id = manager.insert(commands).await.unwrap();

        manager
            .disconnect(
                id,
                NativeClose {
                    code: 1000,
                    reason: "x".repeat(124),
                },
            )
            .await;

        assert_eq!(manager.active_connection_count().await, 0);
        let Some(ConnectionCommand::Disconnect(close)) = receiver.recv().await else {
            panic!("disconnect command was not queued");
        };
        assert!(close.reason.is_empty());
    }

    #[tokio::test]
    async fn connection_limit_includes_in_progress_handshakes() {
        let manager = RealtimeConnectionManager::default();
        let permits = (0..MAX_ACTIVE_CONNECTIONS)
            .map(|_| manager.acquire_connection_slot().unwrap())
            .collect::<Vec<_>>();

        assert!(manager.acquire_connection_slot().is_err());
        drop(permits);
        assert!(manager.acquire_connection_slot().is_ok());
    }

    #[test]
    fn outbound_queue_rejects_excess_work_without_waiting() {
        let (commands, _receiver) = mpsc::channel(1);

        assert!(queue_command(&commands, ConnectionCommand::Binary(vec![1])).is_ok());
        assert_eq!(
            queue_command(&commands, ConnectionCommand::Binary(vec![2])).unwrap_err(),
            "Native realtime connection is busy."
        );
    }

    #[test]
    fn native_url_policy_matches_the_renderer_outer_boundary() {
        assert!(validate_realtime_url("wss://chatto.example/api/realtime").is_ok());
        assert!(validate_realtime_url("ws://127.0.0.1:8080/api/realtime").is_ok());
        assert!(validate_realtime_url("ws://[::1]:8080/api/realtime").is_ok());
        assert!(validate_realtime_url("ws://chatto.example/api/realtime").is_err());
        assert!(validate_realtime_url("ws://192.168.1.2/api/realtime").is_err());
        assert!(validate_realtime_url("wss://user:secret@chatto.example/api/realtime").is_err());
        assert!(validate_realtime_url("wss://chatto.example/api/realtime#token").is_err());
    }
}
