// acard-server sidecar: the Electron shell (desktop/main.cjs) starts it with ACARD_DATA_DIR / ACARD_APP_DIR / ACARD_PORT,
// waits for the READY line, and closes stdin to stop it. Closing stdin also stops it when the shell dies.
// ACARD_LOCAL_API=1 enables tokenless local agents; ACARD_AGENT_TOKEN grants agent-only bearer access (24+ chars).
// ACARD_LITE=1 is the desktop's light local mode (local/lite.ts): plain markdown pages, agents need <data>/agent-token.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { startServer } from "./server";

// ACARD_PORT=0 lets the OS pick a free port; the READY line carries the port actually bound.
const port = Number(process.env.ACARD_PORT || 47811);
const dataDir = process.env.ACARD_DATA_DIR;
const appDir = process.env.ACARD_APP_DIR;
if (!dataDir || !appDir || !existsSync(join(appDir, "editor.html"))) {
  console.error("ACARD_DATA_DIR and ACARD_APP_DIR (with editor.html) are required");
  process.exit(2);
}
// LAN mode (self-host server): ACARD_HOST=0.0.0.0, ACARD_PASSWORD=..., ACARD_ALLOWED_HOSTS=192.168.0.10,notes.lan (or *).
const host = process.env.ACARD_HOST || "127.0.0.1";
const allowedHosts = (process.env.ACARD_ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
const password = process.env.ACARD_PASSWORD || undefined;
const agentToken = process.env.ACARD_AGENT_TOKEN || undefined;
if (agentToken && agentToken.length < 24) {
  console.error("ACARD_AGENT_TOKEN must contain at least 24 characters");
  process.exit(2);
}
// UI language for app pages: en, ko or zh. Unset keeps the Korean source copy.
const lang = process.env.ACARD_LANG || undefined;
let running: ReturnType<typeof startServer>;
try {
  running = startServer({ dataDir, appDir, port, host, allowedHosts, password, lang, localApi: process.env.ACARD_LOCAL_API !== "0", agentToken, lite: process.env.ACARD_LITE === "1" });
} catch (error) {
  console.error(String((error as Error).message || error));
  process.exit(2);
}
console.log("READY http://" + (host === "0.0.0.0" ? "127.0.0.1" : host) + ":" + running!.server.port + "/" + (password ? " (password login on)" : ""));
const stop = () => { running.close(); process.exit(0); };
// Desktop sidecar mode stops when the shell closes stdin. A LAN server (password set) runs under a service manager
// whose stdin is empty, so it only stops on signals.
if (!password) {
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
  process.stdin.resume();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
