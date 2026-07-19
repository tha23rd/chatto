export const protocol = {
  registerSchemesAsPrivileged() {},
  handle() {},
};

export const desktopCapturer = {
  async getSources() {
    return [];
  },
};

export const app = {
  isPackaged: false,
  setBadgeCount() {},
};

export class BrowserWindow {}

export const Menu = {
  buildFromTemplate() {
    return {};
  },
};

export const nativeImage = {
  createFromDataURL() {
    return {};
  },
};

export class Notification {
  static isSupported(): boolean {
    return true;
  }
}

export class Tray {}
