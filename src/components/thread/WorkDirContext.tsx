import { createContext, useContext, type ReactNode } from "react";

const WorkDirContext = createContext<string | null>(null);

/** Provides session cwd so tool rows can show project-relative paths. */
export function WorkDirProvider({
  workDir,
  children,
}: {
  workDir: string | null | undefined;
  children: ReactNode;
}) {
  const value = workDir && workDir !== "/" ? workDir : null;
  return <WorkDirContext.Provider value={value}>{children}</WorkDirContext.Provider>;
}

export function useWorkDir(): string | null {
  return useContext(WorkDirContext);
}
