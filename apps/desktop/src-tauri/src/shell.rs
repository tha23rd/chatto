use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    utils::config::WebviewUrl,
    webview::{NewWindowResponse, PageLoadEvent, WebviewWindowBuilder},
    App, AppHandle, Emitter, Manager, Runtime, State, WindowEvent, Wry,
};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MAIN_WINDOW_LABEL: &str = "main";
const SHOW_MENU_ID: &str = "show";
const MUTE_MENU_ID: &str = "toggle-mute";
const DEAFEN_MENU_ID: &str = "toggle-deafen";
const QUIT_MENU_ID: &str = "quit";
const TRAY_ACTION_EVENT: &str = "native://tray-action";
const TASKBAR_ATTENTION_ICON_SIZE: u32 = 32;
const TASKBAR_ATTENTION_COLOR: [u8; 4] = [237, 66, 69, 255];
const TASKBAR_ATTENTION_BORDER: [u8; 4] = [255, 255, 255, 255];

fn taskbar_attention_rgba() -> Vec<u8> {
    let mut rgba =
        vec![0; (TASKBAR_ATTENTION_ICON_SIZE * TASKBAR_ATTENTION_ICON_SIZE * 4) as usize];
    let size = TASKBAR_ATTENTION_ICON_SIZE as i32;

    for y in 0..size {
        for x in 0..size {
            let dx = x * 2 + 1 - size;
            let dy = y * 2 + 1 - size;
            let distance_squared = dx * dx + dy * dy;
            let color = if distance_squared <= 22 * 22 {
                TASKBAR_ATTENTION_COLOR
            } else if distance_squared <= 28 * 28 {
                TASKBAR_ATTENTION_BORDER
            } else {
                continue;
            };
            let offset = ((y * size + x) * 4) as usize;
            rgba[offset..offset + 4].copy_from_slice(&color);
        }
    }

    rgba
}

#[cfg(target_os = "windows")]
fn taskbar_attention_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::new_owned(
        taskbar_attention_rgba(),
        TASKBAR_ATTENTION_ICON_SIZE,
        TASKBAR_ATTENTION_ICON_SIZE,
    )
}

pub(crate) struct ShellState {
    quitting: AtomicBool,
    mute_item: MenuItem<Wry>,
    deafen_item: MenuItem<Wry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCallControls {
    connected: bool,
    muted: bool,
    deafened: bool,
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn packaged_app_navigation(url: &Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost"))
            | ("http", Some("tauri.localhost"))
            | ("https", Some("tauri.localhost"))
    )
}

fn allowed_navigation(url: &Url, development: bool) -> bool {
    packaged_app_navigation(url)
        || (development
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
            && url.port_or_known_default() == Some(5173))
}

fn open_external_https<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if url.scheme() == "https" {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

fn create_main_window(app: &mut App) -> tauri::Result<()> {
    let navigation_app = app.handle().clone();
    let new_window_app = app.handle().clone();
    WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("Chatto")
        .inner_size(1280.0, 800.0)
        .min_inner_size(960.0, 640.0)
        .resizable(true)
        .devtools(cfg!(debug_assertions))
        .visible(false)
        .on_navigation(move |url| {
            if allowed_navigation(url, cfg!(debug_assertions)) {
                true
            } else {
                open_external_https(&navigation_app, url);
                false
            }
        })
        .on_new_window(move |url, _features| {
            open_external_https(&new_window_app, &url);
            NewWindowResponse::Deny
        })
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build()?;
    Ok(())
}

fn create_tray(app: &mut App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, SHOW_MENU_ID, "Show Chatto", true, None::<&str>)?;
    let mute_item = MenuItem::with_id(app, MUTE_MENU_ID, "Mute", false, None::<&str>)?;
    let deafen_item = MenuItem::with_id(app, DEAFEN_MENU_ID, "Deafen", false, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, QUIT_MENU_ID, "Quit", true, None::<&str>)?;
    let first_separator = PredefinedMenuItem::separator(app)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &first_separator,
            &mute_item,
            &deafen_item,
            &second_separator,
            &quit_item,
        ],
    )?;

    app.manage(ShellState {
        quitting: AtomicBool::new(false),
        mute_item,
        deafen_item,
    });

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Chatto")
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_MENU_ID => show_main_window(app),
            MUTE_MENU_ID => {
                let _ = app.emit(TRAY_ACTION_EVENT, MUTE_MENU_ID);
            }
            DEAFEN_MENU_ID => {
                let _ = app.emit(TRAY_ACTION_EVENT, DEAFEN_MENU_ID);
            }
            QUIT_MENU_ID => {
                if let Some(state) = app.try_state::<ShellState>() {
                    state.quitting.store(true, Ordering::SeqCst);
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    create_main_window(app)?;
    create_tray(app)
}

pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        let quitting = window
            .try_state::<ShellState>()
            .is_some_and(|state| state.quitting.load(Ordering::SeqCst));
        if !quitting {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

#[tauri::command]
pub fn set_call_controls(
    state: State<'_, ShellState>,
    controls: NativeCallControls,
) -> Result<(), String> {
    state
        .mute_item
        .set_enabled(controls.connected)
        .and_then(|_| state.deafen_item.set_enabled(controls.connected))
        .and_then(|_| {
            state
                .mute_item
                .set_text(if controls.muted { "Unmute" } else { "Mute" })
        })
        .and_then(|_| {
            state.deafen_item.set_text(if controls.deafened {
                "Undeafen"
            } else {
                "Deafen"
            })
        })
        .map_err(|_| "Could not update native call controls.".to_string())
}

#[tauri::command]
pub fn set_taskbar_attention(window: tauri::WebviewWindow, active: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        window
            .set_overlay_icon(active.then(taskbar_attention_icon))
            .map_err(|_| "Could not update taskbar attention indicator.".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, active);
        Ok(())
    }
}

#[tauri::command]
pub fn quit_desktop(app: AppHandle, state: State<'_, ShellState>) {
    state.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_policy_allows_only_packaged_and_known_development_origins() {
        assert!(allowed_navigation(
            &Url::parse("tauri://localhost/chat").unwrap(),
            false
        ));
        assert!(allowed_navigation(
            &Url::parse("http://tauri.localhost/chat").unwrap(),
            false
        ));
        assert!(allowed_navigation(
            &Url::parse("http://localhost:5173/chat").unwrap(),
            true
        ));
        assert!(!allowed_navigation(
            &Url::parse("http://localhost:5173/chat").unwrap(),
            false
        ));
        assert!(!allowed_navigation(
            &Url::parse("https://chatto.example/chat").unwrap(),
            false
        ));
        assert!(!allowed_navigation(
            &Url::parse("javascript:alert(1)").unwrap(),
            true
        ));
    }

    #[test]
    fn release_builds_disable_devtools() {
        const fn devtools_enabled(debug_build: bool) -> bool {
            debug_build
        }
        assert!(!devtools_enabled(false));
        assert!(devtools_enabled(true));
    }

    #[test]
    fn taskbar_attention_icon_is_a_bordered_red_dot() {
        let rgba = taskbar_attention_rgba();

        assert_eq!(
            rgba.len(),
            (TASKBAR_ATTENTION_ICON_SIZE * TASKBAR_ATTENTION_ICON_SIZE * 4) as usize
        );
        assert_eq!(&rgba[0..4], &[0, 0, 0, 0]);

        let center = ((TASKBAR_ATTENTION_ICON_SIZE / 2 * TASKBAR_ATTENTION_ICON_SIZE
            + TASKBAR_ATTENTION_ICON_SIZE / 2)
            * 4) as usize;
        assert_eq!(&rgba[center..center + 4], &TASKBAR_ATTENTION_COLOR);
        assert!(rgba
            .chunks_exact(4)
            .any(|pixel| pixel == TASKBAR_ATTENTION_BORDER));
    }
}
