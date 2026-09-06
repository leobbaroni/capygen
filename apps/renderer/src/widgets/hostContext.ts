/**
 * The `McpUiHostContext` capygen hands a widget at `ui/initialize`, and again
 * whenever the app's theme changes (`ui/notifications/host-context-changed`).
 *
 * MCP Apps fixes the *names* of the CSS variables a widget may use
 * (`spec.types.d.ts` `McpUiStyleVariableKey`) but not their values, so theme
 * passthrough is a mapping job: read capygen's own design tokens off
 * `document.documentElement` and publish them under the spec's names. A widget
 * that uses `var(--color-text-primary)` then lands on the app's palette in both
 * themes without knowing anything about capygen.
 */
import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";

/** capygen token → the MCP Apps variable it answers for. */
const VARIABLE_MAP: ReadonlyArray<[mcp: string, token: string]> = [
  ["--color-background-primary", "--background"],
  ["--color-background-secondary", "--card"],
  ["--color-background-tertiary", "--muted"],
  ["--color-background-info", "--info"],
  ["--color-background-danger", "--destructive"],
  ["--color-background-success", "--success"],
  ["--color-background-warning", "--warning"],
  ["--color-text-primary", "--foreground"],
  ["--color-text-secondary", "--muted-foreground"],
  ["--color-text-tertiary", "--foreground-tertiary"],
  ["--color-text-danger", "--destructive"],
  ["--color-text-success", "--success"],
  ["--color-text-warning", "--warning"],
  ["--color-border-primary", "--border"],
  ["--color-border-secondary", "--border-weak"],
  ["--color-border-tertiary", "--border-strong"],
  ["--color-ring-primary", "--ring"],
  ["--font-sans", "--font-sans"],
  ["--font-mono", "--font-mono"],
  ["--border-radius-md", "--radius"],
];

export type WidgetTheme = "light" | "dark";

export interface WidgetHostContext {
  /** The spec's own forward-compatibility clause (`McpUiHostContext`). */
  [key: string]: unknown;
  theme: WidgetTheme;
  styles: { variables: McpUiStyles };
  displayMode: "inline";
  availableDisplayModes: ["inline"];
  locale: string;
  timeZone: string;
  userAgent: string;
  platform: "desktop";
  containerDimensions?: { maxWidth?: number; maxHeight?: number };
}

/** Which theme the app is actually painting right now. */
export function currentTheme(root: HTMLElement = document.documentElement): WidgetTheme {
  return root.classList.contains("dark") || root.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * `McpUiStyles` is declared as a *total* record over every variable name the
 * spec lists (`Record<Key, string | undefined>`, so that `ts-to-zod` can
 * generate a schema from it), while a host is explicitly allowed to send "any
 * subset". Building the subset and asserting it once here is the honest
 * reading; the alternative would be spelling out 80 `undefined`s.
 */
function readVariables(root: HTMLElement): McpUiStyles {
  const computed = getComputedStyle(root);
  const out: Record<string, string> = {};
  for (const [mcpName, token] of VARIABLE_MAP) {
    const value = computed.getPropertyValue(token).trim();
    if (value.length > 0) out[mcpName] = value;
  }
  return out as McpUiStyles;
}

export function buildHostContext(
  options: { root?: HTMLElement; maxWidth?: number } = {},
): WidgetHostContext {
  const root = options.root ?? document.documentElement;
  return {
    theme: currentTheme(root),
    styles: { variables: readVariables(root) },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    locale: typeof navigator !== "undefined" ? navigator.language : "en-US",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: "capygen",
    platform: "desktop",
    ...(options.maxWidth ? { containerDimensions: { maxWidth: options.maxWidth } } : {}),
  };
}
