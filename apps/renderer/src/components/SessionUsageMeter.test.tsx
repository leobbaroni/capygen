import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { UsageEvent } from "@capygen/shared";
import { SessionUsageMeter } from "./SessionUsageMeter";
import { useAppStore } from "@/store/appStore";

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: "u1",
    sessionId: "session-1",
    agentId: null,
    turnId: "turn-1",
    backend: "claude",
    model: "claude-opus-4-5",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.01,
    ts: 1,
    ...overrides,
  };
}

beforeEach(() => {
  useAppStore.setState({ usageEvents: [] });
});

describe("SessionUsageMeter", () => {
  it("renders nothing before the session has any usage_events", () => {
    render(<SessionUsageMeter />);
    expect(screen.queryByTestId("session-usage-meter")).not.toBeInTheDocument();
  });

  it("sums every usage event in the session, across turns and models", () => {
    useAppStore.setState({
      usageEvents: [
        event({ id: "u1", turnId: "turn-1", inputTokens: 100, outputTokens: 10, costUsd: 0.01 }),
        event({ id: "u2", turnId: "turn-2", model: "claude-haiku-4-5", inputTokens: 20, outputTokens: 2, costUsd: 0.001 }),
      ],
    });
    render(<SessionUsageMeter />);
    const meter = screen.getByTestId("session-usage-meter");
    expect(meter).toHaveTextContent("120 in");
    expect(meter).toHaveTextContent("12 out");
    expect(meter).toHaveTextContent("$0.01");
  });

  it("shows cached tokens only when there are any", () => {
    useAppStore.setState({ usageEvents: [event({ cacheReadTokens: 500 })] });
    render(<SessionUsageMeter />);
    expect(screen.getByTestId("session-usage-meter")).toHaveTextContent("500 cached");
  });
});
