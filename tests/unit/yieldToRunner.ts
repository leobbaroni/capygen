import { setImmediate } from "node:timers";
import { afterEach } from "vitest";

// Capture the real timer before a test installs fake timers. On slow hosted
// disks, a sequence of synchronous SQLite fixtures can starve worker IPC even
// though every test passes. Give queued runner messages an event-loop turn.
const schedule = setImmediate;
if (process.env.CI) afterEach(() => new Promise<void>((resolve) => { schedule(resolve); }));
