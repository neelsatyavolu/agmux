import { invoke } from "@tauri-apps/api/core";

export interface DebugStatus {
  enabled: boolean;
  recordCount: number;
  lastError: string | null;
}
export const getDebugStatus = () => invoke<DebugStatus>("debug_status");
export const setDebugEnabled = (enabled: boolean) => invoke<DebugStatus>("debug_set_enabled", { enabled });
