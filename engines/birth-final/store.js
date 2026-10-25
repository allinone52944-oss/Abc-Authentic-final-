'use strict';
/**
 * store.js - record storage for the certificate engine.
 *
 * Two modes, chosen automatically:
 *   Oracle : set env ORACLE_CONN_STR + ORACLE_USER + ORACLE_PASSWORD
 *            (e.g. ORACLE_CONN_STR=localhost:1521/XEPDB1  or  host:port/service)
 *            uses node-oracledb thin driver (no Instant Client needed for TCP)
 *   File   : default fallback - JSON file at _data/records.json (works offline)
 *
 * Record shape: { number, name, key, verifyUrl, keySource, payload (free-form JSON) }
 * Table is created automatically on first Oracle use (idempotent).
 */
const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, '_data', 'records.json');
const TABLE = 'CERT_RECORDS';

const CONN_STR = process.env.ORACLE_CONN_STR || '';
const USER = process.env.ORACLE_USER || '';
const PASSWORD = process.env.ORACLE_PASSWORD || '';

const oracleConfigured = Boolean(CONN_STR && USER && PASSWORD);
const mode = oracleConfigured ? 'oracle' : 'file';

let pool = null;
let tableReady = false;
// Oracle configured kintu runtime-e unreachable hole: sticky degrade -> file.
// Data loss hobe na, service cholbe; health() degraded:true janabe.
let degraded = false;
function markDegraded(e) {
    if (!degraded) {
        degraded = true;
        try { fs.appendFileSync(path.join(__dirname, 'server.log'), new Date().toISOString() + ' STORE-DEGRADED (oracle->file): ' + (e && e.message || e) + '\n'); } catch (_) {}
    }
}

async function getPool() {
    if (pool) return pool;
    const oracledb = require('oracledb');
    pool = await oracledb.createPool({
        user: USER,
        password: PASSWORD,
        connectString: CONN_STR,
        poolMin: 0,
        poolMax: 4,
        poolIncrement: 1
    });
    return pool;
}

async function ensureTable() {
    if (tableReady) return;
    const p = await getPool();
    const conn = await p.getConnection();
    try {
        await conn.execute(`
            BEGIN
                EXECUTE IMMEDIATE 'CREATE TABLE ${TABLE} (
                    cert_number VARCHAR2(17) PRIMARY KEY,
                    name_en     VARCHAR2(200),
                    verify_key  VARCHAR2(128),
                    verify_url  VARCHAR2(400),
                    payload     CLOB,
                    created_at  TIMESTAMP DEFAULT SYSTIMESTAMP,
                    updated_at  TIMESTAMP DEFAULT SYSTIMESTAMP
                )';
            EXCEPTION
                WHEN OTHERS THEN
                    IF SQLCODE != -955 THEN RAISE; END IF;
            END`);
        tableReady = true;
    } finally {
        await conn.close();
    }
}

function fileRead() {
    try {
        return JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    } catch (e) {
        return {};
    }
}

function fileWrite(map) {
    // Atomic write: write to a unique temp file in the same directory, then
    // rename over records.json. A crash mid-write can no longer leave a
    // half-written JSON file; readers always see the old or the new file.
    const dir = path.dirname(FILE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.records.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2) + '.tmp');
    try {
        fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
        fs.renameSync(tmp, FILE_PATH);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw e;
    }
}

async function saveRecord(rec) {
    if (!rec || !rec.number) throw new Error('number is required');
    const payload = JSON.stringify(rec.payload == null ? {} : rec.payload);
    if (mode === 'oracle' && !degraded) {
        try {
            await ensureTable();
            const p = await getPool();
            const conn = await p.getConnection();
            try {
                await conn.execute(
                    `MERGE INTO ${TABLE} t
                     USING (SELECT :n AS cert_number FROM dual) s
                     ON (t.cert_number = s.cert_number)
                     WHEN MATCHED THEN UPDATE SET
                         name_en = :name, verify_key = :key, verify_url = :url,
                         payload = :payload, updated_at = SYSTIMESTAMP
                     WHEN NOT MATCHED THEN INSERT (cert_number, name_en, verify_key, verify_url, payload)
                         VALUES (:n, :name, :key, :url, :payload)`,
                    { n: rec.number, name: rec.name || null, key: rec.key || null,
                      url: rec.verifyUrl || null, payload },
                    { outFormat: require('oracledb').OUT_FORMAT_OBJECT }
                );
                await conn.commit();
            } finally {
                await conn.close();
            }
            return { savedTo: mode };
        } catch (e) { markDegraded(e); }
    }
    const map = fileRead();
    const prev = map[rec.number] || {};
    map[rec.number] = {
        number: rec.number,
        name: rec.name != null ? rec.name : prev.name || null,
        key: rec.key || prev.key || null,
        verifyUrl: rec.verifyUrl || prev.verifyUrl || null,
        keySource: rec.keySource || prev.keySource || null,
        payload: rec.payload != null ? rec.payload : (prev.payload != null ? prev.payload : {}),
        createdAt: prev.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    fileWrite(map);
    return { savedTo: degraded ? 'file (oracle-down fallback)' : mode };
}

async function getRecord(number) {
    if (mode === 'oracle' && !degraded) {
        try {
            await ensureTable();
            const p = await getPool();
            const conn = await p.getConnection();
            try {
                const r = await conn.execute(
                    `SELECT name_en, verify_key, verify_url, payload, created_at, updated_at
                     FROM ${TABLE} WHERE cert_number = :n`,
                    { n: number },
                    { outFormat: require('oracledb').OUT_FORMAT_OBJECT }
                );
                if (!r.rows.length) return null;
                const row = r.rows[0];
                let payload = {};
                try { payload = row.PAYLOAD ? JSON.parse(row.PAYLOAD) : {}; } catch (e) {}
                return {
                    number,
                    name: row.NAME_EN || null,
                    key: row.VERIFY_KEY || null,
                    verifyUrl: row.VERIFY_URL || null,
                    payload,
                    createdAt: row.CREATED_AT ? new Date(row.CREATED_AT).toISOString() : null,
                    updatedAt: row.UPDATED_AT ? new Date(row.UPDATED_AT).toISOString() : null
                };
            } finally {
                await conn.close();
            }
        } catch (e) { markDegraded(e); }
    }
    const rec = fileRead()[number] || null;
    return rec;
}

async function listRecords(limit) {
    limit = Math.min(parseInt(limit, 10) || 50, 500);
    if (mode === 'oracle' && !degraded) {
        try {
            await ensureTable();
            const p = await getPool();
            const conn = await p.getConnection();
            try {
                const r = await conn.execute(
                    `SELECT cert_number, name_en, verify_key, updated_at FROM ${TABLE}
                     ORDER BY updated_at DESC FETCH FIRST :l ROWS ONLY`,
                    { l: limit },
                    { outFormat: require('oracledb').OUT_FORMAT_OBJECT }
                );
                return r.rows.map(row => ({
                    number: row.CERT_NUMBER,
                    name: row.NAME_EN || null,
                    key: row.VERIFY_KEY || null,
                    updatedAt: row.UPDATED_AT ? new Date(row.UPDATED_AT).toISOString() : null
                }));
            } finally {
                await conn.close();
            }
        } catch (e) { markDegraded(e); }
    }
    const map = fileRead();
    return Object.values(map)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, limit)
        .map(r => ({ number: r.number, name: r.name, key: r.key, updatedAt: r.updatedAt }));
}

async function health() {
    if (mode === 'oracle') {
        try {
            await ensureTable();
            return { mode, ok: true, degraded };
        } catch (e) {
            markDegraded(e);
            return { mode, ok: true, degraded: true, fallback: 'file', error: e.message };
        }
    }
    return { mode, ok: true, file: FILE_PATH };
}

module.exports = { saveRecord, getRecord, listRecords, health, mode };
