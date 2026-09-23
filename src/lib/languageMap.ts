import type { LanguageSupport } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";

export function getLanguageExtension(filePath: string): LanguageSupport | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

  switch (ext) {
    case "ts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });

    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: true });

    case "json":
    case "jsonc":
      return json();

    case "md":
    case "mdx":
      return markdown();

    case "css":
    case "scss":
    case "less":
      return css();

    case "html":
    case "htm":
    case "svg":
    case "xml":
    case "xhtml":
      return html();

    case "rs":
      return rust();

    case "py":
    case "pyw":
      return python();

    case "sql":
      return sql();

    case "go":
      return go();

    case "java":
      return java();

    case "c":
    case "cpp":
    case "cc":
    case "cxx":
    case "h":
    case "hpp":
    case "hxx":
      return cpp();

    default:
      return null;
  }
}
