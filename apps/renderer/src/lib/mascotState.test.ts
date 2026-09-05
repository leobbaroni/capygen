import { describe, expect, it } from "vitest";
import { deriveMascotState, SLEEP_AFTER_MS, SUCCESS_WINDOW_MS } from "./mascotState";

const idleInputs = {
  sessionStatus: undefined,
  hasPendingInteraction: false,
  turnPhase: "working" as const,
  listening: false,
  msSinceLastDone: null,
  msSinceLastActivity: 0,
};

describe("deriveMascotState", () => {
  it("defaults to idle with no session and no activity", () => {
    expect(deriveMascotState(idleInputs)).toBe("idle");
  });

  it("listening wins over everything else", () => {
    expect(
      deriveMascotState({
        ...idleInputs,
        listening: true,
        sessionStatus: "error",
        hasPendingInteraction: true,
      }),
    ).toBe("listening");
  });

  it("a pending permission/question reads as waiting even mid-run", () => {
    expect(
      deriveMascotState({ ...idleInputs, sessionStatus: "running", hasPendingInteraction: true }),
    ).toBe("waiting");
  });

  it("session status error takes over", () => {
    expect(deriveMascotState({ ...idleInputs, sessionStatus: "error" })).toBe("error");
  });

  it("session status waiting maps to waiting", () => {
    expect(deriveMascotState({ ...idleInputs, sessionStatus: "waiting" })).toBe("waiting");
  });

  it("running with no output yet reads as thinking", () => {
    expect(
      deriveMascotState({ ...idleInputs, sessionStatus: "running", turnPhase: "thinking" }),
    ).toBe("thinking");
  });

  it("running with output reads as working", () => {
    expect(
      deriveMascotState({ ...idleInputs, sessionStatus: "running", turnPhase: "working" }),
    ).toBe("working");
  });

  it("just finished a turn reads as success inside the success window", () => {
    expect(
      deriveMascotState({ ...idleInputs, sessionStatus: "idle", msSinceLastDone: SUCCESS_WINDOW_MS - 1 }),
    ).toBe("success");
  });

  it("falls through to idle once the success window elapses", () => {
    expect(
      deriveMascotState({ ...idleInputs, sessionStatus: "idle", msSinceLastDone: SUCCESS_WINDOW_MS + 1 }),
    ).toBe("idle");
  });

  it("goes to sleep after five minutes of no activity", () => {
    expect(deriveMascotState({ ...idleInputs, msSinceLastActivity: SLEEP_AFTER_MS })).toBe(
      "sleeping",
    );
  });

  it("stays idle just under the sleep threshold", () => {
    expect(deriveMascotState({ ...idleInputs, msSinceLastActivity: SLEEP_AFTER_MS - 1 })).toBe(
      "idle",
    );
  });
});
