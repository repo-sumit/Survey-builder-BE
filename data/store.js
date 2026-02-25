const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const STORE_PATH = path.join(__dirname, 'store.json');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const EMPTY_STORE = { surveys: [], questions: [] };

let writeQueue = Promise.resolve();

async function initStore() {
  await fsp.mkdir(path.dirname(STORE_PATH), { recursive: true });

  try {
    await fsp.access(STORE_PATH);
  } catch {
    await fsp.writeFile(STORE_PATH, JSON.stringify(EMPTY_STORE, null, 2), 'utf8');
  }
}

async function ensureUploadsDir() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
}

async function readStore() {
  await initStore();
  const raw = await fsp.readFile(STORE_PATH, 'utf8');

  if (!raw.trim()) {
    return { ...EMPTY_STORE };
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`store.json contains invalid JSON: ${error.message}`);
  }
}

function enqueueWrite(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

async function writeStore(data) {
  await initStore();
  const serialized = JSON.stringify(data, null, 2);

  return enqueueWrite(async () => {
    const tempPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tempPath, serialized, 'utf8');

    try {
      await fsp.rename(tempPath, STORE_PATH);
    } catch (renameError) {
      await fsp.writeFile(STORE_PATH, serialized, 'utf8');
      await fsp.unlink(tempPath).catch(() => {});
    }
  });
}

module.exports = {
  STORE_PATH,
  UPLOAD_DIR,
  initStore,
  readStore,
  writeStore,
  ensureUploadsDir
};
