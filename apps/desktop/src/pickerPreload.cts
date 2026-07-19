/// <reference lib="dom" />
const { ipcRenderer } = require("electron") as typeof import("electron");

type PickerSource = {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
};

type ScreenShareLabels = {
  title: string;
  subtitle: string;
  audioShared: string;
  audioUnavailable: string;
  cancel: string;
};

type PickerData = {
  sources: PickerSource[];
  audioRequested: boolean;
  labels: ScreenShareLabels;
};

// English fallback if a label is ever missing; the shell normally supplies a
// fully-populated, translated set (see screenCapture.ts).
const FALLBACK_LABELS: ScreenShareLabels = {
  title: "Choose what to share",
  subtitle: "Select a screen or application window to share.",
  audioShared: "System audio will be shared along with the screen.",
  audioUnavailable: "System audio sharing is available on Windows only.",
  cancel: "Cancel",
};

function label(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

// The window loads a script-less document (see screenPicker.ts), so this
// sandboxed preload owns all rendering and messaging. It never injects markup
// from source names; every value goes through textContent or a validated
// data-URL image, so a hostile window title cannot become DOM.

function choose(id: string): void {
  ipcRenderer.send("chatto-picker:choose", id);
}

function cancel(): void {
  ipcRenderer.send("chatto-picker:cancel");
}

function dataImage(dataUrl: string, className: string): HTMLImageElement | null {
  if (!dataUrl.startsWith("data:image/")) return null;
  const image = document.createElement("img");
  image.src = dataUrl;
  image.alt = "";
  image.className = className;
  return image;
}

function styleRoot(root: HTMLElement): void {
  const s = document.body.style;
  s.margin = "0";
  s.fontFamily =
    "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  s.background = "#1e1f22";
  s.color = "#e6e6e9";
  s.userSelect = "none";
  const r = root.style;
  r.display = "flex";
  r.flexDirection = "column";
  r.height = "100vh";
  r.boxSizing = "border-box";
  r.padding = "20px";
  r.gap = "14px";
}

function buildSourceButton(source: PickerSource): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  const b = button.style;
  b.display = "flex";
  b.flexDirection = "column";
  b.overflow = "hidden";
  b.padding = "0";
  b.cursor = "pointer";
  b.textAlign = "left";
  b.borderRadius = "10px";
  b.border = "1px solid #3a3c42";
  b.background = "#2b2d31";
  b.color = "inherit";
  button.addEventListener("mouseenter", () => (b.borderColor = "#5865f2"));
  button.addEventListener("mouseleave", () => (b.borderColor = "#3a3c42"));
  button.addEventListener("focus", () => (b.outline = "2px solid #5865f2"));
  button.addEventListener("blur", () => (b.outline = "none"));
  button.addEventListener("click", () => choose(source.id));

  const thumb = dataImage(source.thumbnailDataUrl, "");
  if (thumb) {
    const t = thumb.style;
    t.width = "100%";
    t.aspectRatio = "16 / 9";
    t.objectFit = "contain";
    t.background = "#131417";
    button.appendChild(thumb);
  }

  const label = document.createElement("span");
  const l = label.style;
  l.display = "flex";
  l.alignItems = "center";
  l.gap = "8px";
  l.padding = "8px 10px";
  l.fontSize = "12px";
  l.minWidth = "0";

  const icon = source.appIconDataUrl
    ? dataImage(source.appIconDataUrl, "")
    : null;
  if (icon) {
    const i = icon.style;
    i.width = "16px";
    i.height = "16px";
    i.flex = "0 0 auto";
    label.appendChild(icon);
  }

  const name = document.createElement("span");
  name.textContent = source.name;
  const n = name.style;
  n.overflow = "hidden";
  n.textOverflow = "ellipsis";
  n.whiteSpace = "nowrap";
  label.appendChild(name);

  button.appendChild(label);
  button.title = source.name;
  return button;
}

function render(data: PickerData): void {
  const labels = data.labels ?? FALLBACK_LABELS;
  const root = document.createElement("div");
  styleRoot(root);

  const title = document.createElement("h1");
  title.textContent = label(labels.title, FALLBACK_LABELS.title);
  title.style.margin = "0";
  title.style.fontSize = "16px";
  title.style.fontWeight = "600";
  root.appendChild(title);

  const subtitle = document.createElement("p");
  subtitle.textContent = label(labels.subtitle, FALLBACK_LABELS.subtitle);
  subtitle.style.margin = "0";
  subtitle.style.fontSize = "13px";
  subtitle.style.color = "#a8aab0";
  root.appendChild(subtitle);

  if (data.audioRequested) {
    const notice = document.createElement("p");
    notice.textContent =
      process.platform === "win32"
        ? label(labels.audioShared, FALLBACK_LABELS.audioShared)
        : label(labels.audioUnavailable, FALLBACK_LABELS.audioUnavailable);
    notice.style.margin = "0";
    notice.style.fontSize = "12px";
    notice.style.color = "#e5c07b";
    root.appendChild(notice);
  }

  const grid = document.createElement("div");
  const g = grid.style;
  g.display = "grid";
  g.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
  g.gap = "12px";
  g.overflowY = "auto";
  g.flex = "1 1 auto";
  g.minHeight = "0";
  g.paddingRight = "4px";
  for (const source of data.sources) grid.appendChild(buildSourceButton(source));
  root.appendChild(grid);

  const footer = document.createElement("div");
  footer.style.display = "flex";
  footer.style.justifyContent = "flex-end";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = label(labels.cancel, FALLBACK_LABELS.cancel);
  const c = cancelButton.style;
  c.cursor = "pointer";
  c.padding = "8px 16px";
  c.borderRadius = "8px";
  c.border = "1px solid #3a3c42";
  c.background = "#2b2d31";
  c.color = "inherit";
  c.fontSize = "13px";
  cancelButton.addEventListener("click", () => cancel());
  footer.appendChild(cancelButton);
  root.appendChild(footer);

  document.body.replaceChildren(root);
}

async function start(): Promise<void> {
  const data = (await ipcRenderer.invoke(
    "chatto-picker:sources",
  )) as PickerData | null;
  if (!data || data.sources.length === 0) {
    cancel();
    return;
  }
  render(data);
}

window.addEventListener("DOMContentLoaded", () => void start());
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") cancel();
});
