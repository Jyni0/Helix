/**
 * "Is there a newer Helix?" — answered from the repository's latest GitHub
 * release, by version number: a build of the newest release is up to date no
 * matter what was pushed to main since. Updating downloads that release's
 * installer for this computer and runs it; nothing is built locally.
 * (The update system of Helix.)
 */
import { create } from "zustand";
import { api, errorMessage, isTauri } from "@/lib/api";
import { plural } from "@/lib/format";
import { openTransactions } from "./editors";
import { toast, useUi } from "./ui";

export const APP_VERSION = __APP_VERSION__;
export const BUILD_SHA = __BUILD_SHA__;
export const REPO = __REPO__;

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  /** "sha256:…" published by GitHub; the download is checked against it. */
  digest: string | null;
}

export interface UpdateInfo {
  version: string;
  /** Release title, or the tag. */
  title: string;
  notes: string;
  /** The release page. */
  page: string;
  publishedAt: string;
  /** The installer for this computer; null when the release has none. */
  asset: ReleaseAsset | null;
  /** "Windows" / "macOS" / "Linux", for messages. */
  platform: string;
}

type Status = "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error";

interface UpdatesState {
  status: Status;
  info: UpdateInfo | null;
  error: string | null;
  checkedAt: number | null;
  progress: { received: number; total: number | null } | null;

  check(manual?: boolean): Promise<void>;
  /** Downloads the release installer and runs it. */
  install(): Promise<void>;
}

/** -1 / 0 / 1 for dotted versions ("1.10.0" > "1.9.3"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** "Release-1.9.2", "v1.9.2", "Helix 1.9.2" → "1.9.2". */
export function versionOf(...labels: Array<string | null | undefined>): string | null {
  for (const l of labels) {
    const m = l && /(\d+\.\d+(?:\.\d+){0,2})/.exec(l);
    if (m) return m[1];
  }
  return null;
}

/**
 * The installer for an OS / CPU among a release's files: Windows prefers the
 * setup .exe over the .msi; macOS takes a .dmg (universal fits both CPUs);
 * Linux an AppImage, then .deb, then .rpm.
 */
export function pickAsset(assets: ReleaseAsset[], os: string, arch: string): ReleaseAsset | null {
  const arm = /aarch64|arm64/i.test(arch);
  const archOf = (n: string) => (/aarch64|arm64/i.test(n) ? "arm" : /x64|x86_64|amd64|x86-64/i.test(n) ? "x64" : /universal/i.test(n) ? "any" : "unknown");
  const fits = (n: string) => {
    const a = archOf(n);
    return a === "any" || a === "unknown" || a === (arm ? "arm" : "x64");
  };
  const kinds: RegExp[] = os === "windows" ? [/-setup\.exe$/i, /\.exe$/i, /\.msi$/i] : os === "macos" ? [/\.dmg$/i] : os === "linux" ? [/\.appimage$/i, /\.deb$/i, /\.rpm$/i] : [];
  for (const kind of kinds) {
    const list = assets.filter((a) => kind.test(a.name) && fits(a.name));
    // An exact CPU match beats universal / unmarked builds.
    const exact = list.find((a) => archOf(a.name) === (arm ? "arm" : "x64"));
    if (exact ?? list[0]) return exact ?? list[0];
  }
  return null;
}

interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string;
  assets: Array<{ name: string; browser_download_url: string; size: number; digest?: string | null }>;
}

const PLATFORM_NAME: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

export const useUpdates = create<UpdatesState>((set, get) => ({
  status: "idle",
  info: null,
  error: null,
  checkedAt: null,
  progress: null,

  async check(manual = false) {
    if (!REPO) {
      if (manual) toast("Update check is not available", "warning", "This build does not know its GitHub repository.");
      return;
    }
    const busy = get().status;
    if (busy === "checking" || busy === "downloading" || busy === "installing") return;
    set({ status: "checking", error: null });
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
      if (res.status === 404) throw new Error("This repository has no releases yet");
      if (res.status === 403 || res.status === 429) throw new Error("GitHub rate limit reached — try again later");
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const r = (await res.json()) as GhRelease;
      const version = versionOf(r.tag_name, r.name);
      if (!version) throw new Error(`Can't read a version from the release "${r.tag_name}"`);
      const { os, arch } = await api.platform();
      const assets = r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest ?? null }));
      const info: UpdateInfo = {
        version,
        title: r.name?.trim() || r.tag_name,
        notes: (r.body ?? "").trim(),
        page: r.html_url,
        publishedAt: r.published_at,
        asset: pickAsset(assets, os, arch),
        platform: PLATFORM_NAME[os] ?? os,
      };
      const available = compareVersions(version, APP_VERSION) > 0;
      set({ status: available ? "available" : "current", info, checkedAt: Date.now() });
      if (manual) {
        if (available) openUpdateDialog();
        else toast("Helix is up to date", "success", `Version ${APP_VERSION} is the latest release.`);
      }
    } catch (e) {
      set({ status: "error", error: errorMessage(e), checkedAt: Date.now() });
      if (manual) toast("Could not check for updates", "error", errorMessage(e));
    }
  },

  async install() {
    const info = get().info;
    if (!info?.asset || get().status === "downloading" || get().status === "installing") return;
    // The installer closes Helix: open transactions would be rolled back.
    const open = openTransactions();
    if (open) {
      const ans = await useUi.getState().ask({
        title: "Update with open transactions?",
        message: `${plural(open, "editor has", "editors have")} an uncommitted transaction. Helix closes while the update installs and those changes are rolled back.`,
        buttons: [
          { id: "update", label: "Roll back & Update", variant: "danger" },
          { id: "cancel", label: "Cancel" },
        ],
        cancelId: "cancel",
      });
      if (ans !== "update") return;
    }
    const asset = info.asset;
    set({ status: "downloading", progress: { received: 0, total: asset.size || null }, error: null });
    try {
      const path = await api.updateDownload(asset.url, asset.name, asset.digest, (received, total) => set({ progress: { received, total: total ?? (asset.size || null) } }));
      set({ status: "installing" });
      await api.updateInstall(path);
      if (info.platform === "Windows") toast(`Installing Helix ${info.version}…`, "info", "Helix closes now and the installer takes over.");
      else {
        toast(`Helix ${info.version} downloaded`, "success", info.platform === "macOS" ? "Drag Helix into Applications, replacing the old one, then reopen it." : "Install the opened package, then reopen Helix.");
        set({ status: "available", progress: null });
      }
    } catch (e) {
      set({ status: "available", progress: null, error: errorMessage(e) });
      toast("Update failed", "error", errorMessage(e));
    }
  },
}));

export const useUpdateAvailable = () => useUpdates((s) => s.status === "available" || s.status === "downloading" || s.status === "installing");

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export function openUpdateDialog() {
  const { info } = useUpdates.getState();
  if (!info) return;
  const notes = info.notes.split("\n").slice(0, 14).join("\n");
  void useUi
    .getState()
    .ask({
      title: `Helix ${info.version} is available`,
      message: (
        <div className="flex flex-col gap-2">
          <div className="text-[12.5px] text-[var(--text-muted)]">
            You have {APP_VERSION}.{" "}
            {info.asset ? `The ${info.platform} installer (${mb(info.asset.size)}) downloads and installs — Helix reopens on the new version.` : `This release has no installer for ${info.platform} yet.`}
          </div>
          {notes && <div className="max-h-[220px] overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--bg-input)] p-2.5 text-[12px] text-[var(--text-main)]">{notes}</div>}
        </div>
      ),
      buttons: [
        ...(info.asset ? [{ id: "install", label: "Download & Install", variant: "primary" as const }] : []),
        { id: "page", label: "Release Page", variant: info.asset ? ("secondary" as const) : ("primary" as const) },
        { id: "later", label: "Later" },
      ],
      cancelId: "later",
    })
    .then((answer) => {
      if (answer === "install") void useUpdates.getState().install();
      if (answer === "page") void api.openUrl(info.page);
    });
}

/** On start and every few hours, when enabled. */
export function startUpdateChecks(): () => void {
  if (!isTauri() || import.meta.env.MODE === "test") return () => {};
  const first = setTimeout(() => useUi.getState().prefs.checkForUpdates && void useUpdates.getState().check(), 8000);
  const every = setInterval(() => useUi.getState().prefs.checkForUpdates && void useUpdates.getState().check(), 6 * 60 * 60 * 1000);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
