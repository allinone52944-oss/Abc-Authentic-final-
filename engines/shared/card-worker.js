'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

function runCardPython(script, args, cwd) {
    return new Promise((resolve) => {
        execFile(PYTHON, [script, ...args], {
            cwd,
            timeout: 120000,
            killSignal: 'SIGKILL',
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                exitCode: error && typeof error.code === 'number' ? error.code : error ? null : 0,
                signal: error?.signal || null,
                timedOut: Boolean(error?.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'),
                stdout: stdout || '',
                stderr: stderr || '',
            });
        });
    });
}

const templates = new Map();
async function prepareCardTemplate(engineDir, cwd) {
    const pdf = path.join(engineDir, 'output_template.pdf');
    const script = path.join(engineDir, 'extract_template.py');
    const work = path.join(cwd, 'work');
    const templatePath = path.join(work, 'template.json');
    const mapPath = path.join(work, 'image_map.json');
    const versions = await Promise.all([fs.stat(pdf), fs.stat(script)]);
    const version = versions.map(file => `${file.size}:${file.mtimeMs}:${file.ctimeMs}`).join('|');
    let cached = templates.get(engineDir);
    if (!cached || cached.version !== version) {
        const result = await runCardPython(script, [pdf], cwd);
        if (result.ok) {
            // Cache only template data. Replacement paths belong to one upload.
            const template = await fs.readFile(templatePath);
            const slots = JSON.parse(await fs.readFile(mapPath, 'utf8'));
            for (const slot of Object.values(slots)) slot.replace_with = null;
            templates.set(engineDir, { version, template, slots });
        }
        return result;
    }

    const images = await fs.readFile(path.join(work, 'input_images.json'), 'utf8')
        .then(JSON.parse).catch(() => ({}));
    const map = Object.fromEntries(Object.entries(cached.slots).map(([id, slot]) => [
        id, { ...slot, replace_with: slot.kind === 'photo' || slot.kind === 'sign' ? images[slot.kind] ?? null : null },
    ]));
    await Promise.all([
        fs.writeFile(templatePath, cached.template),
        fs.writeFile(mapPath, JSON.stringify(map)),
    ]);
    return { ok: true };
}

// Both card engines share the same worker slot. Keep an entire job
// together because retries for one job use the same files on disk.
let queue = Promise.resolve();
function queueCardJob(operation) {
    return (...args) => {
        const result = queue.then(() => operation(...args));
        queue = result.catch(() => {});
        return result;
    };
}

module.exports = { PYTHON, runCardPython, prepareCardTemplate, queueCardJob };
