import { invoke } from "@tauri-apps/api/core";
import type { CleanupSessionActivity } from "../stores/sessionNameStore";

export interface CleanupFile {
  relativePath: string;
  bytes: number;
  modifiedMs: number;
  identity: string;
}

export interface CleanupFileScan {
  files: CleanupFile[];
  errors: string[];
}

export interface CleanupFileResult {
  removedCount: number;
  removedBytes: number;
  skippedCount: number;
  errors: string[];
}

export function scanAppCleanup(): Promise<CleanupFileScan> {
  return invoke("scan_app_cleanup");
}

export function cleanAppCleanup(files: CleanupFile[]): Promise<CleanupFileResult> {
  return invoke("clean_app_cleanup", { files });
}

export function getCleanupSessionActivity(sessionIds: string[]): Promise<CleanupSessionActivity[]> {
  return invoke("get_cleanup_session_activity", { sessionIds });
}
