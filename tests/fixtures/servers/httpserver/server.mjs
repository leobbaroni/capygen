/**
 * The smallest thing that behaves like a dev server, for
 * `apps/desktop/test/workspaceServers.test.ts`.
 *
 * It binds an ephemeral port when `PORT` is 0 (or absent), and — like every
 * real dev server — *prints the URL it actually bound* before it starts
 * serving. That is what `DevServerService` reads to discover the address
 * (`urlFromLogLine`), and what makes the "stdout URL beats a guessed port"
 * path testable without a framework.
 *
 * `CAPYGEN_FIXTURE_SILENT=1` suppresses the banner, so the *other* discovery
 * path (probe the declared port until it answers) can be exercised by the same
 * fixture.
 */
import http from "node:http";

const requested = Number(process.env.PORT ?? 0);
const silent = process.env.CAPYGEN_FIXTURE_SILENT === "1";

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("capygen fixture dev server\n");
});

server.listen(Number.isInteger(requested) ? requested : 0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requested;
  if (!silent) process.stdout.write(`  ➜  Local:   http://localhost:${port}/\n`);
  else process.stdout.write("fixture listening\n");
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
