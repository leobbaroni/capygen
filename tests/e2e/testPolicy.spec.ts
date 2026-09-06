/**
 * The test policy tests itself. No Electron, no model, no personal config —
 * pure assertions on `testPolicy.ts` and `globalSetup.ts`.
 *
 * It lives here rather than under a vitest project because `vitest.config.ts`
 * has no project covering `tests/`, and Playwright already collects this
 * directory. It launches nothing, so it costs about a millisecond.
 *
 * What it is for: every guarantee in this suite's isolation story is a claim
 * about code that only runs on someone else's machine, at the exact moment it
 * would be most expensive to be wrong. These assertions are how the claims
 * stay true.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import globalSetup from "./globalSetup.js";
import {
  assertPinnedModel,
  backendHomes,
  launchEnv,
  pinnedConfigFor,
  pinnedModelFor,
  validateDedicatedHome,
  CLAUDE_HOME_ENV,
  CODEX_HOME_ENV,
  E2E_CLAUDE_MODEL,
  E2E_CODEX_MODEL,
  E2E_EFFORT,
  PERSONAL_KEY_ENV,
  RESERVED_ISOLATION_ENV,
} from "./testPolicy.js";

/** Run `body` with `vars` applied to `process.env`, restoring it afterwards. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test.describe("model policy", () => {
  test("pins exactly one model per backend, at low effort", () => {
    expect(pinnedModelFor("claude")).toBe(E2E_CLAUDE_MODEL);
    expect(pinnedModelFor("codex")).toBe(E2E_CODEX_MODEL);
    expect(pinnedModelFor("api")).toBe(E2E_CLAUDE_MODEL);
    expect(E2E_EFFORT).toBe("low");
    expect(pinnedConfigFor("claude")).toEqual({ claude: { effort: "low" } });
    expect(pinnedConfigFor("codex")).toEqual({ codex: { reasoningEffort: "low" } });
    expect(pinnedConfigFor("api")).toEqual({
      api: { provider: "anthropic", model: E2E_CLAUDE_MODEL, reasoningEffort: "low" },
    });
  });

  test("refuses the models the user ruled out, by name", () => {
    for (const banned of ["claude-sonnet-4-5", "claude-haiku-4-5", "haiku", ""]) {
      expect(() => assertPinnedModel("claude", banned, "unit")).toThrow(/refusing to run/);
    }
    expect(() => assertPinnedModel("codex", "gpt-5.5", "unit")).toThrow(/refusing to run/);
    // The pinned ones pass.
    expect(() => assertPinnedModel("claude", E2E_CLAUDE_MODEL, "unit")).not.toThrow();
    expect(() => assertPinnedModel("codex", E2E_CODEX_MODEL, "unit")).not.toThrow();
  });
});

test.describe("dedicated home validation", () => {
  const home = os.homedir();

  test("refuses the personal roots, their descendants and their ancestors", () => {
    const refused = [
      path.join(home, ".claude"),
      path.join(home, ".codex"),
      path.join(home, ".claude", "test"),
      path.join(home, ".codex", "deep", "nested"),
      // An ancestor: pointing a "dedicated" home at the user's profile would
      // put backend config straight into their home directory.
      home,
      path.parse(home).root,
    ];
    for (const dir of refused) {
      expect(() => validateDedicatedHome(CLAUDE_HOME_ENV, dir), dir).toThrow(
        /personal configuration home/,
      );
    }
  });

  test("refuses a Claude home inside the personal Codex root, and vice versa", () => {
    // Cross-backend: an isolated *Claude* home must not sit in `~/.codex`.
    expect(() => validateDedicatedHome(CLAUDE_HOME_ENV, path.join(home, ".codex", "x"))).toThrow();
    expect(() => validateDedicatedHome(CODEX_HOME_ENV, path.join(home, ".claude", "x"))).toThrow();
  });

  test("refuses a relative path", () => {
    expect(() => validateDedicatedHome(CLAUDE_HOME_ENV, "./somewhere")).toThrow(/absolute path/);
  });

  test("accepts a separate absolute directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-policy-"));
    try {
      expect(validateDedicatedHome(CLAUDE_HOME_ENV, dir)).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe("backendHomes", () => {
  test("is disposable by default and cleans up only what it created", () => {
    withEnv({ [CLAUDE_HOME_ENV]: undefined, [CODEX_HOME_ENV]: undefined }, () => {
      const homes = backendHomes("unit");
      expect(homes.dedicated).toBe(false);
      expect(fs.existsSync(homes.claudeHome)).toBe(true);
      expect(fs.existsSync(homes.codexHome)).toBe(true);
      // Inside the OS temp dir, never anywhere near the personal home.
      expect(homes.claudeHome.startsWith(fs.realpathSync.native(os.tmpdir()))
        || homes.claudeHome.startsWith(os.tmpdir())).toBe(true);
      homes.cleanup();
      expect(fs.existsSync(homes.claudeHome)).toBe(false);
    });
  });

  test("reuses a dedicated identity and never deletes it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-dedicated-"));
    const claudeHome = path.join(root, "claude");
    const codexHome = path.join(root, "codex");
    try {
      withEnv({ [CLAUDE_HOME_ENV]: claudeHome, [CODEX_HOME_ENV]: codexHome }, () => {
        const homes = backendHomes("unit");
        expect(homes.dedicated).toBe(true);
        expect(homes.claudeHome).toBe(claudeHome);
        fs.writeFileSync(path.join(claudeHome, "marker"), "sign-in lives here", "utf8");
        homes.cleanup();
        // The whole point: a dedicated home holds a real sign-in, so cleanup
        // must be a no-op on it.
        expect(fs.existsSync(path.join(claudeHome, "marker"))).toBe(true);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a half-configured identity rather than silently isolating one backend", () => {
    withEnv({ [CLAUDE_HOME_ENV]: "C:\\dedicated\\claude", [CODEX_HOME_ENV]: undefined }, () => {
      expect(() => backendHomes("unit")).toThrow(/both/);
    });
  });
});

test.describe("launchEnv", () => {
  const homes = { claudeHome: "C:\\iso\\claude", codexHome: "C:\\iso\\codex" };
  const base = { userDataDir: "C:\\iso\\profile", projectDir: "C:\\iso\\proj", homes };

  test("sets both the CAPYGEN mappings and the CLIs' own variables", () => {
    withEnv({ [CLAUDE_HOME_ENV]: undefined, [CODEX_HOME_ENV]: undefined }, () => {
      const env = launchEnv(base);
      expect(env.CAPYGEN_CLAUDE_CONFIG_DIR).toBe(homes.claudeHome);
      expect(env.CAPYGEN_CODEX_HOME).toBe(homes.codexHome);
      // The pair a child CLI reads directly.
      expect(env.CLAUDE_CONFIG_DIR).toBe(homes.claudeHome);
      expect(env.CODEX_HOME).toBe(homes.codexHome);
    });
  });

  test("overrides an inherited personal config home rather than passing it through", () => {
    withEnv(
      {
        CLAUDE_CONFIG_DIR: path.join(os.homedir(), ".claude"),
        CODEX_HOME: path.join(os.homedir(), ".codex"),
        [CLAUDE_HOME_ENV]: undefined,
        [CODEX_HOME_ENV]: undefined,
      },
      () => {
        const env = launchEnv(base);
        expect(env.CLAUDE_CONFIG_DIR).toBe(homes.claudeHome);
        expect(env.CODEX_HOME).toBe(homes.codexHome);
      },
    );
  });

  test("a lower-case inherited isolation variable cannot survive into the child", () => {
    // Windows environment variables are case-insensitive; a JS object is not.
    // An inherited `claude_config_dir` alongside an assigned
    // `CLAUDE_CONFIG_DIR` would leave the OS to choose, so every casing of a
    // reserved key must be stripped before the isolated value is written.
    withEnv(
      {
        claude_config_dir: path.join(os.homedir(), ".claude"),
        Codex_Home: path.join(os.homedir(), ".codex"),
        capygen_claude_config_dir: path.join(os.homedir(), ".claude"),
        [CLAUDE_HOME_ENV]: undefined,
        [CODEX_HOME_ENV]: undefined,
      },
      () => {
        const env = launchEnv(base);
        const reserved = new Set(RESERVED_ISOLATION_ENV.map((k) => k.toLowerCase()));
        const survivors = Object.keys(env).filter((k) => reserved.has(k.toLowerCase()));
        // Exactly one spelling of each reserved key, and it is the canonical one.
        expect(survivors.sort()).toEqual([...RESERVED_ISOLATION_ENV].sort());
        for (const key of survivors) {
          expect(env[key]!.toLowerCase()).not.toContain(os.homedir().toLowerCase());
        }
      },
    );
  });

  test("strips personal provider keys whatever their casing", () => {
    withEnv(
      {
        anthropic_api_key: "sk-personal",
        Openai_Api_Key: "sk-personal",
        [CLAUDE_HOME_ENV]: undefined,
        [CODEX_HOME_ENV]: undefined,
      },
      () => {
        const env = launchEnv(base);
        const banned = new Set(PERSONAL_KEY_ENV.map((k) => k.toLowerCase()));
        expect(Object.keys(env).filter((k) => banned.has(k.toLowerCase()))).toEqual([]);
      },
    );
  });

  test("refuses an extra that would overwrite an isolation variable, in any casing", () => {
    for (const key of RESERVED_ISOLATION_ENV) {
      for (const spelling of [key, key.toLowerCase(), key[0]! + key.slice(1).toLowerCase()]) {
        expect(
          () => launchEnv({ ...base, extra: { [spelling]: "C:\\elsewhere" } }),
          spelling,
        ).toThrow(/isolation variable/);
      }
    }
  });

  test("keeps a non-reserved extra", () => {
    const env = launchEnv({ ...base, extra: { CAPYGEN_FAKE_PATH: "C:\\fake" } });
    expect(env.CAPYGEN_FAKE_PATH).toBe("C:\\fake");
  });

  test("strips personal provider keys on an ordinary offline run", () => {
    withEnv(
      {
        ANTHROPIC_API_KEY: "sk-personal",
        OPENAI_API_KEY: "sk-personal",
        [CLAUDE_HOME_ENV]: undefined,
        [CODEX_HOME_ENV]: undefined,
      },
      () => {
        const env = launchEnv(base);
        for (const key of PERSONAL_KEY_ENV) expect(env[key]).toBeUndefined();
      },
    );
  });

  test("keeps provider keys only when a dedicated identity is in use", () => {
    withEnv(
      {
        ANTHROPIC_API_KEY: "sk-dedicated",
        [CLAUDE_HOME_ENV]: "C:\\dedicated\\claude",
        [CODEX_HOME_ENV]: "C:\\dedicated\\codex",
      },
      () => {
        expect(launchEnv(base).ANTHROPIC_API_KEY).toBe("sk-dedicated");
      },
    );
  });

  test("never lets the shell choose the engine", () => {
    withEnv({ CAPYGEN_ENGINE: "stub" }, () => {
      // Inherited value dropped when the spec asks for the real harness…
      expect(launchEnv(base).CAPYGEN_ENGINE).toBeUndefined();
      // …and honoured verbatim when the spec asks for a fixture engine.
      expect(launchEnv({ ...base, engine: "stub-roundtable" }).CAPYGEN_ENGINE).toBe(
        "stub-roundtable",
      );
    });
  });
});

test.describe("globalSetup", () => {
  test("returns a closure that removes only the directory it created", () => {
    withEnv(
      {
        [CLAUDE_HOME_ENV]: undefined,
        [CODEX_HOME_ENV]: undefined,
        CLAUDE_CONFIG_DIR: undefined,
        CODEX_HOME: undefined,
      },
      () => {
        const cleanup = globalSetup();
        const claudeHome = process.env.CLAUDE_CONFIG_DIR!;
        expect(claudeHome).toBeTruthy();
        expect(process.env.CAPYGEN_CLAUDE_CONFIG_DIR).toBe(claudeHome);
        expect(fs.existsSync(claudeHome)).toBe(true);
        cleanup();
        expect(fs.existsSync(claudeHome)).toBe(false);
      },
    );
  });

  test("does not delete a dedicated identity, and ignores a hostile env var", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-dedicated-"));
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-victim-"));
    const claudeHome = path.join(root, "claude");
    const codexHome = path.join(root, "codex");
    try {
      withEnv(
        {
          [CLAUDE_HOME_ENV]: claudeHome,
          [CODEX_HOME_ENV]: codexHome,
          // The regression this guards: the previous design read the run's
          // delete-me path out of the environment, so a value already in the
          // developer's shell was trusted and removed. The closure ignores it.
          CAPYGEN_E2E_RUN_HOMES_ROOT: victim,
        },
        () => {
          const cleanup = globalSetup();
          fs.writeFileSync(path.join(claudeHome, "marker"), "sign-in", "utf8");
          cleanup();
          expect(fs.existsSync(path.join(claudeHome, "marker"))).toBe(true);
          expect(fs.existsSync(victim)).toBe(true);
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(victim, { recursive: true, force: true });
    }
  });
});
