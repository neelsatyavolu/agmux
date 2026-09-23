export interface PatchHunk {
  filePath: string;
  oldContent: string;
  newContent: string;
}

export interface PatchSummary {
  filePaths: string[];
  additions: number;
  deletions: number;
}

export function isUnifiedPatch(text: string): boolean {
  return /^---\s+\S/m.test(text) && /^\+\+\+\s+\S/m.test(text) && /^@@\s+-\d/m.test(text);
}

export function isApplyPatch(text: string): boolean {
  return /^\*\*\* Begin Patch$/m.test(text) && /^\*\*\* (Update|Add|Delete) File:\s+/m.test(text);
}

export function isPatchText(text: string): boolean {
  return isUnifiedPatch(text) || isApplyPatch(text);
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "").trim();
}

function splitPatchLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function parseSingleFile(headerLine: string, lines: string[], start: number, end: number): PatchHunk {
  const filePath = stripPrefix(headerLine);
  const oldParts: string[] = [];
  const newParts: string[] = [];

  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (line.startsWith("@@")) continue;
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith("Binary files")) continue;

    if (line.startsWith("-")) {
      oldParts.push(line.slice(1));
    } else if (line.startsWith("+")) {
      newParts.push(line.slice(1));
    } else {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      oldParts.push(content);
      newParts.push(content);
    }
  }

  return {
    filePath,
    oldContent: oldParts.join("\n"),
    newContent: newParts.join("\n"),
  };
}

export function parseUnifiedPatch(patchText: string): PatchHunk[] {
  try {
    const lines = splitPatchLines(patchText);
    const hunks: PatchHunk[] = [];

    let plusPath: string | null = null;
    let bodyStart = -1;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (line.startsWith("--- ")) {
        const nextLine = lines[i + 1] ?? "";
        if (nextLine.startsWith("+++ ")) {
          if (plusPath !== null && bodyStart !== -1) {
            hunks.push(parseSingleFile(plusPath, lines, bodyStart, i));
          }
          plusPath = stripPrefix(nextLine.slice(4));
          bodyStart = i + 2;
          i += 2;
          continue;
        }
      }

      i++;
    }

    if (plusPath !== null && bodyStart !== -1) {
      hunks.push(parseSingleFile(plusPath, lines, bodyStart, lines.length));
    }

    if (hunks.length === 0) {
      return [{ filePath: "", oldContent: patchText, newContent: patchText }];
    }

    return hunks;
  } catch {
    return [{ filePath: "", oldContent: patchText, newContent: patchText }];
  }
}

type ApplyPatchKind = "update" | "add" | "delete";

function parseApplyPatchFile(
  kind: ApplyPatchKind,
  filePath: string,
  lines: string[],
  start: number,
  end: number,
): PatchHunk {
  const normalizedPath = stripPrefix(filePath);
  const oldParts: string[] = [];
  const newParts: string[] = [];

  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (
      line.startsWith("@@") ||
      line === "*** End of File" ||
      line.startsWith("*** Move to:") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }

    if (kind === "add") {
      if (line.startsWith("+")) {
        newParts.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        newParts.push(line.slice(1));
      }
      continue;
    }

    if (kind === "delete") {
      if (line.startsWith("-")) {
        oldParts.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        oldParts.push(line.slice(1));
      }
      continue;
    }

    if (line.startsWith("-")) {
      oldParts.push(line.slice(1));
    } else if (line.startsWith("+")) {
      newParts.push(line.slice(1));
    } else {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      oldParts.push(content);
      newParts.push(content);
    }
  }

  return {
    filePath: normalizedPath,
    oldContent: oldParts.join("\n"),
    newContent: newParts.join("\n"),
  };
}

export function parseApplyPatch(patchText: string): PatchHunk[] {
  try {
    const lines = splitPatchLines(patchText);
    const hunks: PatchHunk[] = [];
    let currentKind: ApplyPatchKind | null = null;
    let currentPath = "";
    let bodyStart = -1;

    const pushCurrent = (end: number) => {
      if (!currentKind || bodyStart === -1) {
        return;
      }
      hunks.push(parseApplyPatchFile(currentKind, currentPath, lines, bodyStart, end));
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fileMatch = line.match(/^\*\*\* (Update|Add|Delete) File:\s+(.+)$/);
      if (fileMatch) {
        pushCurrent(i);
        currentKind = fileMatch[1].toLowerCase() as ApplyPatchKind;
        currentPath = fileMatch[2];
        bodyStart = i + 1;
        continue;
      }

      const moveMatch = line.match(/^\*\*\* Move to:\s+(.+)$/);
      if (moveMatch && currentKind === "update") {
        currentPath = moveMatch[1];
        continue;
      }

      if (line === "*** End Patch") {
        pushCurrent(i);
        currentKind = null;
        bodyStart = -1;
        break;
      }
    }

    if (currentKind && bodyStart !== -1) {
      pushCurrent(lines.length);
    }

    if (hunks.length === 0) {
      return [{ filePath: "", oldContent: patchText, newContent: patchText }];
    }

    return hunks;
  } catch {
    return [{ filePath: "", oldContent: patchText, newContent: patchText }];
  }
}

export function parsePatchText(patchText: string): PatchHunk[] {
  if (isApplyPatch(patchText)) {
    return parseApplyPatch(patchText);
  }
  return parseUnifiedPatch(patchText);
}

export function summarizePatchText(patchText: string): PatchSummary | null {
  if (!isPatchText(patchText)) {
    return null;
  }

  const filePaths = Array.from(
    new Set(
      parsePatchText(patchText)
        .map((hunk) => hunk.filePath)
        .filter((path) => path.length > 0),
    ),
  );

  let additions = 0;
  let deletions = 0;
  for (const line of splitPatchLines(patchText)) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { filePaths, additions, deletions };
}
