import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const htmlPath = resolve(root, "github-profile-preview.html");
const outPng = resolve(root, "assets/profile-fullpage.png");
const outSvg = resolve(root, "assets/profile-fullpage.svg");
const chromeCandidates = [
  process.env.CHROME_BIN,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => existsSync(candidate));

if (!chrome) {
  throw new Error(`Chrome was not found. Checked: ${chromeCandidates.join(", ")}`);
}

await mkdir(dirname(outPng), { recursive: true });

const userDataDir = resolve(process.env.RUNNER_TEMP || "/private/tmp", `profile-chrome-${process.pid}`);
const proc = spawn(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`,
  "about:blank",
], {
  stdio: ["ignore", "ignore", "pipe"],
});

let stderr = "";
let wsBrowserUrl;

proc.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
  const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
  if (match) wsBrowserUrl = match[1];
});

async function waitForDevtools() {
  const started = Date.now();
  while (!wsBrowserUrl) {
    if (Date.now() - started > 10000) {
      throw new Error(`Chrome did not expose DevTools in time:\n${stderr}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return wsBrowserUrl;
}

function rpc(ws) {
  let id = 0;
  const pending = new Map();

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message));
      return;
    }
    entry.resolve(message.result);
  };

  return (method, params = {}) => new Promise((resolveCall, rejectCall) => {
    const callId = ++id;
    pending.set(callId, { resolve: resolveCall, reject: rejectCall });
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
}

async function openWs(url) {
  const ws = new WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.onopen = resolveOpen;
    ws.onerror = rejectOpen;
  });
  return ws;
}

try {
  const browserWsUrl = await waitForDevtools();
  const browserWs = await openWs(browserWsUrl);
  const browserCall = rpc(browserWs);
  const { targetId } = await browserCall("Target.createTarget", {
    url: `file://${htmlPath}`,
  });
  const devtools = new URL(browserWsUrl);
  const targets = await fetch(`http://${devtools.host}/json/list`).then((res) => res.json());
  const pageTarget = targets.find((target) => target.id === targetId);
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error(`Could not find page websocket for target ${targetId}`);
  }

  const pageWs = await openWs(pageTarget.webSocketDebuggerUrl);
  const pageCall = rpc(pageWs);

  await pageCall("Page.enable");
  await pageCall("Runtime.enable");
  await pageCall("Page.navigate", { url: `file://${htmlPath}` });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = await pageCall("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if (ready.result.value === "complete") break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  await pageCall("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const { result } = await pageCall("Runtime.evaluate", {
    expression: `(() => {
      const body = document.body;
      const doc = document.documentElement;
      return {
        width: Math.ceil(Math.max(body.scrollWidth, doc.scrollWidth, body.offsetWidth, doc.offsetWidth)),
        height: Math.ceil(Math.max(body.scrollHeight, doc.scrollHeight, body.offsetHeight, doc.offsetHeight))
      };
    })()`,
    returnByValue: true,
  });

  const { width, height } = result.value;
  await pageCall("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const screenshot = await pageCall("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });

  await writeFile(outPng, Buffer.from(screenshot.data, "base64"));

  const pngBase64 = await readFile(outPng, "base64");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="GitHub profile terminal preview">
  <image href="data:image/png;base64,${pngBase64}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/>
</svg>
`;

  await writeFile(outSvg, svg);
  pageWs.close();
  browserWs.close();
  console.log(`Wrote ${outPng}`);
  console.log(`Wrote ${outSvg}`);
  console.log(`Dimensions ${width}x${height}`);
} finally {
  proc.kill();
  await new Promise((resolveExit) => {
    proc.once("exit", resolveExit);
    setTimeout(resolveExit, 2000);
  });
  await rm(userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 250,
  }).catch((error) => {
    console.warn(`Could not remove temporary Chrome profile: ${error.message}`);
  });
}
