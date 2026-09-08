import { describe, expect, it } from "vitest";
import { EVENT_CHANNELS } from "./ipc.js";
import { PermissionRequestSchema } from "./domain.js";

describe("local policy display and invalidation metadata", () => {
  it("preserves rule attribution on a permission card without accepting authority fields", () => {
    const localPolicy = { ruleId: "rule_1", scope: { kind: "session", sessionId: "session_1" },
      boundary: "api-tool" };
    const request = { requestId: "request_1", toolName: "read", input: {}, localPolicy };
    expect(PermissionRequestSchema.parse(request)).toMatchObject({ localPolicy });
    expect(PermissionRequestSchema.safeParse({ ...request,
      localPolicy: { ...localPolicy, allowed: true, lifecycleToken: "private" } }).success).toBe(false);
  });

  it("invalidates views without carrying grants, arguments or backend configuration", () => {
    const event = EVENT_CHANNELS["policy.changed"];
    expect(event.parse({ area: "grants", sessionId: "session_1" })).toEqual({ area: "grants", sessionId: "session_1" });
    expect(event.parse({ area: "rules" })).toEqual({ area: "rules", sessionId: null });
    for (const key of ["input", "cwd", "grantSignature", "config", "lifecycleToken"]) {
      expect(event.safeParse({ area: "grants", [key]: "private" }).success).toBe(false);
    }
  });
});
