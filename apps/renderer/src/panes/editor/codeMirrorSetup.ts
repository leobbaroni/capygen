/**
 * CodeMirror 6 wiring for the Editor pane (SPEC R16, item B2.3): language by
 * extension (`@codemirror/lang-*`, legacy `StreamLanguage` modes for the two
 * without a native grammar package), and a theme mapped onto capygen's own
 * tokens rather than importing `@codemirror/theme-one-dark` — "oneDark-like"
 * in the brief means the *shape* (a dark, low-chroma editor chrome with a
 * handful of accent colours for syntax), not Andreas Reik's literal palette,
 * and the app already has one to reuse (CLAUDE.md: "reuse CSS tokens
 * verbatim").
 */
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Extension (lowercased, without the dot) → CodeMirror language support. */
export function languageExtensionFor(path: string): Extension[] {
  const ext = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  switch (ext) {
    case "ts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "json":
      return [json()];
    case "md":
    case "mdx":
      return [markdown()];
    case "py":
      return [python()];
    case "css":
    case "scss":
      return [css()];
    case "html":
    case "htm":
      return [html()];
    case "yaml":
    case "yml":
      return [yaml()];
    case "toml":
      return [StreamLanguage.define(toml)];
    case "sh":
    case "bash":
    case "zsh":
      return [StreamLanguage.define(shell)];
    default:
      return [];
  }
}

/** Editor chrome (background, gutters, selection, cursor) mapped onto
 *  capygen's CSS custom properties — flips with the app's own light/dark
 *  toggle for free, since these are `var()` references, not literal colours. */
export const capygenEditorTheme = EditorView.theme(
  {
    "&": {
      color: "var(--foreground)",
      backgroundColor: "var(--code-bg)",
      height: "100%",
      fontSize: "13px",
    },
    ".cm-content": {
      caretColor: "var(--foreground)",
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "color-mix(in oklab, var(--accent) 55%, transparent)",
    },
    ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--accent) 20%, transparent)" },
    ".cm-activeLineGutter": {
      backgroundColor: "color-mix(in oklab, var(--accent) 25%, transparent)",
      color: "var(--foreground)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--code-bg)",
      color: "var(--muted-foreground)",
      border: "none",
      borderRight: "1px solid var(--border-weak)",
    },
    ".cm-scroller": { overflow: "auto" },
    ".cm-searchMatch": {
      backgroundColor: "color-mix(in oklab, var(--warning) 35%, transparent)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "color-mix(in oklab, var(--warning) 55%, transparent)",
    },
    "&.cm-editor.cm-focused": { outline: "none" },
  },
  { dark: true },
);

/**
 * Syntax colours, mapped onto the app's own accent tokens rather than
 * one-dark's literal hex values.
 *
 * [C] Every entry here must be an **opaque foreground** token.
 * `--tag-pink` is not one — it is `rgba(240,1,150,0.06)` in light and
 * `rgba(240,1,150,0.15)` in dark, a chip *background* used only as a `bg-`
 * elsewhere. Over `--code-bg` it renders keywords at ~1.1:1 contrast, i.e.
 * `import`, `from`, `export`, `return` and every JSX tag name invisible.
 * `--brand-accent` (#df3c85 in the default palette, per-theme in
 * `themePalettes.generated.css`) is the opaque pink that was meant.
 */
export const capygenHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: "var(--brand-accent)" },
  { tag: [t.string, t.special(t.string)], color: "var(--status-green)" },
  { tag: [t.number, t.bool, t.null], color: "var(--status-yellow)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--status-blue)" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "var(--foreground)" },
  { tag: [t.typeName, t.className], color: "var(--info)" },
  { tag: t.operator, color: "var(--foreground)" },
  { tag: t.punctuation, color: "var(--muted-foreground)" },
  { tag: t.tagName, color: "var(--brand-accent)" },
  { tag: t.attributeName, color: "var(--status-yellow)" },
  { tag: t.invalid, color: "var(--destructive)" },
]);

export function editorExtensions(path: string): Extension[] {
  return [...languageExtensionFor(path), capygenEditorTheme, syntaxHighlighting(capygenHighlightStyle)];
}
