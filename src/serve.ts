#!/usr/bin/env node
import { createTriageServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
// Loopback by default: the endpoint has no auth of its own.
const host = process.env.HOST ?? "127.0.0.1";

const server = createTriageServer();
server.listen(port, host, () => {
  console.log(`reply-triage listening on http://${host}:${port} (POST /triage, GET /healthz)`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
