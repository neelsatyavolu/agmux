/**
 * Cowork has its own folder list — not the agent-mode project sidebar.
 * Starts empty; the user adds directories. Desktop Claude / ChatGPT Work
 * sessions then attach to those folders by path.
 */

import { useSyncExternalStore } from "react";
import { useProjectStore } from "../stores/projectStore";
import type { Project } from "./types";

const KEY = "agmux-cowork-folders";

export interface CoworkFolder {
  path: string;
  name: string;
}

type Listener = () => void;

function norm(path: string): string {
  return path.replace(/\/+$/, "");
}

function basename(path: string): string {
  return norm(path).split("/").filter(Boolean).pop() || path;
}

function load(): CoworkFolder[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: CoworkFolder[] = [];
    const seen = new Set<string>();
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const path = typeof (row as CoworkFolder).path === "string" ? norm((row as CoworkFolder).path) : "";
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const name =
        typeof (row as CoworkFolder).name === "string" && (row as CoworkFolder).name.trim()
          ? (row as CoworkFolder).name.trim()
          : basename(path);
      out.push({ path, name });
    }
    return out;
  } catch {
    return [];
  }
}

let folders: CoworkFolder[] = load();
const listeners = new Set<Listener>();

function emit(): void {
  localStorage.setItem(KEY, JSON.stringify(folders));
  for (const fn of listeners) fn();
}

export function getCoworkFolders(): CoworkFolder[] {
  return folders;
}

export function subscribeCoworkFolders(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useCoworkFolders(): CoworkFolder[] {
  return useSyncExternalStore(subscribeCoworkFolders, getCoworkFolders, getCoworkFolders);
}

/** Session path is this folder or a child of it — not the other way around. */
export function sessionBelongsToFolder(sessionPath: string, folderPath: string): boolean {
  const a = norm(sessionPath);
  const b = norm(folderPath);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`);
}

export function addCoworkFolder(path: string, name?: string): CoworkFolder {
  const trimmed = norm(path);
  const existing = folders.find((f) => f.path === trimmed);
  if (existing) return existing;
  const folder: CoworkFolder = { path: trimmed, name: (name ?? "").trim() || basename(trimmed) };
  folders = [...folders, folder];
  emit();
  return folder;
}

export function removeCoworkFolder(path: string): void {
  const trimmed = norm(path);
  const next = folders.filter((f) => f.path !== trimmed);
  if (next.length === folders.length) return;
  folders = next;
  emit();
}

export function renameCoworkFolder(path: string, name: string): void {
  const trimmed = norm(path);
  const label = name.trim();
  if (!label) return;
  folders = folders.map((f) => (f.path === trimmed ? { ...f, name: label } : f));
  emit();
}

export function rewriteCoworkFolderPath(from: string, to: string): void {
  const a = norm(from);
  const b = norm(to);
  if (!a || !b || a === b) return;
  let changed = false;
  folders = folders.map((f) => {
    if (f.path !== a) return f;
    changed = true;
    return { ...f, path: b };
  });
  if (changed) emit();
}

export function reorderCoworkFolders(orderedPaths: string[]): void {
  const by = new Map(folders.map((f) => [f.path, f]));
  const next: CoworkFolder[] = [];
  const seen = new Set<string>();
  for (const raw of orderedPaths) {
    const f = by.get(norm(raw));
    if (!f || seen.has(f.path)) continue;
    next.push(f);
    seen.add(f.path);
  }
  for (const f of folders) {
    if (!seen.has(f.path)) next.push(f);
  }
  folders = next;
  emit();
}



export function filterProjectsForCowork<T extends { repo_path: string }>(
  projects: T[],
  list: CoworkFolder[] = folders,
): T[] {
  if (list.length === 0) return [];
  const order = new Map(list.map((f, i) => [f.path, i]));
  return projects
    .filter((p) => order.has(norm(p.repo_path)))
    .sort((a, b) => (order.get(norm(a.repo_path)) ?? 0) - (order.get(norm(b.repo_path)) ?? 0));
}

/** Add a folder to Cowork and ensure an agmux project exists for new chats. */
export async function addCoworkFolderAndProject(path: string): Promise<Project | null> {
  const folder = addCoworkFolder(path);
  const existing = useProjectStore.getState().projects.find((p) => norm(p.repo_path) === folder.path);
  if (existing) {
    if (existing.name !== folder.name) {
      renameCoworkFolder(folder.path, existing.name);
    }
    return existing;
  }
  try {
    return await useProjectStore.getState().addProject(folder.name, folder.path);
  } catch (err) {
    console.error("Failed to add cowork folder project:", err);
    return null;
  }
}

/** Test-only. */
export function resetCoworkFoldersForTests(next: CoworkFolder[] = []): void {
  folders = next.map((f) => ({ path: norm(f.path), name: f.name.trim() || basename(f.path) }));
  emit();
}
