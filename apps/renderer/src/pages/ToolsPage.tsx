import { NavLink, useParams } from "react-router-dom";
import { SelectedProjectNote } from "@/components/settings/primitives";
import { SkillsSection } from "./settings/SkillsSection";
import { PluginsSection } from "./settings/PluginsSection";
import { McpSection } from "./settings/McpSection";
import { ToolsSection } from "./settings/ToolsSection";
import { ExtensionsPage } from "./ExtensionsPage";
import { cn } from "@/lib/utils";

const sections = [
  { id: "skills", label: "Skills", body: SkillsSection },
  { id: "plugins", label: "Plugins", body: PluginsSection },
  { id: "mcp", label: "MCP servers", body: McpSection },
  { id: "permissions", label: "Tool permissions", body: ToolsSection },
  { id: "pages", label: "App pages", body: ExtensionsPage },
];

/** All editors write through to the harness's canonical configuration files. */
export function ToolsPage() {
  const { category = "skills" } = useParams();
  const current = sections.find((section) => section.id === category) ?? sections[0]!;
  const Body = current.body;
  return <div className="titlebar-top-clearance min-h-0 flex-1 overflow-y-auto p-5 max-md:!pt-12" data-testid="tools-page">
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl tracking-tight">Tools</h1>
      <p className="mt-1 text-sm text-muted-foreground">Manage the skills, plugins and MCP servers your agents use. Changes stay in their backend configuration files.</p>
      <nav aria-label="Tools sections" className="my-4 flex flex-wrap gap-1 border-b border-border-weak pb-2">
        {sections.map((section) => <NavLink key={section.id} to={`/tools/${section.id}`} className={cn("rounded-md px-3 py-1.5 text-sm", current.id === section.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted")}>{section.label}</NavLink>)}
      </nav>
      <SelectedProjectNote />
      <Body />
    </div>
  </div>;
}
