import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("local editor accepts typing without a hosted identity and persists it", async () => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port; probe.stop(true);
  const dataDir = mkdtempSync(join(tmpdir(), "acard-input-179-"));
  const child = Bun.spawn(["bun", "local/main.ts"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, ACARD_DATA_DIR: dataDir, ACARD_APP_DIR: join(import.meta.dir, "..", "dist"), ACARD_PORT: String(port), ACARD_PASSWORD: "", ACARD_LITE: "0" },
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  const view = new Bun.WebView({ width: 1200, height: 900 });
  try {
    const reader = child.stdout.getReader();
    const timer = setTimeout(() => child.kill(), 15000);
    try { for (let output = ""; !output.includes("READY");) { const chunk = await reader.read(); if (chunk.done) throw Error("server exited"); output += new TextDecoder().decode(chunk.value); } }
    finally { clearTimeout(timer); reader.releaseLock(); }
    const origin = "http://127.0.0.1:" + port;
    const made = await fetch(origin + "/api/pages", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ slug: "typing-179", title: "Typing" }) });
    expect(made.status).toBe(200);
    await view.navigate(origin + "/edit/typing-179/");
    await view.evaluate(`new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('editor ready')),10000);AcardEditor.on('ready',()=>{clearTimeout(t);resolve();});})`);
    expect(await view.evaluate(`document.getElementById('doc').inert`)).toBe(false);
    await view.evaluate(`document.querySelector('#blocks .text').focus()`);
    await view.cdp("Input.insertText", { text: "Local typing 179" });
    expect(await view.evaluate(`AcardEditor.state.blocks[0].text`)).toBe("Local typing 179");
    await view.evaluate(`AcardEditor.save()`);
    const saved = await (await fetch(origin + "/api/page/typing-179")).json();
    expect(saved.blocks[0].text).toBe("Local typing 179");
    await view.navigate(origin + "/edit/typing-179/");
    await view.evaluate(`new Promise(r=>AcardEditor.on('ready',r))`);
    expect(await view.evaluate(`AcardEditor.state.blocks[0].text`)).toBe("Local typing 179");
  } finally {
    view.close(); child.stdin.end(); await child.exited; rmSync(dataDir, { recursive: true, force: true });
  }
}, 30000);
