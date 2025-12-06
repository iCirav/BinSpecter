import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

type Edit = { offset: number; value: number; prev: number };
type RangeRequest = { offset: number; length: number };

interface EditorState {
    uri: vscode.Uri;
    panel: vscode.WebviewPanel;
    fileSize: number;
    undoStack: Edit[];
    redoStack: Edit[];
    edited: Map<number, number>;
    lastSelectedOffset?: number;
    lastEndian?: 'le' | 'be';
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('hexEditor.openFile', async (uriArg: vscode.Uri, second?: any) => {
            const fileUri = (uriArg && uriArg.fsPath) ? uriArg : (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : undefined);
            if (!fileUri) {
                vscode.window.showErrorMessage('No file selected to open in hex editor.');
                return;
            }

            try {
                const stat = await fsStat(fileUri.fsPath);
                const fileSize = stat.size;

                const panel = vscode.window.createWebviewPanel(
                    'hexEditor',
                    `Hex Editor — ${path.basename(fileUri.fsPath)}`,
                    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
                    {
                        enableScripts: true,
                        localResourceRoots: [vscode.Uri.file(context.extensionPath)]
                    }
                );

                const state: EditorState = {
                    uri: fileUri,
                    panel,
                    fileSize,
                    undoStack: [],
                    redoStack: [],
                    edited: new Map(),
                    lastEndian: 'le'
                };

                panel.webview.html = getWebviewContent(panel.webview, context.extensionPath);

                panel.webview.onDidReceiveMessage(async (msg) => {
                    try {
                        await handleMessage(msg, state);
                    } catch (err) {
                        console.error('Error handling msg', err);
                        vscode.window.showErrorMessage(String(err));
                    }
                }, undefined, context.subscriptions);

                panel.onDidDispose(() => {
                    // allow GC
                }, null, context.subscriptions);

            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open file: ${err}`);
            }
        })
    );
}

async function handleMessage(msg: any, state: EditorState) {
    const panel = state.panel;
    const fsPath = state.uri.fsPath;

    switch (msg.type) {
        case 'getFileSize':
            panel.webview.postMessage({ type: 'fileSize', size: state.fileSize });
            break;

        case 'requestRange':
            {
                const r: RangeRequest = msg.range;
                const buf = await readRange(fsPath, r.offset, r.length);
                panel.webview.postMessage({ type: 'range', offset: r.offset, data: buf.toString('base64') });
            }
            break;

        case 'edit':
            {
                const { offset, value } = msg;
                const prev = await readByte(fsPath, offset, state.edited);
                state.edited.set(offset, value);
                state.undoStack.push({ offset, value, prev });
                state.redoStack = [];
                panel.webview.postMessage({ type: 'edited', offset, value });
            }
            break;

        case 'save':
            await applyEditsToFile(fsPath, state.edited);
            state.edited.clear();
            state.undoStack = [];
            state.redoStack = [];
            vscode.window.showInformationMessage(`Saved ${path.basename(fsPath)}`);
            panel.webview.postMessage({ type: 'saved' });
            break;

        case 'undo':
            {
                const e = state.undoStack.pop();
                if (e) {
                    // revert to prev
                    state.edited.set(e.offset, e.prev);
                    state.redoStack.push(e);
                    panel.webview.postMessage({ type: 'edited', offset: e.offset, value: e.prev });
                } else {
                    vscode.window.showInformationMessage('Nothing to undo');
                }
            }
            break;

        case 'redo':
            {
                const e = state.redoStack.pop();
                if (e) {
                    state.edited.set(e.offset, e.value);
                    state.undoStack.push(e);
                    panel.webview.postMessage({ type: 'edited', offset: e.offset, value: e.value });
                } else {
                    vscode.window.showInformationMessage('Nothing to redo');
                }
            }
            break;

        case 'search':
            {
                const results = await searchInFile(fsPath, msg.query, msg.isHex);
                panel.webview.postMessage({ type: 'searchResults', results });
            }
            break;

        case 'exportArray':
            {
                const arrText = await exportAsArray(fsPath, msg.format, state.edited);
                panel.webview.postMessage({ type: 'export', text: arrText });
            }
            break;

        case 'selectByte':
            {
                const offset: number = msg.offset;
                state.lastSelectedOffset = offset;
                // read up to 8 bytes from offset (or available)
                const length = Math.min(8, Math.max(1, state.fileSize - offset));
                const buf = await readRange(fsPath, offset, length);
                const interpreted = interpretBytes(buf, 0, offset, state.lastEndian || 'le', fsPath);
                panel.webview.postMessage({ type: 'interpretation', data: interpreted });
            }
            break;

        case 'recalculateInterpretation':
            {
                const endian = (msg.endian === 'be') ? 'be' : 'le';
                state.lastEndian = endian;
                const offset = state.lastSelectedOffset ?? 0;
                const length = Math.min(8, Math.max(1, state.fileSize - offset));
                const buf = await readRange(fsPath, offset, length);
                const interpreted = interpretBytes(buf, 0, offset, endian, fsPath);
                panel.webview.postMessage({ type: 'interpretation', data: interpreted });
            }
            break;

        default:
            console.warn('Unknown message', msg);
    }
}

function interpretBytes(buffer: Buffer, relativeOffset: number, absoluteOffset: number, endian: 'le' | 'be', filePath: string) {
    // buffer is the bytes starting at absoluteOffset (relativeOffset usually 0)
    function safe<T>(fn: () => T): T | null {
        try { return fn(); } catch { return null; }
    }

    const bytesArray = Array.from(buffer.slice(relativeOffset, relativeOffset + 8));
    const readLE = (n: number) => { if (buffer.length >= relativeOffset + n) return safe(() => buffer.readUIntLE(relativeOffset, n)); return null; };
    const readBE = (n: number) => { if (buffer.length >= relativeOffset + n) return safe(() => buffer.readUIntBE(relativeOffset, n)); return null; };

    const readIntLE = (n: number) => { if (buffer.length >= relativeOffset + n) return safe(() => buffer.readIntLE(relativeOffset, n)); return null; };
    const readIntBE = (n: number) => { if (buffer.length >= relativeOffset + n) return safe(() => buffer.readIntBE(relativeOffset, n)); return null; };

    const le = endian === 'le';

    const u8 = safe(() => buffer.readUInt8(relativeOffset));
    const i8 = safe(() => buffer.readInt8(relativeOffset));

    const u16 = le ? readLE(2) : readBE(2);
    const i16 = le ? readIntLE(2) : readIntBE(2);
    const u32 = le ? readLE(4) : readBE(4);
    const i32 = le ? readIntLE(4) : readIntBE(4);

    const f32 = safe(() => le ? buffer.readFloatLE(relativeOffset) : buffer.readFloatBE(relativeOffset));
    const f64 = safe(() => le ? buffer.readDoubleLE(relativeOffset) : buffer.readDoubleBE(relativeOffset));

    const ascii = safe(() => buffer.slice(relativeOffset, relativeOffset + 8).toString('ascii').replace(/[^\x20-\x7E]/g, '.'));
    const utf8 = safe(() => buffer.slice(relativeOffset, relativeOffset + 8).toString('utf8').replace(/\uFFFD/g, '.'));
    const utf16le = safe(() => buffer.slice(relativeOffset, relativeOffset + 8).toString('utf16le').replace(/\uFFFD/g, '.'));

    const unix_le = (u32 !== null) ? u32 : null;
    const unix_be = null; // already covered above if needed

    return {
        endian,
        offset: absoluteOffset,
        bytes: bytesArray,
        uint8: u8,
        int8: i8,
        uint16: u16,
        int16: i16,
        uint32: u32,
        int32: i32,
        float32: f32,
        float64: f64,
        ascii,
        utf8,
        utf16le,
        unix_le
    };
}

async function fsStat(pathStr: string): Promise<fs.Stats> {
    return new Promise((resolve, reject) => fs.stat(pathStr, (err, s) => err ? reject(err) : resolve(s)));
}

async function readRange(filePath: string, offset: number, length: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { start: offset, end: Math.max(0, offset + length - 1) });
        const chunks: Buffer[] = [];
        stream.on('data', c => chunks.push(Buffer.from(c)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', e => reject(e));
    });
}

async function readByte(filePath: string, offset: number, edited: Map<number, number>): Promise<number> {
    if (edited.has(offset)) return edited.get(offset)!;
    return new Promise<number>((resolve, reject) => {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(1);
        try {
            fs.readSync(fd, buf, 0, 1, offset);
            fs.closeSync(fd);
            resolve(buf[0]);
        } catch (e) {
            try { fs.closeSync(fd); } catch {}
            reject(e);
        }
    });
}

async function applyEditsToFile(filePath: string, edited: Map<number, number>): Promise<void> {
    if (edited.size === 0) return;
    const tmp = `${filePath}.vscode-hex-edit.tmp`;
    return new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(filePath);
        const writeStream = fs.createWriteStream(tmp);
        let pos = 0;
        readStream.on('data', (chunk: Buffer) => {
            for (let i = 0; i < chunk.length; ++i, ++pos) {
                if (edited.has(pos)) {
                    chunk[i] = edited.get(pos)!;
                }
            }
            writeStream.write(chunk);
        });
        readStream.on('end', () => writeStream.end());
        writeStream.on('finish', () => {
            fs.rename(tmp, filePath, (err) => err ? reject(err) : resolve());
        });
        readStream.on('error', e => reject(e));
        writeStream.on('error', e => reject(e));
    });
}

async function searchInFile(filePath: string, query: string, isHex: boolean): Promise<number[]> {
    const data = await fs.promises.readFile(filePath);
    let needle: Buffer;
    if (isHex) {
        const cleaned = query.replace(/\s+/g, '');
        const bytes: number[] = [];
        for (let i = 0; i < cleaned.length; i += 2) {
            const hex = cleaned.substr(i, 2);
            const val = parseInt(hex, 16);
            if (isNaN(val)) return [];
            bytes.push(val);
        }
        needle = Buffer.from(bytes);
    } else {
        needle = Buffer.from(query, 'utf8');
    }
    const results: number[] = [];
    for (let i = 0; i <= data.length - needle.length; i++) {
        let match = true;
        for (let j = 0; j < needle.length; j++) {
            if (data[i + j] !== needle[j]) { match = false; break; }
        }
        if (match) results.push(i);
    }
    return results;
}

async function exportAsArray(filePath: string, format: string, edited: Map<number, number>): Promise<string> {
    const buf = await fs.promises.readFile(filePath);
    for (const [offset, val] of edited.entries()) {
        if (offset >= 0 && offset < buf.length) buf[offset] = val;
    }
    if (format === 'c') {
        const arr = Array.from(buf).map(b => `0x${b.toString(16).padStart(2, '0')}`);
        return `unsigned char data[] = { ${arr.join(', ')} };`;
    } else if (format === 'rust') {
        const arr = Array.from(buf).map(b => `0x${b.toString(16).padStart(2, '0')}`);
        return `const DATA: [u8; ${buf.length}] = [ ${arr.join(', ')} ];`;
    } else {
        return buf.toString('hex').match(/.{1,2}/g)?.join(' ') ?? '';
    }
}

function getWebviewContent(webview: vscode.Webview, extensionPath: string): string {
    const nonce = getNonce();
    // Put everything inline to avoid bundling complexity for starter
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} blob: data:; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hex Editor</title>
<style nonce="${nonce}">
:root {
  --bg:#0f0f13; --panel:#151518; --muted:#9aa0a6; --accent:#66d9ef; --font: 13px/1.3 'SFMono-Regular', Menlo, Monaco, monospace;
  --ansi-bright-black: #555555;
  --ansi-bright-blue: #4BA3FF;
  --ansi-bright-magenta: #FF66FF;
  --ansi-bright-yellow: #FFEB3B;
}
html,body { margin:0; height:100%; background:var(--bg); color:#eee; font-family: monospace; }
.toolbar { display:flex; gap:8px; padding:8px; background:var(--panel); align-items:center; }
button { background:#222; border:1px solid #333; color:#ddd; padding:6px 8px; border-radius:4px; cursor:pointer; }
input[type="text"] { padding:6px; border-radius:4px; border:1px solid #333; background:#0b0b0b; color:#fff; }
.container { display:flex; height: calc(100% - 44px); }
.hexPanel { overflow:auto; flex:1; padding:12px; }
.table { border-collapse:collapse; width:100%; }
td { padding:2px 6px; vertical-align:top; font: var(--font); }
.offset { color:var(--muted); width:120px; }
.hex-byte { width:28px; text-align:center; cursor:default; user-select:none; }
.hex-byte.selected { outline:1px solid var(--accent); background:rgba(102,217,239,0.06); }
.hex-byte.edited { background: linear-gradient(90deg, rgba(255,234,138,0.15), rgba(255,234,138,0.05)); }
.ascii { padding-left:16px; color:#c7c7c7; }
.status { padding:6px; color:var(--muted); font-size:12px; }
/* ANSI categories */
.hex-byte.cat-nonprintable { color: var(--ansi-bright-black); }
.hex-byte.cat-null { color: var(--ansi-bright-blue); font-weight:700; }
.hex-byte.cat-repeat-single { color: var(--ansi-bright-magenta); }
.hex-byte.cat-repeat-multi { color: var(--ansi-bright-yellow); font-weight:700; }
.highlight-category { background: rgba(255,255,255,0.06); }
/* inspector */
.inspector { width:320px; border-left:1px solid #222; padding:10px; background:#0c0c0d; overflow:auto; }
.endian-btn { background:#333; color:#eee; border:1px solid #666; margin-right:4px; padding:2px 6px; cursor:pointer; }
.endian-btn.active { background:#4b8cff; }
.bit-row { font-family: monospace; padding: 4px 0; color: #9cf; word-spacing: 6px; letter-spacing: 1px; }
.bit { padding:1px 3px; cursor:pointer; display:inline-block; }
.bit:hover { background:#444; }
.bit.highlight { background:#4b8cff !important; color:#000; }
.hex-byte.highlight { background:#444 !important; border-radius:3px; }
.nibble { display:inline-block; }
</style>
</head>
<body>
<div class="toolbar">
  <button id="btnSave">Save</button>
  <button id="btnUndo">Undo</button>
  <button id="btnRedo">Redo</button>
  <button id="btnCopyC">Copy as C array</button>
  <button id="btnCopyRust">Copy as Rust array</button>
  <label class="small">Search:</label>
  <input id="searchBox" placeholder="ASCII or hex (e.g. 0a ff)" />
  <button id="btnSearch">Search</button>
  <label class="small">Goto:</label>
  <input id="gotoBox" placeholder="offset (decimal or 0xhex)" style="width:100px" />
  <button id="btnGoto">Go</button>
  <div style="flex:1"></div>
  <div class="status" id="status">Ready</div>
</div>
<div class="container">
  <div class="hexPanel" id="hexPanel" tabindex="0"></div>
  <div class="inspector" id="inspector">
    <div style="display:flex; align-items:center; gap:8px;">
      <div><b>Interpretation</b></div>
      <div style="flex:1"></div>
      <div>
        <button id="endian-le" class="endian-btn active">LE</button>
        <button id="endian-be" class="endian-btn">BE</button>
      </div>
    </div>
    <div id="interpContent" style="margin-top:10px; font-size:13px; color:#ddd;"></div>
    <div style="margin-top:12px;"><b>Bit Viewer</b></div>
    <div id="bits-8" class="bit-row"></div>
    <div id="bits-16" class="bit-row"></div>
    <div id="bits-32" class="bit-row"></div>
    <div id="bits-64" class="bit-row"></div>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let fileSize = 0;
const BYTES_PER_LINE = 16;
const LINES_PER_PAGE = 64;
const PAGE_BYTES = BYTES_PER_LINE * LINES_PER_PAGE;

let visibleOffset = 0;
let bytesCache = new Map();
let edited = new Map();
let selection = { offset: 0 };
let lastEndian = 'le';

// Helpers
function b64ToBuf(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function bufToHex(arr) { return Array.from(arr).map(x => x.toString(16).padStart(2,'0').toUpperCase()); }
function escapeHTML(text) { if (!text) return ''; return text.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

function requestRange(offset, length) { vscode.postMessage({ type: 'requestRange', range: { offset, length } }); }
function renderPage(offset) {
  visibleOffset = offset;
  document.getElementById('status').textContent = 'Loading...';
  requestRange(offset, PAGE_BYTES);
}

function analyzeBytesForCategories(arr) {
  // arr is Uint8Array
  const cats = new Array(arr.length).fill('normal');
  // non-printable
  for (let i=0;i<arr.length;i++){
    const b = arr[i];
    if (b < 0x20 || b > 0x7E) cats[i] = 'nonprintable';
  }
  // nulls
  for (let i=0;i<arr.length;i++) if (arr[i] === 0x00) cats[i] = 'null';
  // repeated single bytes
  for (let i=1;i<arr.length;i++){
    if (arr[i] === arr[i-1]) { cats[i]='repeat-single'; if (!cats[i-1] || cats[i-1]==='normal' || cats[i-1]==='nonprintable') cats[i-1]='repeat-single'; }
  }
  // multi-byte repeats (2,4,8)
  for (let size of [2,4,8]) {
    for (let i=0; i + size*2 <= arr.length; i++) {
      let a = '', b = '';
      for (let k=0;k<size;k++){ a += ','+arr[i+k]; b += ','+arr[i+size+k]; }
      if (a===b) {
        for (let k=0;k<size*2;k++) cats[i+k] = 'repeat-multi';
      }
    }
  }
  return cats;
}

function createTableForBuffer(offset, arrUint8) {
  const area = document.getElementById('hexPanel');
  area.innerHTML = '';
  const cats = analyzeBytesForCategories(arrUint8);
  const table = document.createElement('table');
  table.className = 'table';
  const lines = Math.ceil(arrUint8.length / BYTES_PER_LINE);
  for (let r=0;r<lines;r++){
    const tr = document.createElement('tr');
    const off = offset + r * BYTES_PER_LINE;
    const tdOff = document.createElement('td'); tdOff.className='offset'; tdOff.textContent = off.toString(16).padStart(8,'0');
    tr.appendChild(tdOff);
    for (let c=0;c<BYTES_PER_LINE;c++){
      const idx = r*BYTES_PER_LINE + c;
      const td = document.createElement('td');
      td.className = 'hex-byte';
      td.dataset.offset = String(off + c);
      if (idx < arrUint8.length) {
        const val = edited.has(off + c) ? edited.get(off + c) : arrUint8[idx];
        const hex = val.toString(16).padStart(2,'0').toUpperCase();
        td.textContent = hex;
        td.dataset.hex = hex;
        if (edited.has(off + c)) td.classList.add('edited');
        if (off + c === selection.offset) td.classList.add('selected');
        // category class
        const cat = cats[idx];
        if (cat && cat !== 'normal') td.classList.add('cat-'+cat);
        td.addEventListener('click', onByteClick);
        td.addEventListener('dblclick', (e)=> onByteDblClick(e, td));
        td.addEventListener('mouseenter', ()=> onHexHoverEnter(td));
        td.addEventListener('mouseleave', ()=> clearHighlights());
      } else {
        td.textContent = '';
      }
      tr.appendChild(td);
    }
    // ascii
    const tdAscii = document.createElement('td'); tdAscii.className='ascii';
    let ascii=''; for (let c=0;c<BYTES_PER_LINE;c++){
      const idx = r*BYTES_PER_LINE + c;
      if (idx < arrUint8.length) {
        const val = edited.has(off + c) ? edited.get(off + c) : arrUint8[idx];
        ascii += (val >= 32 && val <= 126) ? String.fromCharCode(val) : '.';
      } else ascii += ' ';
    }
    tdAscii.textContent = ascii;
    tr.appendChild(tdAscii);
    table.appendChild(tr);
  }
  area.appendChild(table);
  document.getElementById('status').textContent = \`Showing \${offset} - \${Math.min(offset + arrUint8.length - 1, fileSize - 1)} (file size: \${fileSize})\`;
  wireHexCells();
}

function onByteClick(e) {
  const off = Number(e.currentTarget.dataset.offset);
  selectOffset(off);
  vscode.postMessage({ type: 'selectByte', offset: off });
}

function onByteDblClick(e, element) {
  const off = Number(element.dataset.offset);
  startEdit(off, element);
}

function startEdit(offset, element) {
  const input = document.createElement('input');
  input.type = 'text';
  const current = element.dataset.hex ?? element.textContent.trim();
  input.value = current;
  input.style.width = '36px';
  input.style.font = 'inherit';
  element.innerHTML = '';
  element.appendChild(input);
  input.focus(); input.select();
  input.addEventListener('blur', ()=> finishEdit(offset, input, element));
  input.addEventListener('keydown', (ev)=> {
    if (ev.key === 'Enter') input.blur();
    else if (ev.key === 'Escape') {
      element.textContent = current;
    }
  });
}

function finishEdit(offset, input, element) {
  const raw = input.value.trim();
  const parsed = parseInt(raw, 16);
  if (isNaN(parsed) || parsed < 0 || parsed > 255) {
    element.textContent = (edited.has(offset) ? edited.get(offset) : Number(element.textContent)).toString(16).padStart(2,'0').toUpperCase();
    element.classList.remove('edited');
    return;
  }
  edited.set(offset, parsed);
  vscode.postMessage({ type: 'edit', offset, value: parsed });
  element.textContent = parsed.toString(16).padStart(2,'0').toUpperCase();
  element.dataset.hex = element.textContent;
  element.classList.add('edited');
}

function selectOffset(off) {
  selection.offset = off;
  document.querySelectorAll('.hex-byte.selected').forEach(n => n.classList.remove('selected'));
  const el = document.querySelector('.hex-byte[data-offset="'+off+'"]');
  if (el) el.classList.add('selected');
}

function wireToolbar() {
  document.getElementById('btnSave').addEventListener('click', ()=> vscode.postMessage({ type:'save' }));
  document.getElementById('btnUndo').addEventListener('click', ()=> vscode.postMessage({ type:'undo' }));
  document.getElementById('btnRedo').addEventListener('click', ()=> vscode.postMessage({ type:'redo' }));
  document.getElementById('btnSearch').addEventListener('click', ()=> {
    const q = (document.getElementById('searchBox') as HTMLInputElement).value.trim();
    if (!q) return;
    const isHex = /^[0-9a-fA-F\\s]+$/.test(q) && q.length >= 2;
    vscode.postMessage({ type: 'search', query: q, isHex });
    document.getElementById('status').textContent = 'Searching...';
  });
  document.getElementById('btnGoto').addEventListener('click', ()=> {
    const v = (document.getElementById('gotoBox') as HTMLInputElement).value.trim();
    if (!v) return;
    const offset = v.startsWith('0x') ? parseInt(v,16) : parseInt(v,10);
    if (isNaN(offset)) { document.getElementById('status').textContent = 'Invalid offset'; return; }
    const base = Math.floor(offset / BYTES_PER_LINE) * BYTES_PER_LINE;
    renderPage(base);
  });
  document.getElementById('btnCopyC').addEventListener('click', ()=> vscode.postMessage({ type:'exportArray', format:'c' }));
  document.getElementById('btnCopyRust').addEventListener('click', ()=> vscode.postMessage({ type:'exportArray', format:'rust' }));
  document.getElementById('endian-le').addEventListener('click', ()=> { lastEndian='le'; updateEndianButtons(); vscode.postMessage({ type:'recalculateInterpretation', endian:'le' }); });
  document.getElementById('endian-be').addEventListener('click', ()=> { lastEndian='be'; updateEndianButtons(); vscode.postMessage({ type:'recalculateInterpretation', endian:'be' }); });
}

function updateEndianButtons() {
  document.getElementById('endian-le').classList.toggle('active', lastEndian === 'le');
  document.getElementById('endian-be').classList.toggle('active', lastEndian === 'be');
}

function wireHexCells() {
  // hex hover handlers & store original hex string for restores
  document.querySelectorAll('.hex-byte').forEach(cell => {
    cell.dataset.hex = cell.dataset.hex ?? cell.textContent.trim();
    cell.addEventListener('mouseenter', ()=> onHexHoverEnter(cell));
    cell.addEventListener('mouseleave', ()=> clearHighlights());
  });
}

function onHexHoverEnter(cell) {
  clearHighlights();
  const byte = Number(cell.dataset.offset);
  // highlight corresponding bits (if visible)
  highlightBitsFromByte(byte);
  cell.classList.add('highlight');
  // highlight category siblings
  const cat = Array.from(cell.classList).find(c => c.startsWith('cat-'));
  if (cat) document.querySelectorAll('.' + cat).forEach(el => el.classList.add('highlight-category'));
}

function clearHighlights() {
  document.querySelectorAll('.hex-byte.highlight, .hex-byte.highlight-category').forEach(n => n.classList.remove('highlight','highlight-category'));
  document.querySelectorAll('.bit.highlight').forEach(n => n.classList.remove('highlight'));
  // restore hex cell text (remove nibble wraps)
  document.querySelectorAll('.hex-byte').forEach(cell => { if (cell.dataset.hex) cell.textContent = cell.dataset.hex; });
}

function highlightBitsFromByte(byteOffset) {
  // find bit spans that target this byte
  document.querySelectorAll('.bit[data-byte="'+byteOffset+'"]').forEach(b => b.classList.add('highlight'));
}

// Bit span generation
function generateBitSpans(byteOffset, buffer) {
  if (!buffer || buffer.length === 0) return '';
  let html = '';
  for (let i=0;i<buffer.length;i++){
    const byte = buffer[i];
    const bits = byte.toString(2).padStart(8,'0');
    for (let b=0;b<8;b++){
      const globalBitIndex = i*8 + b;
      html += '<span class="bit" data-byte="'+(byteOffset+i)+'" data-byte-relative="'+i+'" data-bit="'+b+'" data-global-bit="'+globalBitIndex+'">'+bits[b]+'</span>';
    }
    html += '&nbsp;&nbsp;';
  }
  return html;
}

function wireBitSpans() {
  document.querySelectorAll('.bit').forEach(bitElem => {
    bitElem.addEventListener('mouseenter', () => {
      const byte = Number(bitElem.dataset.byte);
      const bit = Number(bitElem.dataset.bit);
      highlightByte(byte);
      highlightNibble(byte, bit);
      bitElem.classList.add('highlight');
    });
    bitElem.addEventListener('mouseleave', () => clearHighlights());
    bitElem.addEventListener('click', () => {
      // optional: toggle bit -> write edit
      const byte = Number(bitElem.dataset.byte);
      const bit = Number(bitElem.dataset.bit);
      toggleBit(byte, bit);
    });
  });
}

function highlightByte(byteOffset) {
  const cell = document.querySelector('.hex-byte[data-offset="'+byteOffset+'"]');
  if (cell) cell.classList.add('highlight');
}

function highlightNibble(byteOffset, bitIndex) {
  const cell = document.querySelector('.hex-byte[data-offset="'+byteOffset+'"]');
  if (!cell) return;
  const hex = cell.dataset.hex ?? cell.textContent.trim();
  if (hex.length !== 2) return;
  const nibbleIndex = Math.floor(bitIndex / 4); // 0 -> high nibble, 1 -> low nibble
  const html = '<span class="nibble">'+(nibbleIndex===0?('<span class="highlight">'+hex[0]+'</span>'+hex[1]):(hex[0]+'<span class="highlight">'+hex[1]+'</span>'))+'</span>';
  cell.innerHTML = html;
}

function toggleBit(byteOffset, bitIndex) {
  // read current display hex, parse, flip bit, write edit
  const cell = document.querySelector('.hex-byte[data-offset="'+byteOffset+'"]');
  if (!cell) return;
  const curHex = cell.dataset.hex ?? cell.textContent.trim();
  const val = parseInt(curHex, 16);
  const mask = 1 << (7 - bitIndex); // bitIndex 0 is MSB in our display bits
  const newVal = val ^ mask;
  // update edited map & signal backend
  edited.set(byteOffset, newVal);
  vscode.postMessage({ type: 'edit', offset: byteOffset, value: newVal });
  // update UI
  cell.textContent = newVal.toString(16).padStart(2,'0').toUpperCase();
  cell.dataset.hex = cell.textContent;
  cell.classList.add('edited');
}

// message handler from extension
window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.type) {
    case 'fileSize':
      fileSize = msg.size;
      renderPage(0);
      break;
    case 'range':
      {
        const arr = b64ToBuf(msg.data);
        // update cache
        bytesCache.clear();
        for (let i=0;i<arr.length;i++) bytesCache.set(msg.offset + i, arr[i]);
        createTableForBuffer(msg.offset, arr);
      }
      break;
    case 'edited':
      {
        const { offset, value } = msg;
        // reflect change in current page if present
        const el = document.querySelector('.hex-byte[data-offset="'+offset+'"]');
        if (el) { el.textContent = value.toString(16).padStart(2,'0').toUpperCase(); el.dataset.hex = el.textContent; el.classList.add('edited'); }
      }
      break;
    case 'saved':
      document.getElementById('status').textContent = 'Saved.';
      document.querySelectorAll('.hex-byte.edited').forEach(n => n.classList.remove('edited'));
      break;
    case 'searchResults':
      {
        const results = msg.results;
        if (!results || results.length === 0) { document.getElementById('status').textContent = 'No results'; }
        else {
          document.getElementById('status').textContent = 'Found ' + results.length + ' hits. Jumping to first.';
          const first = results[0];
          const base = Math.floor(first / BYTES_PER_LINE) * BYTES_PER_LINE;
          renderPage(base);
          setTimeout(()=> selectOffset(first), 300);
        }
      }
      break;
    case 'export':
      {
        navigator.clipboard.writeText(msg.text).then(()=> document.getElementById('status').textContent = 'Export copied to clipboard').catch(()=> document.getElementById('status').textContent = 'Failed to copy export');
      }
      break;
    case 'interpretation':
      {
        const d = msg.data;
        renderInterpretation(d);
      }
      break;
    default:
      console.warn('Unknown message', msg);
  }
});

function renderInterpretation(d) {
  const c = document.getElementById('interpContent');
  const bytesHex = (d.bytes || []).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
  let html = '';
  html += '<div><b>Offset:</b> 0x' + d.offset.toString(16).padStart(8,'0') + '</div>';
  html += '<div style="margin-top:6px;"><b>Raw Bytes:</b><br>' + escapeHTML(bytesHex) + '</div>';
  html += '<div style="margin-top:6px;"><b>Integers</b><br>';
  html += 'u8: ' + (d.uint8 ?? '-') + '  i8: ' + (d.int8 ?? '-') + '<br>';
  html += 'u16: ' + (d.uint16 ?? '-') + '  i16: ' + (d.int16 ?? '-') + '<br>';
  html += 'u32: ' + (d.uint32 ?? '-') + '  i32: ' + (d.int32 ?? '-') + '<br>';
  html += '</div>';
  html += '<div style="margin-top:6px;"><b>Floats</b><br>f32: ' + (d.float32 ?? '-') + '<br>f64: ' + (d.float64 ?? '-') + '</div>';
  html += '<div style="margin-top:6px;"><b>Text</b><br>ASCII: ' + escapeHTML(d.ascii || '') + '<br>UTF-8: ' + escapeHTML(d.utf8 || '') + '</div>';
  if (d.unix_le) {
    const iso = new Date(d.unix_le * 1000).toISOString();
    html += '<div style="margin-top:6px;"><b>Unix (LE):</b> ' + d.unix_le + ' → ' + iso + '</div>';
  }
  c.innerHTML = html;

  // render bit viewer
  const byteOff = d.offset;
  const bytes = new Uint8Array((d.bytes || []).map(x => x || 0));
  document.getElementById('bits-8').innerHTML = generateBitSpans(byteOff, bytes.slice(0,1));
  document.getElementById('bits-16').innerHTML = generateBitSpans(byteOff, bytes.slice(0,2));
  document.getElementById('bits-32').innerHTML = generateBitSpans(byteOff, bytes.slice(0,4));
  document.getElementById('bits-64').innerHTML = generateBitSpans(byteOff, bytes.slice(0,8));
  wireBitSpans();
}

// keyboard navigation
document.addEventListener('keydown', (e) => {
  if ((e.target && (e.target as HTMLElement).tagName === 'INPUT')) return;
  if (e.key === 'ArrowRight') { selection.offset = Math.min(selection.offset + 1, fileSize -1); selectOffset(selection.offset); ensureVisible(selection.offset); }
  else if (e.key === 'ArrowLeft') { selection.offset = Math.max(selection.offset - 1, 0); selectOffset(selection.offset); ensureVisible(selection.offset); }
  else if (e.key === 'ArrowDown') { selection.offset = Math.min(selection.offset + BYTES_PER_LINE, fileSize -1); selectOffset(selection.offset); ensureVisible(selection.offset); }
  else if (e.key === 'ArrowUp') { selection.offset = Math.max(selection.offset - BYTES_PER_LINE, 0); selectOffset(selection.offset); ensureVisible(selection.offset); }
  else if (e.key === 'Enter') { const el = document.querySelector('.hex-byte[data-offset="'+selection.offset+'"]'); if (el) startEdit(selection.offset, el as HTMLElement); }
  else if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); vscode.postMessage({ type: 'save' }); }
});

function ensureVisible(offset) {
  if (offset < visibleOffset || offset >= visibleOffset + PAGE_BYTES) {
    const base = Math.floor(offset / PAGE_BYTES) * PAGE_BYTES;
    renderPage(base);
  } else {
    document.querySelectorAll('.hex-byte.selected').forEach(n => n.classList.remove('selected'));
    const el = document.querySelector('.hex-byte[data-offset="'+offset+'"]');
    if (el) el.classList.add('selected');
  }
}

function init() {
  wireToolbar();
  vscode.postMessage({ type: 'getFileSize' });
}
init();

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
</script>
</body>
</html>`;
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
}

export function deactivate() {}
