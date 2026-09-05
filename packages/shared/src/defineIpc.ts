/**
 * `defineIpc` turns an untyped two-function transport into the fully typed,
 * zod-validated client both sides of the bridge use.
 *
 *   preload.ts  →  defineIpc({ invoke: ipcRenderer.invoke, subscribe: ipcRenderer.on })
 *   renderer    →  defineIpc(bridgeTransport(window.capygen))
 *
 * Validation runs on the way out (so a renderer bug is caught before it reaches
 * main) and on the way in (so a main-process regression cannot poison the store
 * with a half-shaped block). Channel names are checked against the contract, so
 * neither side can send to a channel this build does not declare.
 */
import type { z } from "zod";
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  isEventChannel,
  isInvokeChannel,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeInput,
  type InvokeResult,
} from "./ipc.js";

/** The raw wire. Anything that can do request/response and pub/sub fits. */
export interface IpcTransport {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  /** Returns an unsubscribe function. */
  subscribe(channel: string, listener: (payload: unknown) => void): () => void;
}

export interface IpcClient {
  invoke<C extends InvokeChannel>(
    channel: C,
    input: InvokeInput<C>,
  ): Promise<InvokeResult<C>>;
  on<E extends EventChannel>(
    event: E,
    listener: (payload: EventPayload<E>) => void,
  ): () => void;
}

/** Thrown when a payload does not match the contract; carries the channel. */
export class IpcContractError extends Error {
  constructor(
    readonly channel: string,
    readonly direction: "input" | "output" | "event",
    readonly issues: unknown,
  ) {
    super(`IPC ${direction} for "${channel}" does not match the contract`);
    this.name = "IpcContractError";
  }
}

function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  channel: string,
  direction: "input" | "output" | "event",
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new IpcContractError(channel, direction, result.error.issues);
  }
  return result.data;
}

export function defineIpc(transport: IpcTransport): IpcClient {
  return {
    async invoke(channel, input) {
      if (!isInvokeChannel(channel as string)) {
        throw new IpcContractError(channel as string, "input", "unknown channel");
      }
      const def = INVOKE_CHANNELS[channel];
      const payload = parseOrThrow(def.input, input ?? {}, channel, "input");
      const raw = await transport.invoke(channel, payload);
      return parseOrThrow(def.output, raw, channel, "output") as InvokeResult<
        typeof channel
      >;
    },
    on(event, listener) {
      if (!isEventChannel(event as string)) {
        throw new IpcContractError(event as string, "event", "unknown channel");
      }
      const schema = EVENT_CHANNELS[event];
      return transport.subscribe(event, (raw) => {
        listener(parseOrThrow(schema, raw, event, "event") as EventPayload<typeof event>);
      });
    },
  };
}

/**
 * Main-process side: parse an incoming request against the contract before the
 * handler sees it, and the handler's return value before it goes back. Keeps
 * every `ipcMain.handle` call honest without repeating the schema lookup.
 */
export function parseInvokeArgs<C extends InvokeChannel>(
  channel: C,
  raw: unknown,
): z.output<(typeof INVOKE_CHANNELS)[C]["input"]> {
  // Indexing the contract with a generic key widens to a union of every
  // channel's schema, so the narrow per-channel result is asserted here rather
  // than being inferred; the runtime parse is still the channel's own schema.
  return parseOrThrow(
    INVOKE_CHANNELS[channel].input,
    raw ?? {},
    channel,
    "input",
  ) as z.output<(typeof INVOKE_CHANNELS)[C]["input"]>;
}

export function parseInvokeResult<C extends InvokeChannel>(
  channel: C,
  raw: unknown,
): InvokeResult<C> {
  return parseOrThrow(INVOKE_CHANNELS[channel].output, raw, channel, "output") as InvokeResult<C>;
}

export function parseEventPayload<E extends EventChannel>(
  event: E,
  raw: unknown,
): EventPayload<E> {
  return parseOrThrow(EVENT_CHANNELS[event], raw, event, "event") as EventPayload<E>;
}
