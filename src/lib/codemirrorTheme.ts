import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const monoFontStack =
  '"Geist Mono", "JetBrains Mono", "SF Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace';

const sharedEditorTheme = {
  "&": {
    background: "transparent",
    height: "100%",
    paddingTop: "8px",
    outline: "none",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: monoFontStack,
    fontSize: "13px",
    lineHeight: "20px",
    overflow: "auto",
  },
  ".cm-scroller::-webkit-scrollbar": {
    width: "4px",
    height: "4px",
  },
  ".cm-scroller::-webkit-scrollbar-track": {
    background: "transparent",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    paddingBottom: "12px",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    background: "rgba(247,173,60,0.20)",
  },
  ".cm-gutters": {
    background: "transparent",
    border: "none",
    color: "#52525b",
    fontFamily: monoFontStack,
    fontSize: "10.5px",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 12px 0 8px",
    minWidth: "40px",
  },
  ".cm-matchingBracket": {
    background: "rgba(247,173,60,0.10)",
    outline: "1px solid rgba(247,173,60,0.25)",
  },
  ".cm-nonmatchingBracket": {
    color: "#f87171",
  },
  ".cm-searchMatch": {
    background: "#fbbf2433",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    background: "#fbbf2455",
  },
};

export const xanomDarkEditorTheme = EditorView.theme(
  {
    ...sharedEditorTheme,
    "&": {
      ...sharedEditorTheme["&"],
      color: "#e4e4e7",
    },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      background: "rgba(255, 255, 255, 0.1)",
      borderRadius: "10px",
    },
    ".cm-scroller::-webkit-scrollbar-thumb:hover": {
      background: "rgba(255, 255, 255, 0.2)",
    },
    ".cm-activeLine": {
      background: "#ffffff06",
    },
    ".cm-activeLineGutter": {
      background: "transparent",
      color: "#71717a",
    },
    ".cm-gutters": {
      ...sharedEditorTheme[".cm-gutters"],
      background: "var(--bg-primary, #09090b)",
      borderRight: "1px solid rgba(255,255,255,0.06)",
      color: "#3f3f46",
    },
    ".cm-tooltip": {
      background: "#0c0c0c",
      border: "1px solid #ffffff14",
      borderRadius: "6px",
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li[aria-selected]": {
        background: "#6366f126",
        color: "#e4e4e7",
      },
    },
    ".cm-selectionMatch": {
      background: "#ffffff0a",
    },
    ".cm-indentationMark": {
      borderLeft: "1px solid #ffffff08",
    },
  },
  { dark: true }
);

export const xanomLightEditorTheme = EditorView.theme(
  {
    ...sharedEditorTheme,
    "&": {
      ...sharedEditorTheme["&"],
      color: "#18181b",
    },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      background: "rgba(24, 24, 27, 0.12)",
      borderRadius: "10px",
    },
    ".cm-scroller::-webkit-scrollbar-thumb:hover": {
      background: "rgba(24, 24, 27, 0.22)",
    },
    ".cm-activeLine": {
      background: "rgba(15, 23, 42, 0.035)",
    },
    ".cm-activeLineGutter": {
      background: "transparent",
      color: "#71717a",
    },
    ".cm-gutters": {
      ...sharedEditorTheme[".cm-gutters"],
      background: "var(--bg-primary, #ffffff)",
      borderRight: "1px solid rgba(24,24,27,0.08)",
      color: "var(--text-tertiary)",
    },
    ".cm-tooltip": {
      background: "#ffffff",
      border: "1px solid rgba(24,24,27,0.10)",
      borderRadius: "6px",
      color: "#18181b",
      boxShadow: "0 10px 30px rgba(15, 23, 42, 0.12)",
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li[aria-selected]": {
        background: "#6366f114",
        color: "#18181b",
      },
    },
    ".cm-selectionMatch": {
      background: "rgba(99, 102, 241, 0.08)",
    },
    ".cm-indentationMark": {
      borderLeft: "1px solid rgba(24,24,27,0.08)",
    },
  },
  { dark: false }
);

export const xanomDarkHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "#4a4a55", fontStyle: "italic" },
  { tag: tags.lineComment, color: "#4a4a55", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#4a4a55", fontStyle: "italic" },
  { tag: tags.docComment, color: "#4a4a55", fontStyle: "italic" },

  { tag: tags.keyword, color: "#a5b4fc" },
  { tag: tags.controlKeyword, color: "#a5b4fc" },
  { tag: tags.moduleKeyword, color: "#a5b4fc" },
  { tag: tags.operatorKeyword, color: "#a5b4fc" },
  { tag: tags.definitionKeyword, color: "#a5b4fc" },
  { tag: tags.modifier, color: "#a5b4fc" },

  { tag: tags.string, color: "#6ee7b7" },
  { tag: tags.special(tags.string), color: "#6ee7b7" },

  { tag: tags.number, color: "#fbbf24" },
  { tag: tags.integer, color: "#fbbf24" },
  { tag: tags.float, color: "#fbbf24" },

  { tag: tags.typeName, color: "#7dd3fc" },
  { tag: tags.className, color: "#7dd3fc" },
  { tag: tags.namespace, color: "#7dd3fc" },
  { tag: tags.self, color: "#7dd3fc" },

  { tag: tags.function(tags.variableName), color: "#c4b5fd" },
  { tag: tags.function(tags.propertyName), color: "#c4b5fd" },

  { tag: tags.variableName, color: "#e4e4e7" },
  { tag: tags.propertyName, color: "#e4e4e7" },

  { tag: tags.operator, color: "#a1a1aa" },
  { tag: tags.bracket, color: "#a1a1aa" },
  { tag: tags.punctuation, color: "#71717a" },

  { tag: tags.tagName, color: "#f0abfc" },
  { tag: tags.attributeName, color: "#93c5fd" },
  { tag: tags.attributeValue, color: "#6ee7b7" },

  { tag: tags.regexp, color: "#f9a8d4" },

  { tag: tags.heading, color: "#a5b4fc", fontWeight: "bold" },
  { tag: tags.heading1, color: "#a5b4fc", fontWeight: "bold" },
  { tag: tags.heading2, color: "#a5b4fc", fontWeight: "bold" },
  { tag: tags.heading3, color: "#a5b4fc", fontWeight: "bold" },

  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },

  { tag: tags.link, color: "#93c5fd", textDecoration: "underline" },
  { tag: tags.url, color: "#93c5fd" },

  { tag: tags.bool, color: "#fbbf24" },
  { tag: tags.null, color: "#71717a" },

  { tag: tags.meta, color: "#71717a" },
  { tag: tags.annotation, color: "#71717a" },
  { tag: tags.processingInstruction, color: "#71717a" },
  { tag: tags.documentMeta, color: "#71717a" },
]);

export const xanomLightHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "#71717a", fontStyle: "italic" },
  { tag: tags.lineComment, color: "#71717a", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#71717a", fontStyle: "italic" },
  { tag: tags.docComment, color: "#71717a", fontStyle: "italic" },

  { tag: tags.keyword, color: "#4338ca" },
  { tag: tags.controlKeyword, color: "#4338ca" },
  { tag: tags.moduleKeyword, color: "#4338ca" },
  { tag: tags.operatorKeyword, color: "#4338ca" },
  { tag: tags.definitionKeyword, color: "#4338ca" },
  { tag: tags.modifier, color: "#4338ca" },

  { tag: tags.string, color: "#047857" },
  { tag: tags.special(tags.string), color: "#047857" },

  { tag: tags.number, color: "#b45309" },
  { tag: tags.integer, color: "#b45309" },
  { tag: tags.float, color: "#b45309" },

  { tag: tags.typeName, color: "#0369a1" },
  { tag: tags.className, color: "#0369a1" },
  { tag: tags.namespace, color: "#0369a1" },
  { tag: tags.self, color: "#0369a1" },

  { tag: tags.function(tags.variableName), color: "#7c3aed" },
  { tag: tags.function(tags.propertyName), color: "#7c3aed" },

  { tag: tags.variableName, color: "#1f2937" },
  { tag: tags.propertyName, color: "#334155" },

  { tag: tags.operator, color: "#52525b" },
  { tag: tags.bracket, color: "#52525b" },
  { tag: tags.punctuation, color: "#71717a" },

  { tag: tags.tagName, color: "#be185d" },
  { tag: tags.attributeName, color: "#1d4ed8" },
  { tag: tags.attributeValue, color: "#047857" },

  { tag: tags.regexp, color: "#be185d" },

  { tag: tags.heading, color: "#4338ca", fontWeight: "bold" },
  { tag: tags.heading1, color: "#4338ca", fontWeight: "bold" },
  { tag: tags.heading2, color: "#4338ca", fontWeight: "bold" },
  { tag: tags.heading3, color: "#4338ca", fontWeight: "bold" },

  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },

  { tag: tags.link, color: "#1d4ed8", textDecoration: "underline" },
  { tag: tags.url, color: "#1d4ed8" },

  { tag: tags.bool, color: "#b45309" },
  { tag: tags.null, color: "#71717a" },

  { tag: tags.meta, color: "#71717a" },
  { tag: tags.annotation, color: "#71717a" },
  { tag: tags.processingInstruction, color: "#71717a" },
  { tag: tags.documentMeta, color: "#71717a" },
]);

export const xanomEditorTheme = xanomDarkEditorTheme;
export const xanomHighlightStyle = xanomDarkHighlightStyle;
export const xanomSyntaxHighlighting = syntaxHighlighting(xanomHighlightStyle);
