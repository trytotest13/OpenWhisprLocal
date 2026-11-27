const { spawn } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const http = require("http");
const os = require("os");
const path = require("path");

const VOZ_PORT = 8178;
const VOZ_URL = `http://127.0.0.1:${VOZ_PORT}`;
const VOZ_MODEL_ID = "desert-ant-labs/voz";
const HF_BASE_URL = "https://huggingface.co/desert-ant-labs/voz/resolve/main/onnx-fp16";
const VOZ_FILES = [
  "meta.json",
  "vocab.json",
  "embedding.f16",
  "mel.onnx",
  "decoder.onnx",
  "encoder.onnx",
  "encoder.weights",
];
const SKIP_DIRS = new Set([
  "Windows",
  "$Recycle.Bin",
  "System Volume Information",
  "Recovery",
  "node_modules",
  ".git",
  "WinSxS",
  "WindowsApps",
  "ProgramData",
]);
const ALLOW_DOT_DIRS = new Set([
  ".cache",
  ".huggingface",
  ".unsloth",
  ".openwhispr",
  ".whisper",
  ".local",
]);

let vozProcess = null;
let activeModelDir = null;
let startupPromise = null;

function getPortableVozDirs() {
  const execDir = path.dirname(process.execPath || "");
  return [
    path.join(execDir, "voz-models", "onnx-fp16"),
    path.join(process.resourcesPath || "", "voz-models", "onnx-fp16"),
    path.join(os.homedir(), ".cache", "openwhispr", "voz-models", "onnx-fp16"),
  ].filter(Boolean);
}

function hasAllVozFiles(dir) {
  return VOZ_FILES.every((f) => {
    try {
      return fs.statSync(path.join(dir, f)).size > 0;
    } catch {
      return false;
    }
  });
}

async function ensureVozModelFiles(customModelDir) {
  if (customModelDir && hasAllVozFiles(customModelDir)) return customModelDir;
  for (const dir of getPortableVozDirs()) {
    if (hasAllVozFiles(dir)) return dir;
  }

  const { downloadFile } = require("./downloadUtils");
  const fallbackDir = getPortableVozDirs().pop();
  fs.mkdirSync(fallbackDir, { recursive: true });
  for (const file of VOZ_FILES) {
    const dest = path.join(fallbackDir, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    await downloadFile(`${HF_BASE_URL}/${file}`, dest);
  }
  return fallbackDir;
}

function resolveVozBinary() {
  const execDir = path.dirname(process.execPath || "");
  const candidates = [
    path.join(execDir, "resources", "bin", "voz-server-win32-x64.exe"),
    path.join(process.resourcesPath || "", "bin", "voz-server-win32-x64.exe"),
    path.join(__dirname, "..", "..", "resources", "bin", "voz-server-win32-x64.exe"),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function probeVozHttp() {
  return new Promise((resolve) => {
    const req = http.get(`${VOZ_URL}/v1/models`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function stopVozServer() {
  if (!vozProcess) return;
  try {
    vozProcess.kill();
  } catch {}
  vozProcess = null;
  activeModelDir = null;
}

async function ensureLocalVozServer(customModelDir) {
  const rawDir = typeof customModelDir === "string" ? customModelDir.trim() : "";
  const requestedDir = rawDir && path.isAbsolute(rawDir) && hasAllVozFiles(rawDir) ? rawDir : null;
  if (rawDir && !requestedDir) {
    return { ok: false, error: "Invalid or incomplete Voz model directory" };
  }
  if (
    (await probeVozHttp()) &&
    (!requestedDir || !activeModelDir || path.resolve(requestedDir) === path.resolve(activeModelDir))
  ) {
    return { ok: true, url: VOZ_URL, model: VOZ_MODEL_ID, modelDir: activeModelDir };
  }

  if (startupPromise) return startupPromise;

  startupPromise = (async () => {
    try {
      stopVozServer();
      const binary = resolveVozBinary();
      if (!binary) {
        return { ok: false, error: "voz-server-win32-x64.exe not found in resources/bin" };
      }

      const modelDir = await ensureVozModelFiles(requestedDir);
      const child = spawn(binary, [`--http-port=${VOZ_PORT}`, "--num-threads=4"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, VOZ_MODEL_DIR: modelDir },
      });
      vozProcess = child;
      activeModelDir = modelDir;

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Voz server startup timed out")), 30000);
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
          if (stderr.includes("Listening on:")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          if (vozProcess === child) {
            vozProcess = null;
            activeModelDir = null;
          }
          clearTimeout(timer);
          reject(new Error(`Voz server exited early (code ${code}): ${stderr.slice(0, 200)}`));
        });
      });

      return { ok: true, url: VOZ_URL, model: VOZ_MODEL_ID, modelDir };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    } finally {
      startupPromise = null;
    }
  })();

  return startupPromise;
}

function getAvailableDrives() {
  if (process.platform !== "win32") return ["/"];
  const drives = [];
  for (let code = 67; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(root)) drives.push(root);
    } catch {}
  }
  return drives;
}

async function scanLocalModels() {
  const results = [];
  const seen = new Set();

  const addResult = (entry) => {
    const key = `${entry.kind}:${path.resolve(entry.path)}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(entry);
  };

  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const fileNames = new Set();
    const subdirs = [];
    for (const ent of entries) {
      if (ent.isFile()) {
        fileNames.add(ent.name);
        if (
          /^(ggml-.*|.*whisper.*)\.(bin|gguf)$/i.test(ent.name) &&
          !/vocab|silero/i.test(ent.name)
        ) {
          addResult({
            kind: "whisper",
            name: `Whisper (${ent.name})`,
            path: path.join(dir, ent.name),
          });
        }
      } else if (
        ent.isDirectory() &&
        !SKIP_DIRS.has(ent.name) &&
        (!ent.name.startsWith(".") || ALLOW_DOT_DIRS.has(ent.name))
      ) {
        subdirs.push(path.join(dir, ent.name));
      }
    }

    if (
      fileNames.has("mel.onnx") &&
      fileNames.has("encoder.onnx") &&
      fileNames.has("decoder.onnx") &&
      fileNames.has("vocab.json") &&
      fileNames.has("meta.json")
    ) {
      addResult({
        kind: "voz",
        name: `Voz (${path.basename(dir)})`,
        path: dir,
      });
    } else if (
      fileNames.has("tokens.txt") &&
      [...fileNames].some((f) => /^encoder.*\.onnx$/i.test(f))
    ) {
      addResult({
        kind: "parakeet",
        name: `Parakeet (${path.basename(dir)})`,
        path: dir,
      });
    }

    await Promise.all(subdirs.map((sub) => walk(sub, depth + 1)));
  }

  // Always check portable & user cache locations first (including hidden .cache)
  const priorityRoots = [
    ...getPortableVozDirs().map((d) => path.dirname(d)),
    path.join(os.homedir(), ".cache", "openwhispr"),
  ];
  await Promise.all(priorityRoots.map((r) => walk(r, 0)));

  // Scan every mounted drive up to depth 4
  const drives = getAvailableDrives();
  await Promise.all(drives.map((drive) => walk(drive, 0)));

  return results;
}

async function transcribeLocalVoz(audioBuffer, modelDir) {
  const started = await ensureLocalVozServer(modelDir);
  if (!started?.ok) {
    return { success: false, error: started?.error || "Failed to start local Voz server" };
  }

  const boundary = `----voz${Date.now().toString(16)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${VOZ_MODEL_ID}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    "utf8"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, Buffer.from(audioBuffer), tail]);

  return new Promise((resolve) => {
    const req = http.request(
      `${VOZ_URL}/v1/audio/transcriptions`,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
        timeout: 60000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            resolve({ success: false, error: `Voz HTTP ${res.statusCode}: ${raw}` });
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            resolve({ success: true, text: typeof parsed.text === "string" ? parsed.text : "" });
          } catch (e) {
            resolve({ success: false, error: `Invalid Voz response: ${e.message}` });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, error: "Local Voz transcription timed out" });
    });
    req.write(body);
    req.end();
  });
}

module.exports = {
  ensureLocalVozServer,
  scanLocalModels,
  transcribeLocalVoz,
};
