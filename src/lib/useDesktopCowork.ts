import { useEffect, useMemo, useState } from "react";
import type { ClaudeDesktopCoworkSession, CodexWorkDesktopSession } from "./commands";
import {
  desktopClaudeForProject,
  desktopCodexForProject,
  prepareCoworkLists,
} from "./desktopCowork";
import { filterProjectsForCowork, useCoworkFolders } from "./coworkFolders";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";

const EMPTY_CLAUDE: ClaudeDesktopCoworkSession[] = [];
const EMPTY_CODEX: CodexWorkDesktopSession[] = [];

/** Load Desktop Cowork / ChatGPT Work lists while Cowork mode is on. */
export function useDesktopCowork() {
  const appMode = useUiStore((s) => s.appMode);
  const projects = useProjectStore((s) => s.projects);
  const coworkFolders = useCoworkFolders();
  const coworkProjects = useMemo(
    () => filterProjectsForCowork(projects, coworkFolders),
    [projects, coworkFolders],
  );
  const [claude, setClaude] = useState<ClaudeDesktopCoworkSession[]>(EMPTY_CLAUDE);
  const [codex, setCodex] = useState<CodexWorkDesktopSession[]>(EMPTY_CODEX);

  useEffect(() => {
    if (appMode !== "cowork") {
      setClaude(EMPTY_CLAUDE);
      setCodex(EMPTY_CODEX);
      return;
    }
    let cancelled = false;
    const load = async (refresh = false) => {
      const lists = await prepareCoworkLists({ refresh });
      if (cancelled) return;
      setClaude(lists.claude);
      setCodex(lists.codex);
    };
    void load();
    const onRefresh = () => {
      void load(true);
    };
    window.addEventListener("xanom:refresh-desktop-cowork", onRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener("xanom:refresh-desktop-cowork", onRefresh);
    };
  }, [appMode]);

  const claudeByProject = useMemo(() => {
    const map: Record<string, ClaudeDesktopCoworkSession[]> = {};
    for (const p of coworkProjects) {
      map[p.id] = desktopClaudeForProject(claude, p, coworkProjects);
    }
    return map;
  }, [claude, coworkProjects]);

  const codexByProject = useMemo(() => {
    const map: Record<string, CodexWorkDesktopSession[]> = {};
    for (const p of coworkProjects) {
      map[p.id] = desktopCodexForProject(codex, p, coworkProjects);
    }
    return map;
  }, [codex, coworkProjects]);

  return { claudeByProject, codexByProject, coworkProjects };
}
