import { describe, expect, it } from "vitest";
import {
  LifecycleRegistry,
  boundaryStates,
  type CapturedAgent,
} from "../src/policies/runtimeContexts.js";

const capture = (over: Partial<CapturedAgent> = {}): CapturedAgent => ({
  sessionId: "ses_1", agentId: "agt_1", projectId: "prj_1",
  backend: "codex", readOnly: false, ...over,
});

const stateOf = (list: ReturnType<typeof boundaryStates>, boundary: string) =>
  list.find((state) => state.boundary === boundary)!;

describe("a capture reports only the boundaries it can actually enforce", () => {
  it("never claims a boundary another backend owns", () => {
    for (const backend of ["api", "claude", "codex"] as const) {
      const states = boundaryStates(capture({ backend }));
      for (const state of states) {
        if (state.available) continue;
        const foreign = (backend === "api" && state.boundary !== "api-tool")
          || (backend === "claude" && state.boundary !== "claude-pre-tool")
          || (backend === "codex" && !state.boundary.startsWith("codex-"));
        if (foreign) expect(state.reason).toBe("unsupported-backend");
      }
    }
    expect(stateOf(boundaryStates(capture({ backend: "api" })), "api-tool").available).toBe(true);
  });

  it("offers Claude's pre-tool hook, whose precedence is proven against the pinned CLI", () => {
    // Enforceable regardless of how the user's own Claude configuration is
    // written: the probe shows a hook denial holding over a native allow rule
    // and under bypassPermissions, and a neutral hook leaving a native deny
    // intact. It does not depend on permission mode, so no capture option
    // turns it off.
    for (const extra of [{}, { codexApprovalPolicy: "never" as const }, { declaresDynamicTools: true }]) {
      const state = stateOf(boundaryStates(capture({ backend: "claude", ...extra })),
        "claude-pre-tool");
      expect(state).toMatchObject({ available: true, reason: null });
    }
    // And it stays a Claude-only boundary.
    for (const backend of ["api", "codex"] as const) {
      expect(stateOf(boundaryStates(capture({ backend })), "claude-pre-tool"))
        .toMatchObject({ available: false, reason: "unsupported-backend" });
    }
  });

  it("still refuses to claim a boundary nothing has proven", () => {
    // The one Claude boundary that is enabled is enabled *because* of a probe.
    // Codex's permission-profile approvals have no such proof and stay off.
    expect(stateOf(boundaryStates(capture({ backend: "codex" })), "codex-permissions-approval"))
      .toMatchObject({ available: false, reason: "capability-unproven" });
  });

  it("reports Codex permission-profile approvals as unavailable on every capture", () => {
    for (const policy of ["untrusted", "on-request", "on-failure", "never"] as const) {
      const state = stateOf(
        boundaryStates(capture({ codexApprovalPolicy: policy })),
        "codex-permissions-approval",
      );
      expect(state).toMatchObject({ available: false, reason: "capability-unproven" });
    }
  });

  it("offers Codex command and file approvals only where the thread asks the app", () => {
    for (const [policy, expected] of [
      ["untrusted", true], ["on-request", true], ["on-failure", false], ["never", false],
    ] as const) {
      const states = boundaryStates(capture({ codexApprovalPolicy: policy }));
      for (const boundary of ["codex-command-approval", "codex-file-approval"] as const) {
        const state = stateOf(states, boundary);
        expect(state.available, `${policy} ${boundary}`).toBe(expected);
        if (!expected) expect(state.reason).toBe("native-approval-disabled");
      }
    }
    // An unset policy is not an assumption of coverage.
    expect(stateOf(boundaryStates(capture()), "codex-command-approval").available).toBe(false);
  });

  it("offers the Codex client-tool boundary only when this capture declared tools", () => {
    expect(stateOf(boundaryStates(capture({ declaresDynamicTools: true })),
      "codex-dynamic-tool")).toMatchObject({ available: true });
    expect(stateOf(boundaryStates(capture({ declaresDynamicTools: false })),
      "codex-dynamic-tool")).toMatchObject({ available: false, reason: "harness-unavailable" });
  });
});

describe("lifecycle tokens live and die with the capture", () => {
  const registryWith = () => {
    const ended: string[] = [];
    let seq = 0;
    const registry = new LifecycleRegistry({
      onLifecycleEnded: (token) => ended.push(token),
      newToken: () => `tok_${(seq += 1)}`,
    });
    return { registry, ended };
  };

  it("mints an opaque token per agent and resolves a context from it", () => {
    const { registry } = registryWith();
    const token = registry.capture(capture({ codexApprovalPolicy: "on-request" }));
    expect(token).toBe("tok_1");
    const context = registry.contextFor("ses_1", "agt_1")!;
    expect(context).toMatchObject({ backend: "codex", readOnly: false, lifecycleToken: "tok_1" });
    expect(context.availableBoundaries).toEqual(
      expect.arrayContaining(["codex-command-approval", "codex-file-approval"]));
    expect(context.availableBoundaries).not.toContain("codex-permissions-approval");
    // The token describes nothing: no session, agent, backend or path in it.
    expect(token).not.toContain("ses_1");
    expect(token).not.toContain("codex");
  });

  it("gives each agent its own token, including a delegated child", () => {
    const { registry } = registryWith();
    const parent = registry.capture(capture());
    const child = registry.capture(capture({ agentId: "ephemeral-child-1" }));
    expect(child).not.toBe(parent);
    expect(registry.tokenFor("ses_1", "ephemeral-child-1")).toBe(child);
    expect(registry.size()).toBe(2);
  });

  it("ends the old lifecycle when the same agent is re-captured", () => {
    const { registry, ended } = registryWith();
    const first = registry.capture(capture());
    const second = registry.capture(capture());
    expect(second).not.toBe(first);
    // A restarted harness resuming the same conversation is still a new run.
    expect(ended).toEqual([first]);
    expect(registry.tokenFor("ses_1", "agt_1")).toBe(second);
  });

  it("ends lifecycles on release, session end and shutdown", () => {
    const { registry, ended } = registryWith();
    const a = registry.capture(capture());
    const b = registry.capture(capture({ agentId: "agt_2" }));
    const other = registry.capture(capture({ sessionId: "ses_2" }));

    expect(registry.release("ses_1", "agt_1")).toBe(true);
    expect(ended).toEqual([a]);
    expect(registry.release("ses_1", "agt_1")).toBe(false);

    expect(registry.releaseSession("ses_1")).toBe(1);
    expect(ended).toEqual([a, b]);
    expect(registry.releaseAll()).toBe(1);
    expect(ended).toEqual([a, b, other]);
    expect(registry.size()).toBe(0);
  });

  it("knows nothing about an agent that was never captured", () => {
    const { registry } = registryWith();
    expect(registry.contextFor("ses_1", "agt_1")).toBeNull();
    expect(registry.tokenFor("ses_1", "agt_1")).toBeNull();
    expect(registry.boundariesFor("ses_1", "agt_1")).toBeNull();
  });

  it("marks a read-only artifact so nothing dispatches on it", () => {
    const { registry } = registryWith();
    registry.capture(capture({ readOnly: true }));
    expect(registry.contextFor("ses_1", "agt_1")!.readOnly).toBe(true);
  });
});
