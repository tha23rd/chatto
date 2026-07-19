import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { NativeIpc } from "@chatto/native-bridge";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;
const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const mainEntry = path.join(desktopRoot, "dist", "main.js");
const packagedExecutable = process.env.CHATTO_DESKTOP_EXECUTABLE
  ? path.resolve(process.env.CHATTO_DESKTOP_EXECUTABLE)
  : null;
const applicationExecutable = packagedExecutable ?? electronExecutable;

const expectedBridgeKeys = [
  "allowServerOriginForProbe",
  "checkForUpdates",
  "flashFrame",
  "getLaunchOnStartup",
  "getUpdateState",
  "installUpdate",
  "onDeepLink",
  "onNotificationAction",
  "onOAuthCallback",
  "onPushToTalk",
  "onTrayAction",
  "onUpdateState",
  "openExternalAuth",
  "platform",
  "prepareOAuthFlow",
  "registerPushToTalk",
  "rendererReady",
  "setBadgeCount",
  "setLaunchOnStartup",
  "setRegisteredServerOrigins",
  "setScreenShareLabels",
  "setTrayState",
  "showNotification",
].sort();

test("runs the hardened shell, bridge events, and single-instance links", async () => {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chatto-desktop-smoke-"),
  );
  const remoteServer = await startRemoteServer();
  const linkedServer = "https://chat.example.test";
  const deepLink = `chatto://join?server=${encodeURIComponent(linkedServer)}`;
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...testEnvironment } = process.env;
  void _runAsNode;
  let application: Awaited<ReturnType<typeof electron.launch>> | null = null;

  try {
    application = await electron.launch({
      executablePath: applicationExecutable,
      args: launchArguments(userDataDirectory, deepLink),
      cwd: desktopRoot,
      env: {
        ...testEnvironment,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    });
    const page = await application.firstWindow();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.waitForLoadState("domcontentloaded");
    // The window frame is the native OS chrome (no in-renderer controls), so the
    // deep link opening the Add Server dialog with the prefilled URL is the first
    // observable signal that the renderer booted and the bridge delivered it.
    await expect(page.getByLabel("Server URL")).toHaveValue(linkedServer);

    const remoteTransport = await page.evaluate(async (serverOrigin) => {
      const nativeClient = window.chattoNative;
      if (!nativeClient) throw new Error("Native bridge is unavailable");

      async function rejectedByCors(pathname: string): Promise<boolean> {
        try {
          await fetch(`${serverOrigin}${pathname}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          return false;
        } catch {
          return true;
        }
      }

      const unregisteredRejected = await rejectedByCors("/private");
      nativeClient.allowServerOriginForProbe(serverOrigin);
      const discoveryResponse = await fetch(
        `${serverOrigin}/api/connect/chatto.discovery.v1.ServerDiscoveryService/GetServer`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Connect-Protocol-Version": "1",
            "Content-Type": "application/json",
          },
          body: "{}",
        },
      );
      const discovery = await discoveryResponse.text();
      const probePrivateRejected = await rejectedByCors("/private");

      await nativeClient.prepareOAuthFlow({
        serverOrigin,
        callbackLabels: { title: "Complete", message: "Return to Chatto." },
      });
      const tokenResponse = await fetch(`${serverOrigin}/oauth/token`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const token = await tokenResponse.text();
      const oauthPrivateRejected = await rejectedByCors("/private");

      nativeClient.setRegisteredServerOrigins([serverOrigin]);
      const registeredResponse = await fetch(`${serverOrigin}/private`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const registered = await registeredResponse.text();

      const streamResponse = await fetch(
        `${serverOrigin}/api/connect/chatto.smoke.v1.StreamService/Watch`,
        {
          method: "POST",
          headers: {
            "Connect-Protocol-Version": "1",
            "Content-Type": "application/connect+json",
          },
          body: "{}",
        },
      );
      const reader = streamResponse.body?.getReader();
      const decoder = new TextDecoder();
      let streamed = "";
      if (!reader) throw new Error("Streaming response body is unavailable");
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        streamed += decoder.decode(result.value, { stream: true });
      }
      streamed += decoder.decode();

      const websocketMessage = await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(
          `${serverOrigin.replace(/^http/, "ws")}/realtime`,
        );
        const timeout = window.setTimeout(
          () => reject(new Error("WebSocket smoke test timed out")),
          5_000,
        );
        socket.addEventListener("message", (event) => {
          window.clearTimeout(timeout);
          resolve(String(event.data));
          socket.close();
        });
        socket.addEventListener("error", () => {
          window.clearTimeout(timeout);
          reject(new Error("WebSocket smoke test failed"));
        });
      });

      let serviceWorkerDisabled = !("serviceWorker" in navigator);
      if (!serviceWorkerDisabled) {
        try {
          await navigator.serviceWorker.register("/service-worker.js");
        } catch {
          serviceWorkerDisabled = true;
        }
      }

      return {
        discovery,
        oauthPrivateRejected,
        probePrivateRejected,
        registered,
        serviceWorkerDisabled,
        streamed,
        token,
        unregisteredRejected,
        websocketMessage,
      };
    }, remoteServer.origin);
    expect(remoteTransport).toEqual({
      discovery: "discovery-ok",
      oauthPrivateRejected: true,
      probePrivateRejected: true,
      registered: "registered-ok",
      serviceWorkerDisabled: true,
      streamed: "stream-one|stream-two",
      token: "token-ok",
      unregisteredRejected: true,
      websocketMessage: "websocket-ok",
    });
    expect(remoteServer.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "OPTIONS",
          pathname:
            "/api/connect/chatto.discovery.v1.ServerDiscoveryService/GetServer",
          origin: remoteServer.origin,
        }),
        expect.objectContaining({
          method: "POST",
          pathname:
            "/api/connect/chatto.discovery.v1.ServerDiscoveryService/GetServer",
          origin: remoteServer.origin,
        }),
        expect.objectContaining({
          method: "POST",
          pathname: "/oauth/token",
          origin: remoteServer.origin,
        }),
        expect.objectContaining({
          method: "GET",
          pathname: "/realtime",
          origin: remoteServer.origin,
        }),
      ]),
    );

    const pushToTalkRegistration = await page.evaluate(() =>
      window.chattoNative?.registerPushToTalk({ key: "F8" }),
    );
    expect(pushToTalkRegistration).toEqual({ registered: true });

    await page.evaluate(() => {
      const nativeClient = window.chattoNative;
      if (!nativeClient) throw new Error("Native bridge is unavailable");
      const smokeWindow = window as typeof window & {
        __nativeSmokeEvents?: string[];
      };
      smokeWindow.__nativeSmokeEvents = [];
      nativeClient.onTrayAction((action) =>
        smokeWindow.__nativeSmokeEvents?.push(`tray:${action}`),
      );
      nativeClient.onNotificationAction((action) =>
        smokeWindow.__nativeSmokeEvents?.push(`notification:${action.type}`),
      );
      nativeClient.onDeepLink((link) =>
        smokeWindow.__nativeSmokeEvents?.push(
          `deep-link:${link.kind}:${link.serverUrl}`,
        ),
      );
      nativeClient.setTrayState({
        callActive: false,
        muted: false,
        deafened: false,
        unreadCount: 3,
        labels: {
          open: "Open Chatto",
          mute: "Mute",
          unmute: "Unmute",
          deafen: "Deafen",
          undeafen: "Undeafen",
          quit: "Quit",
        },
      });
      nativeClient.setBadgeCount(3, "Notifications");
      nativeClient.showNotification({
        id: "desktop-smoke-notification",
        title: "Desktop smoke test",
        body: "Native notification bridge",
        canReply: true,
        replyPlaceholder: "Reply",
      });
    });
    await application.evaluate(
      ({ BrowserWindow }, channels) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        contents?.send(channels.tray, "open");
        contents?.send(channels.notification, {
          type: "reply",
          id: "desktop-smoke-notification",
          reply: "Smoke reply",
        });
      },
      {
        tray: NativeIpc.TrayAction,
        notification: NativeIpc.NotificationAction,
      },
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __nativeSmokeEvents?: string[] })
              .__nativeSmokeEvents ?? [],
        ),
      )
      .toEqual(["tray:open", "notification:reply"]);

    const secondLinkedServer = "https://second.example.test";
    const secondDeepLink = `chatto://join?server=${encodeURIComponent(secondLinkedServer)}`;
    await application.evaluate(({ app }) => {
      const instrumentedApp = app as typeof app & {
        __desktopSmokeSecondInstance?: {
          argv: string[];
          additionalData: unknown;
        };
      };
      app.on(
        "second-instance",
        (_event, argv, _workingDirectory, additionalData) => {
          instrumentedApp.__desktopSmokeSecondInstance = {
            argv,
            additionalData,
          };
        },
      );
    });
    const secondExitCode = await runSecondInstance(
      launchArguments(userDataDirectory, secondDeepLink),
      testEnvironment,
    );
    expect(secondExitCode).toBe(0);
    const observedSecondInstance = await application.evaluate(({ app }) => {
      const instrumentedApp = app as typeof app & {
        __desktopSmokeSecondInstance?: {
          argv: string[];
          additionalData: unknown;
        };
      };
      return instrumentedApp.__desktopSmokeSecondInstance ?? null;
    });
    expect(observedSecondInstance).not.toBeNull();
    expect(observedSecondInstance?.argv).toContain(secondDeepLink);
    expect(observedSecondInstance?.additionalData).toMatchObject({
      deepLink: secondDeepLink,
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __nativeSmokeEvents?: string[] })
              .__nativeSmokeEvents ?? [],
        ),
      )
      .toContain(`deep-link:join:${secondLinkedServer}`);
    await expect(page.getByLabel("Server URL")).toHaveValue(secondLinkedServer);

    const renderer = await page.evaluate(async () => {
      const nativeWindow = window as typeof window & {
        chattoNative?: {
          getUpdateState(): Promise<{ kind: string }>;
          setRegisteredServerOrigins(origins: string[]): void;
        };
        process?: unknown;
        require?: unknown;
      };
      const shellResponse = await fetch(window.location.href, {
        method: "HEAD",
      });
      const updateState = await nativeWindow.chattoNative?.getUpdateState();

      nativeWindow.chattoNative?.setRegisteredServerOrigins([
        "https://chat.example.test",
      ]);
      let invalidOriginRejected = false;
      try {
        nativeWindow.chattoNative?.setRegisteredServerOrigins([
          "file:///tmp/not-a-server",
        ]);
      } catch {
        invalidOriginRejected = true;
      }

      return {
        origin: window.location.origin,
        bridgeKeys: Object.keys(nativeWindow.chattoNative ?? {}).sort(),
        hasNodeProcess: typeof nativeWindow.process !== "undefined",
        hasNodeRequire: typeof nativeWindow.require !== "undefined",
        // The shell CSP is served report-only (see appProtocol.ts), matching the
        // web frontend, so it rides the report-only header, not the enforcing one.
        contentSecurityPolicy: shellResponse.headers.get(
          "content-security-policy-report-only",
        ),
        updateState: updateState?.kind,
        invalidOriginRejected,
      };
    });

    expect(renderer).toMatchObject({
      origin: "chatto-app://app",
      bridgeKeys: expectedBridgeKeys,
      hasNodeProcess: false,
      hasNodeRequire: false,
      invalidOriginRejected: true,
    });
    expect([
      "idle",
      "checking",
      "not-available",
      "available",
      "downloading",
      "downloaded",
      "error",
    ]).toContain(renderer.updateState);
    expect(renderer.contentSecurityPolicy).toContain(
      "require-trusted-types-for 'script'",
    );

    const mainProcessState = await application.evaluate(
      ({ BrowserWindow, session }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return {
          webPreferences: window?.webContents.getLastWebPreferences(),
          runningServiceWorkerCount: Object.keys(
            session.defaultSession.serviceWorkers.getAllRunning(),
          ).length,
        };
      },
    );
    expect(mainProcessState.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
    expect(mainProcessState.runningServiceWorkerCount).toBe(0);
    expect(pageErrors).toEqual([]);

    const screenshotPath = process.env.CHATTO_DESKTOP_SCREENSHOT;
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
  } finally {
    await application?.close();
    await remoteServer.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});

type ObservedRemoteRequest = {
  method: string;
  pathname: string;
  origin: string | null;
};

async function startRemoteServer(): Promise<{
  close(): Promise<void>;
  origin: string;
  requests: ObservedRemoteRequest[];
}> {
  const requests: ObservedRemoteRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: request.method ?? "",
      pathname: requestUrl.pathname,
      origin: request.headers.origin ?? null,
    });
    request.resume();

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (
      requestUrl.pathname ===
      "/api/connect/chatto.discovery.v1.ServerDiscoveryService/GetServer"
    ) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("discovery-ok");
      return;
    }
    if (requestUrl.pathname === "/oauth/token") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("token-ok");
      return;
    }
    if (
      requestUrl.pathname === "/api/connect/chatto.smoke.v1.StreamService/Watch"
    ) {
      response.writeHead(200, {
        "Content-Type": "application/connect+json",
        "Transfer-Encoding": "chunked",
      });
      response.write("stream-one|");
      setTimeout(() => response.end("stream-two"), 20);
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("registered-ok");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (request, socket) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: request.method ?? "",
      pathname: requestUrl.pathname,
      origin: request.headers.origin ?? null,
    });
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const payload = Buffer.from("websocket-ok");
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    setTimeout(() => socket.end(), 50);
  });

  await listenOnLoopback(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Remote transport smoke server did not bind a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server, sockets),
  };
}

async function listenOnLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(
  server: Server,
  sockets: ReadonlySet<Socket> = new Set(),
): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  for (const socket of sockets) socket.destroy();
  await closed;
}

async function runSecondInstance(
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(applicationExecutable, args, {
      cwd: desktopRoot,
      env: environment,
      stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          "Second desktop process did not yield to the existing instance",
        ),
      );
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function launchArguments(
  userDataDirectory: string,
  deepLink: string,
): string[] {
  return [
    ...(packagedExecutable ? [] : [mainEntry]),
    `--user-data-dir=${userDataDirectory}`,
    "--no-sandbox",
    deepLink,
  ];
}
