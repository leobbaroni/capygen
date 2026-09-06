/**
 * The four dev-server detectors (SPEC R18, G6) against the fixture projects in
 * `tests/fixtures/servers/{launchjson,node,python,compose}`.
 *
 * Fixtures rather than inline strings because R18 names four *file formats*,
 * and a format is only really pinned by a file on disk that a human can open
 * and compare against the real thing.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DevServer } from "@capygen/shared";
import {
  detectCompose,
  detectDevServers,
  detectLaunchJson,
  detectPackageJson,
  detectPython,
  detectedId,
  mergeDetected,
  packageRunner,
  parseComposeServices,
  portFromScript,
  publishedHostPort,
} from "../src/workspace/detectors.js";
import { DevServerService } from "../src/workspace/DevServerService.js";
import { FIXTURES_DIR, makeHarness, type Harness } from "./workspaceHarness.js";

const NOW = 1_700_000_000_000;

function ctxFor(name: string, projectId = "prj_fixture"): {
  projectId: string;
  root: string;
  now: number;
} {
  return { projectId, root: path.join(FIXTURES_DIR, name), now: NOW };
}

describe(".claude/launch.json", () => {
  it("reads name, runtimeExecutable, runtimeArgs, port and url", () => {
    const found = detectLaunchJson(ctxFor("launchjson"));
    expect(found).toHaveLength(2);

    const [web, docs] = found as [DevServer, DevServer];
    expect(web.name).toBe("web");
    expect(web.source).toBe("launch.json");
    expect(web.command).toBe("npm");
    expect(web.args).toEqual(["run", "dev"]);
    expect(web.port).toBe(3000);
    expect(web.url).toBeUndefined();

    expect(docs.command).toBe("python");
    expect(docs.args).toEqual(["-m", "http.server", "8001"]);
    expect(docs.url).toBe("http://localhost:8001/docs");
  });

  it("drops a configuration with no runtimeExecutable rather than inventing one", () => {
    expect(detectLaunchJson(ctxFor("launchjson")).map((s) => s.name)).not.toContain(
      "broken — no runtimeExecutable",
    );
  });

  it("a missing or malformed file is an empty answer, not a throw", () => {
    expect(detectLaunchJson(ctxFor("node"))).toEqual([]);
    expect(detectLaunchJson({ projectId: "p", root: path.join(FIXTURES_DIR, "nope"), now: NOW }))
      .toEqual([]);
  });
});

describe("package.json scripts", () => {
  it("offers dev/start/serve/preview only, in that order", () => {
    const found = detectPackageJson(ctxFor("node"));
    expect(found.map((s) => s.name)).toEqual(["pnpm dev", "pnpm start", "pnpm preview"]);
    expect(found.every((s) => s.source === "package.json")).toBe(true);
  });

  it("uses the package manager the lockfile names — corepack for pnpm", () => {
    const [dev] = detectPackageJson(ctxFor("node")) as [DevServer];
    expect(dev.command).toBe("corepack");
    expect(dev.args).toEqual(["pnpm", "run", "dev"]);
    expect(packageRunner(path.join(FIXTURES_DIR, "python"))).toEqual({
      label: "npm",
      command: "npm",
      args: ["run"],
    });
  });

  it("takes an explicit port over the tool's default", () => {
    const [dev] = detectPackageJson(ctxFor("node")) as [DevServer];
    // `vite --port 5199`: the flag wins over vite's documented 5173.
    expect(dev.port).toBe(5199);
  });

  it("portFromScript reads the flag forms, then a known tool, then gives up", () => {
    expect(portFromScript("next dev --port=4000")).toBe(4000);
    expect(portFromScript("http-server -p 8081")).toBe(8081);
    expect(portFromScript("PORT=9000 node server.js")).toBe(9000);
    expect(portFromScript("vite")).toBe(5173);
    expect(portFromScript("ng serve")).toBe(4200);
    expect(portFromScript("node server.js")).toBeUndefined();
  });
});

describe("python", () => {
  it("detects django, uvicorn and flask from the fixture", () => {
    const found = detectPython(ctxFor("python"));
    expect(found.map((s) => s.name)).toEqual([
      "django runserver",
      "uvicorn main:app",
      "flask run",
    ]);
    const [django, uvicorn, flask] = found as [DevServer, DevServer, DevServer];
    expect(django.args).toEqual(["manage.py", "runserver", "8000"]);
    expect(django.port).toBe(8000);
    expect(uvicorn.args).toEqual(["-m", "uvicorn", "main:app", "--reload", "--port", "8000"]);
    expect(flask.port).toBe(5000);
    expect(flask.env).toEqual({ FLASK_APP: "app.py" });
  });

  it("says nothing about a project with no python files at all", () => {
    expect(detectPython(ctxFor("node"))).toEqual([]);
  });
});

describe("docker-compose", () => {
  it("offers only the services that publish a host port", () => {
    const found = detectCompose(ctxFor("compose"));
    expect(found.map((s) => s.name)).toEqual([
      "docker compose up web",
      "docker compose up api",
    ]);
    const [web, api] = found as [DevServer, DevServer];
    expect(web.command).toBe("docker");
    expect(web.args).toEqual(["compose", "-f", "docker-compose.yml", "up", "web"]);
    expect(web.port).toBe(8085);
    // `127.0.0.1:4310:4310/tcp` — the middle field is the host port.
    expect(api.port).toBe(4310);
  });

  it("parseComposeServices ignores volumes and a port-less service", () => {
    const parsed = parseComposeServices(
      [
        "version: '3'",
        "services:",
        "  cache:",
        "    image: redis",
        "  web:",
        "    ports:",
        '      - "5000:5000"',
        "volumes:",
        "  data:",
      ].join("\n"),
    );
    expect(parsed).toEqual([{ name: "web", port: 5000 }]);
  });

  it("publishedHostPort handles the documented mapping forms", () => {
    expect(publishedHostPort('"3000:3000"')).toBe(3000);
    expect(publishedHostPort("8080:80")).toBe(8080);
    expect(publishedHostPort('"127.0.0.1:9000:80"')).toBe(9000);
    expect(publishedHostPort('"3000-3005:3000"')).toBe(3000);
    expect(publishedHostPort('"8080:80/tcp"')).toBe(8080);
    // A bare container port publishes nothing predictable.
    expect(publishedHostPort('"3000"')).toBeUndefined();
  });
});

describe("ids and merging", () => {
  it("the same project, source and key always give the same id", () => {
    expect(detectedId("prj_1", "package.json", "dev")).toBe(
      detectedId("prj_1", "package.json", "dev"),
    );
    expect(detectedId("prj_1", "package.json", "dev")).not.toBe(
      detectedId("prj_2", "package.json", "dev"),
    );
    expect(detectedId("prj_1", "package.json", "dev").startsWith("srv_")).toBe(true);
  });

  it("re-detecting keeps a url/port a previous start discovered", () => {
    const [detected] = detectPackageJson(ctxFor("node")) as [DevServer];
    const started: DevServer = {
      ...detected,
      url: "http://localhost:5199/",
      createdAt: NOW - 10_000,
      updatedAt: NOW - 5_000,
    };
    const merged = mergeDetected(started, { ...detected, port: undefined, url: undefined });
    expect(merged.url).toBe("http://localhost:5199/");
    expect(merged.port).toBe(5199);
    expect(merged.createdAt).toBe(NOW - 10_000);
  });

  it("a detector that now states a port overrides the remembered one", () => {
    const [detected] = detectPackageJson(ctxFor("node")) as [DevServer];
    const merged = mergeDetected({ ...detected, port: 1234 }, detected);
    expect(merged.port).toBe(5199);
  });
});

describe("servers.detect persists without duplicating", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness({ root: path.join(FIXTURES_DIR, "launchjson"), prefix: "capygen-detect-" });
  });
  afterEach(() => h.close());

  it("upserts on every scan, so running it twice changes nothing", () => {
    const service = new DevServerService({ store: h.store, broadcast: h.broadcast, log: h.log });
    const first = service.detect({ projectId: h.projectId });
    const second = service.detect({ projectId: h.projectId });

    expect(first).toHaveLength(2);
    expect(second.map((r) => r.server.id)).toEqual(first.map((r) => r.server.id));
    expect(h.store.devServers.listByProject(h.projectId)).toHaveLength(2);
    // Nothing has been started, so every row is honest about having no run.
    expect(second.every((r) => r.run === null)).toBe(true);
  });

  it("detectDevServers runs all four detectors in listing order", () => {
    const found = detectDevServers({ projectId: h.projectId, root: h.root, now: NOW });
    expect(found.map((s) => s.source)).toEqual(["launch.json", "launch.json"]);
  });
});
