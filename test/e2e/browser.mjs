// End-to-end check in a real headless Chrome via the DevTools protocol (no extra packages).
// Usage: node test/e2e/browser.mjs <outDir>   — needs google-chrome on PATH.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] || 'e2e-out');
fs.mkdirSync(OUT, { recursive: true });
const ROOT = new URL('../../', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpiki-e2e-'));
const { startCluster, freshDatabase } = await import('../helpers/pgcluster.js');
const cluster = await startCluster();
const DATABASE_URL = await freshDatabase(cluster.url, 'alpiki_e2e');
const PORT = 3990, CDP_PORT = 9333, BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, DATABASE_URL, PORT: String(PORT), HOST: '127.0.0.1', SECURE_COOKIES: '0' };
const node = (args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: ROOT, env }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

// 1. server + accounts
const adminOut = node(['scripts/create-admin.js', '--id', '01020003679']);
const ADMIN_CODE = adminOut.match(/([A-Z2-9]{4}-[A-Z2-9]{4})/)[1];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: ROOT, env, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { try { await fetch(BASE); break; } catch { await sleep(100); } }
async function apiLogin(pid, code) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-alpiki': '1' }, body: JSON.stringify({ personalId: pid, accessCode: code }) });
  return r.headers.get('set-cookie').split(';')[0];
}
const adminCookie = await apiLogin('01020003679', ADMIN_CODE);
const findId = async (q) => (await (await fetch(BASE + '/api/admin/persons?q=' + q, { headers: { cookie: adminCookie } })).json()).persons[0].id;
const issue = async (id) => (await (await fetch(BASE + `/api/admin/persons/${id}/access-code`, { method: 'POST', headers: { cookie: adminCookie, 'x-alpiki': '1' } })).json()).code;
const MEMBER_PID = '01024024038'; // Khatuna Danelia, 3 units

const MEMBER2_PID = 'MP4433152';   // Iuri Kolpak (passport), 2 units


// 2. chrome
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); wsUrl = l.find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch { await sleep(150); } }
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map(); const listeners = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else listeners.forEach((f) => f(d)); };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (d) => (d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id, method, params })); });
const consoleErrors = [];
listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); });
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');

const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval'); return r.result.value; };
const waitFor = async (expr, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evaluate(`!!(${expr})`)) return true; await sleep(80); } return false; };
async function viewport(kind) {
  if (kind === 'mobile') await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  else await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
}
async function shot(name, full = true) {
  await sleep(250);
  if (full) await evaluate(`(() => { const h = document.querySelector('.topbar'); if (h) h.style.position = 'static'; const tt = document.querySelector('#toast'); if (tt) tt.hidden = true; return 1; })()`);
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
}
async function open(hash = '') { await send('Page.navigate', { url: BASE + '/' + hash }); await sleep(400); }
const noOverflow = () => evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1');
const setVal = (sel, v) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
async function setLang(l) { await evaluate(`document.querySelector('[data-lang="${l}"]').click()`); await sleep(250); }
async function uiLogin(pid, code) {
  await setVal('#pid', pid);
  await evaluate(`document.querySelector('#login-form').requestSubmit()`);
  if (code) {
    await waitFor(`!document.querySelector('#code-field').hidden`);
    await setVal('#code', code);
    await evaluate(`document.querySelector('#login-form').requestSubmit()`);
  }
}
async function logout() { await evaluate(`document.querySelector('[data-action="logout"]').click()`); await waitFor(`document.querySelector('#login-form')`); }

try {
  // ---- login page, all languages, desktop + mobile
  await viewport('desktop'); await open('#login');
  await waitFor(`document.querySelector('#login-form')`);
  await shot('01-login-ka-desktop', false);
  await setLang('en'); await shot('02-login-en-desktop', false);
  check('language switch updates the page (EN)', await evaluate(`document.querySelector('h1').textContent === 'Sign in'`));
  await setLang('ru');
  check('language switch updates the page (RU)', await evaluate(`document.querySelector('h1').textContent === 'Вход в систему'`));
  await viewport('mobile'); await shot('03-login-ru-mobile', false);
  check('login page fits phone width', await noOverflow());

  // ---- owners: ID number only, no code field
  check('no access-code field for owners', await evaluate(`document.querySelector('#code-field').hidden`));
  await uiLogin('99999999999');
  check('unknown ID shows translated error', await waitFor(`!document.querySelector('#login-err').hidden && document.querySelector('#login-err').textContent.includes('не найден')`));

  // ---- member login (mobile, RU kept)
  await uiLogin(MEMBER_PID);
  check('member signs in', await waitFor(`document.querySelector('#sign-form')`, 8000));
  check('language kept after sign-in (RU)', await evaluate(`document.querySelector('h1').textContent.startsWith('Здравствуйте')`));
  check('member sees only own 3 units', await evaluate(`document.querySelectorAll('.unit-item').length === 3`));
  check('member has no admin navigation', await evaluate(`!document.querySelector('a[href="#admin/units"]')`));
  await shot('04-member-ru-mobile');
  check('member page fits phone width', await noOverflow());

  // direct navigation to admin routes is refused (UI) and API returns 403
  await open('#admin/members');
  check('member redirected away from admin page', await waitFor(`location.hash === '#me'`));
  const apiStatus = await evaluate(`fetch('/api/admin/persons').then(r => r.status)`);
  check('member gets 403 from admin API in the browser', apiStatus === 403, 'status ' + apiStatus);
  const otherImg = await evaluate(`fetch('/api/me/signatures/1/image').then(r => r.status)`);
  check('member cannot fetch an unknown signature image', otherImg === 404, 'status ' + otherImg);

  // ---- sign 2 of 3 units (validation first)
  await waitFor(`document.querySelector('#sign-form')`);
  await evaluate(`document.querySelector('#sign-form').requestSubmit()`);
  check('signing without consent/signature is blocked with a message', await waitFor(`!document.querySelector('#sign-err').hidden`));
  await evaluate(`document.querySelectorAll('input[name=unit]')[2].click()`); // untick the parking space
  await evaluate(`document.querySelector('#sconsent').click()`);
  const box = await evaluate(`(() => { const c = document.querySelector('#pad'); c.scrollIntoView({block:'center'}); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  await sleep(150);
  const b2 = await evaluate(`(() => { const r = document.querySelector('#pad').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const pts = []; for (let i = 0; i <= 40; i++) pts.push([b2.x + 30 + i * (b2.w - 60) / 40, b2.y + b2.h / 2 + Math.sin(i / 3) * 30]);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts[0][0], y: pts[0][1], button: 'left', clickCount: 1 });
  for (const [x, y] of pts) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pts.at(-1)[0], y: pts.at(-1)[1], button: 'left', clickCount: 1 });
  await shot('05-member-signing-mobile');
  await evaluate(`document.querySelector('#sign-form').requestSubmit()`);
  check('signature saved and success message shown', await waitFor(`document.querySelector('.alert-ok')`, 8000));
  check('saved signatures are shown again from the server', await waitFor(`document.querySelectorAll('.sig-item img').length === 2 && [...document.querySelectorAll('.sig-item img')].every(i => i.complete && i.naturalWidth > 0)`, 6000));
  check('third unit still open for signing', await evaluate(`document.querySelectorAll('input[name=unit]:not(:disabled)').length === 1`));
  await shot('06-member-signed-ru-mobile');

  // reload keeps session + language
  await open('#me');
  check('after reload signatures are still there', await waitFor(`document.querySelectorAll('.sig-item').length === 2`));
  await logout();

  // ---- second member: desktop, EN, sees nothing of member 1
  await viewport('desktop'); await setLang('en');
  await uiLogin(MEMBER2_PID);
  check('member signs in with passport number', await waitFor(`document.querySelector('.unit-item')`, 8000));
  check('second member does not see first member\'s data', await evaluate(`!document.body.innerText.includes('Danelia') && document.querySelectorAll('.sig-item').length === 0`));
  await shot('07-member-en-desktop');
  check('member page fits desktop width', await noOverflow());
  await logout();

  // ---- admin desktop KA
  await setLang('ka');
  await setVal('#pid', '01020003679');
  await evaluate(`document.querySelector('#login-form').requestSubmit()`);
  check('admin ID asks for the access code', await waitFor(`!document.querySelector('#code-field').hidden && location.hash === '#login'`));
  await shot('00-login-admin-code-ka-desktop', false);
  await uiLogin('01020003679', ADMIN_CODE);
  check('super admin signs in to overview', await waitFor(`location.hash === '#admin/overview' && document.querySelector('.kpi')`, 8000));
  check('overview counts 2 signed units', await evaluate(`document.querySelector('.kpi .v').textContent.startsWith('2')`));
  await shot('08-admin-overview-ka-desktop');
  await open('#admin/units');
  await waitFor(`document.querySelector('#u-table table')`);
  check('admin sees all 118 units', await evaluate(`document.querySelectorAll('#u-table tbody tr').length === 118`));
  await evaluate(`(() => { const s = document.querySelector('#u-status'); s.value = 'signed'; s.dispatchEvent(new Event('change')); })()`);
  check('filter: signed units only', await waitFor(`document.querySelectorAll('#u-table tbody tr').length === 2`));
  await shot('09-admin-units-signed-ka-desktop');
  await open('#admin/members');
  await waitFor(`document.querySelector('#m-table table')`);
  await setVal('#m-q', 'MP4433152');
  check('search members by passport number', await waitFor(`document.querySelectorAll('#m-table tbody tr').length === 1 && document.querySelector('#m-table').innerText.includes('Kolpak') || document.querySelector('#m-table').innerText.includes('კოლპაკ')`));
  await setVal('#m-q', 'Danelia');
  await waitFor(`document.querySelectorAll('#m-table tbody tr').length === 1`);
  await evaluate(`document.querySelector('#m-table tbody tr').click()`);
  check('admin opens a member record with signature images', await waitFor(`document.querySelectorAll('#dr-body .sig-item img').length === 2 && [...document.querySelectorAll('#dr-body .sig-item img')].every(i => i.complete && i.naturalWidth > 0)`, 6000));
  await shot('10-admin-member-drawer-ka-desktop', false);
  await evaluate(`document.querySelector('[data-action="close-drawer"]').click()`);
  await setLang('en');
  await open('#admin/audit');
  check('audit log lists sign-ins and signatures', await waitFor(`document.querySelector('#a-table').innerText.includes('Signed in') && document.querySelector('#a-table').innerText.includes('Signed')`));
  await shot('11-admin-audit-en-desktop');

  // ---- admin mobile RU
  await viewport('mobile'); await setLang('ru');
  await open('#admin/units');
  await waitFor(`document.querySelector('#u-table table')`);
  check('admin units page fits phone width', await noOverflow());
  await shot('12-admin-units-ru-mobile', false);
  await open('#admin/overview'); await waitFor(`document.querySelector('.kpi')`);
  check('admin overview fits phone width', await noOverflow());
  await shot('13-admin-overview-ru-mobile');

  // no untranslated strings visible in RU admin pages
  const mixed = await evaluate(`/[\\u10A0-\\u10FF]/.test((() => { const h = document.querySelector('header').cloneNode(true); h.querySelector('.langs').remove(); return h.innerText + document.querySelector('main').innerText; })())`);
  check('no Georgian text left on Russian admin screen', !mixed);

  check('no JavaScript errors in the browser', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
  check('e2e run', false, e.message);
} finally {
  // database still holds exactly the 2 signatures made through the browser
  const { Db } = await import('../../src/pg.js');
  const pdb = new Db(DATABASE_URL);
  const n = String((await pdb.get('SELECT COUNT(*) n FROM signatures')).n);
  await pdb.close();
  check('database holds the 2 browser signatures', n === '2', n);
  ws.close(); chrome.kill(); server.kill(); cluster.stop();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
}
