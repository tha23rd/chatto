import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";
import path from "node:path";

/** Harden the packaged Electron executable after Electron Builder lays it out. */
export default async function afterPack(context) {
  const targetPlatform = context.electronPlatformName;
  const executableName =
    targetPlatform === "linux"
      ? context.packager.executableName
      : context.packager.appInfo.productFilename;
  const executablePath = path.join(
    context.appOutDir,
    targetPlatform === "darwin"
      ? `${executableName}.app/Contents/MacOS/${executableName}`
      : `${executableName}${targetPlatform === "win32" ? ".exe" : ""}`,
  );

  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
}
