/**
 * [C] The `dev` script of the `node` fixture project (SPEC G6/R18): the
 * smallest thing that behaves like a framework dev server, so
 * `tests/e2e/workspace.spec.ts` can detect it, start it, watch the log tail
 * fill, and see the Browser pane load the URL it printed — with no npm
 * install and no network.
 *
 * It deliberately prints its address in Vite's own shape, because that line
 * is what `DevServerService`'s `urlFromLogLine` reads: discovery must not
 * depend on the declared port, so the fixture proves the stdout path.
 *
 * `tests/fixtures/servers/httpserver/server.mjs` is the *unit* test's
 * equivalent (ephemeral port, silent mode); this one is the e2e's, and is
 * reached through the package.json script + package-manager runner that G6
 * is actually about.
 */
import http from "node:http";

const portFlag = process.argv.indexOf("--port");
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 5199;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>capygen fixture dev server</title><h1>capygen fixture dev server</h1>\n");
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write("\n  VITE-ish dev server ready\n");
  process.stdout.write(`  ➜  Local:   http://localhost:${port}/\n`);
});

// A dev server that ignores SIGTERM is a dev server capygen has to tree-kill;
// this one exits politely so the e2e's Stop is quick.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
