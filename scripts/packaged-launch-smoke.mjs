import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const app = resolve(process.argv[2] ?? "dist/mac-arm64/Orchestrion.app");
const expectedVersion = JSON.parse(await readFile(resolve("package.json"), "utf8")).version;
const profile = await mkdtemp(join(tmpdir(), "orclocal-139-launch-"));
const server = createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));

const child = spawn(join(app, "Contents/MacOS/Orchestrion"), [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
], { env: { ...process.env, HOME: profile, CODEX_PATH: "/nonexistent/codex" }, stdio: "ignore" });
const deadline = Date.now() + 15000;
function inspectRenderer(url, expression) {
  return new Promise((done, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); reject(new Error("renderer inspection timed out")); }, 3000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
      expression, returnByValue: true, awaitPromise: true,
    } }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      done(message.result?.result?.value);
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error("renderer inspection failed")); };
  });
}
try {
  let page;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find(target => target.type === "page" && target.url.includes("app.asar/out/renderer/index.html"));
      if (page) break;
    } catch { /* renderer is starting */ }
    await new Promise(done => setTimeout(done, 250));
  }
  assert.ok(page, `packaged renderer did not open (exit=${child.exitCode})`);
  let projectTree = false;
  while (Date.now() < deadline && child.exitCode === null) {
    projectTree = await inspectRenderer(page.webSocketDebuggerUrl,
      'Boolean(document.querySelector(\'[aria-label="Projects, agents and sessions"]\'))');
    if (projectTree) break;
    await new Promise(done => setTimeout(done, 250));
  }
  assert.ok(projectTree, "packaged renderer did not show the Project tree");
  const updateState = await inspectRenderer(page.webSocketDebuggerUrl,
    'window.orchestrion.updaterBridge.getState().then(({ phase, currentVersion }) => ({ phase, currentVersion }))');
  assert.equal(updateState?.currentVersion, expectedVersion, "packaged preload updater bridge did not report app version");
  assert.ok(["idle", "checking", "error"].includes(updateState.phase), "packaged updater state is invalid");
  console.log(JSON.stringify({ result: "PACKAGED_APP_LAUNCH_PASS", renderer: "app.asar/out/renderer/index.html", projectTree,
    updaterBridge: true }));
} finally {
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise(done => setTimeout(done, 5000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true });
}
