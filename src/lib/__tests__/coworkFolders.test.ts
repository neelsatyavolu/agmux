import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLocalStorage } from "./_localStorage";
import {
  addCoworkFolder,
  filterProjectsForCowork,
  getCoworkFolders,
  removeCoworkFolder,
  renameCoworkFolder,
  reorderCoworkFolders,
  resetCoworkFoldersForTests,
  rewriteCoworkFolderPath,
  sessionBelongsToFolder,
} from "../coworkFolders";
import type { Project } from "../types";

beforeEach(() => {
  installLocalStorage();
  resetCoworkFoldersForTests([]);
});

afterEach(() => {
  resetCoworkFoldersForTests([]);
});

describe("coworkFolders", () => {
  it("starts empty and adds unique folders", () => {
    expect(getCoworkFolders()).toEqual([]);
    addCoworkFolder("/Users/neel/Colleges/");
    addCoworkFolder("/Users/neel/Colleges");
    expect(getCoworkFolders()).toEqual([{ path: "/Users/neel/Colleges", name: "Colleges" }]);
  });

  it("matches a session to its folder or a child path, not a parent", () => {
    expect(sessionBelongsToFolder("/Users/neel/Colleges", "/Users/neel/Colleges")).toBe(true);
    expect(sessionBelongsToFolder("/Users/neel/Colleges/essays", "/Users/neel/Colleges")).toBe(true);
    expect(sessionBelongsToFolder("/Users/neel", "/Users/neel/Colleges")).toBe(false);
    expect(sessionBelongsToFolder("/Users/neel/Documents", "/Users/neel/Colleges")).toBe(false);
  });

  it("filters projects to cowork folders in add order", () => {
    addCoworkFolder("/b", "Bee");
    addCoworkFolder("/a", "Aye");
    const projects: Project[] = [
      { id: "1", name: "Aye", repo_path: "/a", conventions: "", created_at: "" },
      { id: "2", name: "Zed", repo_path: "/z", conventions: "", created_at: "" },
      { id: "3", name: "Bee", repo_path: "/b", conventions: "", created_at: "" },
    ];
    expect(filterProjectsForCowork(projects).map((p) => p.id)).toEqual(["3", "1"]);
  });

  it("renames and removes without touching other folders", () => {
    addCoworkFolder("/Users/neel/Colleges");
    addCoworkFolder("/Users/neel/Chief of Staff");
    renameCoworkFolder("/Users/neel/Colleges", "College essays");
    removeCoworkFolder("/Users/neel/Chief of Staff");
    expect(getCoworkFolders()).toEqual([
      { path: "/Users/neel/Colleges", name: "College essays" },
    ]);
  });

  it("rewrites a folder path in place", () => {
    addCoworkFolder("/old");
    addCoworkFolder("/keep");
    rewriteCoworkFolderPath("/old", "/new");
    expect(getCoworkFolders().map((f) => f.path)).toEqual(["/new", "/keep"]);
  });

  it("reorders folders by the given path list", () => {
    addCoworkFolder("/a");
    addCoworkFolder("/b");
    addCoworkFolder("/c");
    reorderCoworkFolders(["/c", "/a", "/b"]);
    expect(getCoworkFolders().map((f) => f.path)).toEqual(["/c", "/a", "/b"]);
  });
});
