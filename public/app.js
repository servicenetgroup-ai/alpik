/* Alpiki consent system — single-page frontend. All data comes from the API; the server decides
   what each user may see. Every value placed into HTML goes through esc(). */
(() => {
  'use strict';
  const I18N = window.I18N;
  const LANGS = ['ka', 'en', 'ru'];
  const CHAIR = { phone: '+995 577 77 44 43', email: 'lexo.simonishvili@gmail.com' };
  const MARK = '<svg viewBox="0 0 64 64" width="22" height="22" aria-hidden="true"><path d="M8 50 L27 16 L37 34 L43 24 L56 50 Z" fill="currentColor"/></svg>';

  const S = { lang: 'ka', user: null, me: null, doc: null };
  try { const l = localStorage.getItem('alpiki.lang'); if (LANGS.includes(l)) S.lang = l; } catch (_) {}
  if (!LANGS.includes(S.lang)) S.lang = 'ka';

  /* ---------- helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const t = (key, vars) => {
    let s = I18N[S.lang][key] ?? I18N.en[key] ?? key;
    if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  };
  const errText = (code) => (I18N[S.lang]['err.' + code] ? t('err.' + code) : t('err.generic'));
  const MONTHS = window.I18N_MONTHS;
  const fmtDate = (iso, withTime = true) => {
    if (!iso) return '—';
    const d = new Date(iso), p2 = (n) => String(n).padStart(2, '0');
    const date = `${d.getDate()} ${MONTHS[S.lang][d.getMonth()]}${S.lang === 'en' ? '' : '.'} ${d.getFullYear()}`;
    return withTime ? `${date}, ${p2(d.getHours())}:${p2(d.getMinutes())}` : date;
  };
  // Georgian and Russian both write 4 435,8 — use ru-RU rules for ka where the browser lacks ka data.
  const NUM_LOCALE = { ka: Intl.NumberFormat.supportedLocalesOf('ka-GE').length ? 'ka-GE' : 'ru-RU', en: 'en-GB', ru: 'ru-RU' };
  const fmtNum = (n, d = 1) => new Intl.NumberFormat(NUM_LOCALE[S.lang], { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  const pct = (a, b) => (b ? (a / b) * 100 : 0);
  const name = (p) => (S.lang === 'ka' ? p.name_ka : p.name_en) || p.name_en || p.name_ka;
  const floorText = (f) => (f === 'M' ? t('unit.mansard') : t('unit.floor', { f: String(f).replace('-', '−') }));
  const unitTitle = (u) => `${t('unit.' + u.type)} №${u.label}`;
  const statusChip = (s) => `<span class="chip ${{ signed: 'chip-ok', partial: 'chip-warn', unsigned: 'chip-muted', revoked: 'chip-danger' }[s] || 'chip-muted'}">${esc(t('status.' + s))}</span>`;
  const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };

  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(() => (el.hidden = true), 3600);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast(t('p.copied')); }
    catch (_) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast(t('p.copied')); } catch (__) {} ta.remove(); }
  }

  class ApiError extends Error { constructor(code, status, data) { super(code); this.code = code; this.status = status; this.data = data; } }
  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method, credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'X-Alpiki': '1' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (_) { throw new ApiError('network', 0); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && S.user && url !== '/api/auth/login') { S.user = null; toast(errText('unauthenticated')); go('login'); }
      throw new ApiError(data.error || 'generic', res.status, data);
    }
    return data;
  }

  /* ---------- language ---------- */
  function langSwitch() {
    return `<div class="langs" role="group" aria-label="${esc(t('lang.label'))}">${LANGS.map((l) =>
      `<button type="button" data-lang="${l}" aria-pressed="${l === S.lang}">${{ ka: 'ქარ', en: 'ENG', ru: 'РУС' }[l]}</button>`).join('')}</div>`;
  }
  async function setLang(l) {
    if (!LANGS.includes(l) || l === S.lang) return;
    S.lang = l;
    try { localStorage.setItem('alpiki.lang', l); } catch (_) {}
    document.documentElement.lang = l;
    if (S.user) api('PUT', '/api/me/lang', { lang: l }).catch(() => {});
    render();
  }

  /* ---------- routing ---------- */
  const go = (r) => { if (location.hash !== '#' + r) location.hash = r; else render(); };
  const route = () => location.hash.replace(/^#\/?/, '') || '';
  window.addEventListener('hashchange', () => render());

  function render() {
    document.documentElement.lang = S.lang;
    document.title = `${t('app.name')} · ${t('app.sub')}`;
    const r = route();
    if (!S.user) return renderLogin();
    const isAdmin = S.user.role === 'superadmin';
    if (r.startsWith('admin/') && !isAdmin) return go('me');
    if (!r || r === 'login') return go(isAdmin ? 'admin/overview' : 'me');
    if (r === 'me') return renderMe();
    if (r === 'admin/overview') return renderOverview();
    if (r === 'admin/units') return renderUnits();
    if (r === 'admin/members') return renderMembers();
    if (r === 'admin/audit') return renderAudit();
    return go(isAdmin ? 'admin/overview' : 'me');
  }

  function shell(content) {
    const isAdmin = S.user.role === 'superadmin';
    const r = route();
    const links = (isAdmin ? [['admin/overview', 'nav.overview'], ['admin/units', 'nav.units'], ['admin/members', 'nav.members'], ['admin/audit', 'nav.audit']] : []).concat([['me', 'nav.myConsent']]);
    $('#app').innerHTML = `
      <header class="topbar"><div class="topbar-in">
        <a class="brand" href="#${isAdmin ? 'admin/overview' : 'me'}"><span class="brand-mark">${MARK}</span>
          <span class="brand-text"><b>${esc(t('app.name'))}</b><span>${esc(t('app.sub'))} · <span class="mono">71.62.58.548</span></span></span></a>
        ${langSwitch()}
        <div class="userbox"><span class="who"><b>${esc(name(S.user))}</b><small>${esc(t('role.' + S.user.role))}</small></span>
          <button type="button" class="btn-ghost-dark" data-action="logout">${esc(t('nav.logout'))}</button></div>
      </div>
      ${isAdmin ? `<nav class="subnav" aria-label="Main"><div class="subnav-in">${links.map(([h, k]) => `<a href="#${h}" ${r === h ? 'aria-current="page"' : ''}>${esc(t(k))}</a>`).join('')}</div></nav>` : ''}
      </header>
      <main class="page" id="main">${content}</main>
      <footer class="footer">${esc(t('app.name'))} · ${esc(t('app.address'))}</footer>`;
  }

  /* ---------- login ---------- */
  function renderLogin() {
    if (route() !== 'login') history.replaceState(null, '', '#login');
    $('#app').innerHTML = `
      <header class="topbar"><div class="topbar-in">
        <span class="brand"><span class="brand-mark">${MARK}</span><span class="brand-text"><b>${esc(t('app.name'))}</b><span>${esc(t('app.sub'))}</span></span></span>
        ${langSwitch()}
      </div></header>
      <div class="login-wrap">
        <form class="card login-card" id="login-form" novalidate>
          <div class="stack gap-6"><h1>${esc(t('login.title'))}</h1><p class="lead">${esc(t('login.lead'))}</p></div>
          <div id="login-err" class="alert alert-error" role="alert" hidden></div>
          <div class="field"><label for="pid">${esc(t('login.pid'))}</label>
            <input class="input input-lg" id="pid" name="pid" autocomplete="username" inputmode="text" autocapitalize="characters" spellcheck="false" required>
            <span class="hint">${esc(t('login.pidHint'))}</span></div>
          <div class="field"><label for="code">${esc(t('login.code'))}</label>
            <input class="input input-lg" id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="XXXX-XXXX" required>
            <span class="hint">${esc(t('login.codeHint'))}</span></div>
          <button class="btn btn-primary btn-block" type="submit" id="login-btn">${esc(t('login.submit'))}</button>
          <div class="login-foot">
            <span>${esc(t('login.noCode'))}</span>
            <span class="copy-line"><span class="mono">${esc(CHAIR.phone)}</span> · <span class="mono">${esc(CHAIR.email)}</span></span>
            <span class="xs">${esc(t('login.privacy'))}</span>
          </div>
        </form>
      </div>`;
    const code = $('#code');
    code.addEventListener('input', () => {
      const v = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      code.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v;
    });
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#login-err'), btn = $('#login-btn');
      err.hidden = true; btn.disabled = true;
      try {
        const r = await api('POST', '/api/auth/login', { personalId: $('#pid').value, accessCode: code.value, lang: S.lang });
        S.user = r.user;
        go(S.user.role === 'superadmin' ? 'admin/overview' : 'me');
      } catch (ex) { err.textContent = errText(ex.code === 'bad_json' ? 'generic' : ex.code); err.hidden = false; btn.disabled = false; }
    });
    setTimeout(() => $('#pid')?.focus(), 30);
  }

  /* ---------- member ---------- */
  async function renderMe() {
    shell(`<div class="empty">${esc(t('adm.loading'))}</div>`);
    try {
      S.me = await api('GET', '/api/me');
      const docId = S.me.documents[0]?.id;
      S.doc = docId ? await api('GET', '/api/me/documents/' + docId) : null;
    } catch (ex) { $('#main').innerHTML = `<div class="alert alert-error">${esc(errText(ex.code))}</div>`; return; }
    drawMe();
  }

  function drawMe(successN) {
    const me = S.me, doc = S.doc, c = doc?.document.content[S.lang];
    const units = me.units;
    const signedSet = new Set((doc?.signatures || []).map((s) => s.unitCode));
    const left = units.filter((u) => !signedSet.has(u.code));
    const p = pct(units.length - left.length, units.length);
    const isOpen = doc?.document.status === 'open';

    const docHtml = c ? `
      <article class="card card-pad doc stack gap-16" aria-labelledby="doc-title">
        <div class="doc-title"><span class="chip chip-info">${esc(t('me.document'))}</span><h2 id="doc-title">${esc(c.title)}</h2><p class="muted">${esc(c.summary)}</p></div>
        ${c.sections.map((s) => `
          <section class="doc-section tone-${esc(s.tone)}">
            <span class="eyebrow">${esc(s.tag)}</span><h3>${esc(s.title)}</h3>
            ${s.intro ? `<p>${esc(s.intro)}</p>` : ''}
            <ul>${s.items.map((i) => `<li><strong>${esc(i.lead)}.</strong> ${esc(i.text)}</li>`).join('')}</ul>
            ${s.demands ? `<div class="demands"><b>${esc(s.demands.title)}</b><ol>${s.demands.items.map((d) => `<li>${esc(d)}</li>`).join('')}</ol>${s.demands.after ? `<p class="small mt-8">${esc(s.demands.after)}</p>` : ''}</div>` : ''}
          </section>`).join('')}
        <div class="consent-box"><b>${esc(t('me.consentCheck'))}</b>${esc(c.consent)}</div>
      </article>` : '';

    const signHtml = !doc ? '' : !isOpen ? `<div class="alert alert-info m-sign">${esc(t('me.closed'))}</div>` : left.length === 0 ? `<div class="alert alert-ok m-sign">${esc(t('me.allSigned'))}</div>` : `
      <form class="card m-sign" id="sign-form" novalidate>
        <div class="card-head"><h2>${esc(t('me.sign'))}</h2></div>
        <div class="card-body">
          <p class="small muted">${esc(t('me.signLead'))}</p>
          <div id="sign-err" class="alert alert-error" role="alert" hidden></div>
          <div class="stack gap-8">${units.map((u, i) => {
            const done = signedSet.has(u.code);
            return `<label class="check ${done ? 'is-done' : ''}"><input type="checkbox" name="unit" value="${esc(u.code)}" ${done ? 'disabled checked' : 'checked'}>
              <span><b>${esc(unitTitle(u))}</b> · ${esc(floorText(u.floor))} · ${esc(t('unit.area', { a: fmtNum(u.area, 2) }))}${done ? ` · <span class="chip chip-ok">${esc(t('status.signed'))}</span>` : ''}<br><span class="mono xs muted">${esc(u.code)}</span></span></label>`;
          }).join('')}</div>
          <div class="field"><label for="sname">${esc(t('me.signedName'))}</label><input class="input" id="sname" autocomplete="name" value="${esc(me.user.kind === 'person' ? name(me.user) : '')}"><span class="hint">${esc(t('me.signedNameHint'))}</span></div>
          <label class="check"><input type="checkbox" id="sconsent"><span>${esc(t('me.consentCheck'))}</span></label>
          <div class="field"><div class="row between"><span class="label">${esc(t('me.pad'))}</span><button type="button" class="link-btn small" id="pad-clear">${esc(t('me.clear'))}</button></div>
            <div class="pad"><canvas id="pad" aria-label="${esc(t('me.pad'))}"></canvas><div class="baseline"></div><div class="pad-hint" id="pad-hint">${esc(t('me.padHint'))}</div></div></div>
          <button class="btn btn-accent btn-block" type="submit" id="sign-btn">${esc(t('me.submit'))}</button>
        </div>
      </form>`;

    const sigs = doc?.signatures || [];
    $('#main').innerHTML = `
      <section class="card card-pad hero">
        <div><h1>${esc(t('me.hello', { name: name(me.user) }))}</h1><p class="muted mt-4">${esc(t('me.lead'))}</p>
          <div class="ids" aria-label="${esc(t('me.ids'))}">${me.user.ids.map((i) => `<span class="tag">${esc(i.kind)} ${esc(i.masked)}</span>`).join('')}</div></div>
        <div class="hero-progress"><b>${esc(t('me.progress', { signed: units.length - left.length, total: units.length }))}</b>
          <div class="progress" role="progressbar" aria-valuenow="${Math.round(p)}" aria-valuemin="0" aria-valuemax="100"><span data-w="${p}"></span></div></div>
      </section>
      ${successN ? `<div class="alert alert-ok" role="status">✓ ${esc(t('me.success', { n: successN }))}</div>` : ''}
      <div class="member-grid">
        <div class="side">
          <section class="card m-units"><div class="card-head"><h2>${esc(t('me.units'))}</h2></div><div class="card-body"><div class="unit-list">${units.map((u) => `
            <div class="unit-item"><b>${esc(unitTitle(u))}</b>${signedSet.has(u.code) ? statusChip('signed') : statusChip('unsigned')}
              <div class="meta"><span>${esc(floorText(u.floor))}</span><span>${esc(t('unit.area', { a: fmtNum(u.area, 2) }))}</span>${u.coOwners ? `<span>${esc(t('me.coOwners', { n: u.coOwners }))}</span>` : ''}<span class="mono">${esc(u.code)}</span></div></div>`).join('')}</div></div></section>
          ${signHtml}
          <section class="card m-sigs"><div class="card-head"><h2>${esc(t('me.mySignatures'))}</h2></div><div class="card-body">
            ${sigs.length ? `<div class="sig-list">${sigs.map((s) => {
              const u = units.find((x) => x.code === s.unitCode);
              return `<div class="sig-item"><img src="/api/me/signatures/${encodeURIComponent(s.id)}/image" alt="${esc(t('me.pad'))}" loading="lazy">
                <div class="small"><b>${esc(u ? unitTitle(u) : s.unitCode)}</b><br><span class="muted">${esc(t('me.signedAt', { date: fmtDate(s.signedAt) }))}</span></div></div>`;
            }).join('')}</div>` : `<p class="muted small">${esc(t('me.noSignatures'))}</p>`}
          </div></section>
        </div>
        ${docHtml}
      </div>`;
    if ($('#sign-form')) wireSign(doc.document.id);
  }

  function makePad(canvas, hint) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0b1a2b'; ctx.fillStyle = '#0b1a2b';
    let drawing = false, last = null, ink = 0;
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); hint.hidden = true; ctx.beginPath(); ctx.arc(last.x, last.y, 1.2, 0, Math.PI * 2); ctx.fill(); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return; e.preventDefault();
      const p = pos(e), d = Math.hypot(p.x - last.x, p.y - last.y); if (d < 0.8) return;
      ctx.lineWidth = Math.max(1.6, Math.min(3.2, 3.4 - d * 0.06));
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); ink += d; last = p;
    });
    const end = (e) => { if (drawing) { drawing = false; try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} } };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    return {
      get ink() { return ink; },
      clear() { ctx.clearRect(0, 0, w, h); ink = 0; hint.hidden = false; },
      png() { const o = document.createElement('canvas'); o.width = 600; o.height = Math.max(60, Math.round(600 * h / w)); o.getContext('2d').drawImage(canvas, 0, 0, o.width, o.height); return o.toDataURL('image/png'); },
    };
  }

  function wireSign(docId) {
    const pad = makePad($('#pad'), $('#pad-hint'));
    $('#pad-clear').addEventListener('click', () => pad.clear());
    $('#sign-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#sign-err'), btn = $('#sign-btn');
      const fail = (m) => { err.textContent = m; err.hidden = false; err.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
      err.hidden = true;
      const unitCodes = $$('input[name="unit"]:checked:not(:disabled)').map((i) => i.value);
      const signedName = $('#sname').value.trim();
      if (!unitCodes.length) return fail(t('err.pickUnit'));
      if (signedName.length < 3) return fail(t('err.name'));
      if (!$('#sconsent').checked) return fail(t('err.consent'));
      if (pad.ink < 60) return fail(t('err.pad'));
      btn.disabled = true; btn.textContent = t('me.saving');
      try {
        const r = await api('POST', `/api/me/documents/${docId}/signatures`, { unitCodes, signedName, consent: true, image: pad.png(), lang: S.lang });
        S.me = await api('GET', '/api/me');
        S.doc = await api('GET', '/api/me/documents/' + docId);
        drawMe(r.signatures.length);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        toast(t('me.success', { n: r.signatures.length }));
      } catch (ex) { btn.disabled = false; btn.textContent = t('me.submit'); fail(errText(ex.code)); }
    });
  }

  /* ---------- admin: overview ---------- */
  async function renderOverview() {
    shell(`<div class="empty">${esc(t('adm.loading'))}</div>`);
    let ov, units;
    try { [ov, units] = await Promise.all([api('GET', '/api/admin/overview'), api('GET', '/api/admin/units')]); }
    catch (ex) { $('#main').innerHTML = `<div class="alert alert-error">${esc(errText(ex.code))}</div>`; return; }
    const groups = ['apartment', 'parking', 'commercial', 'auxiliary'].map((type) => {
      const list = units.units.filter((u) => u.type === type);
      return { type, total: list.length, signed: list.filter((u) => u.status !== 'unsigned').length };
    }).filter((g) => g.total);
    const floors = ['-1', '1', '2', '3', '4', 'M'].map((f) => {
      const list = units.units.filter((u) => u.floor === f);
      return { f, total: list.length, signed: list.filter((u) => u.status !== 'unsigned').length };
    });
    const kpi = (k, v, s) => `<div class="card kpi"><span class="k">${esc(k)}</span><span class="v">${v}</span><span class="s">${s}</span></div>`;
    const bar = (label, a, b) => `<div class="bar-row"><span>${esc(label)}</span><div class="progress"><span data-w="${pct(a, b)}"></span></div><span class="num r small">${a}/${b}</span></div>`;
    $('#main').innerHTML = `
      <div class="page-head"><div><h1>${esc(t('adm.overviewTitle'))}</h1><p>${esc(t('app.address'))}</p></div>
        <a class="btn" href="/api/admin/export.csv" download>${esc(t('adm.export'))}</a></div>
      <div class="kpis">
        ${kpi(t('adm.kpiUnits'), `${ov.units.signed}<span class="muted small"> / ${ov.units.total}</span>`, `${fmtNum(pct(ov.units.signed, ov.units.total))}%`)}
        ${kpi(t('adm.kpiArea'), `${fmtNum(pct(ov.units.signedArea, ov.units.area))}%`, `${fmtNum(ov.units.signedArea, 1)} / ${fmtNum(ov.units.area, 1)} m²`)}
        ${kpi(t('adm.kpiMembers'), `${ov.persons.signed}<span class="muted small"> / ${ov.persons.total}</span>`, `${fmtNum(pct(ov.persons.signed, ov.persons.total))}%`)}
        ${kpi(t('adm.kpiCodes'), `${ov.persons.withCode}<span class="muted small"> / ${ov.persons.total}</span>`, `${fmtNum(pct(ov.persons.withCode, ov.persons.total))}%`)}
      </div>
      <div class="overview-grid">
        <section class="card"><div class="card-head"><h2>${esc(t('nav.units'))}</h2><a class="link-btn small" href="#admin/units">→</a></div>
          <div class="card-body"><div class="bars">${groups.map((g) => bar(t('unit.' + g.type), g.signed, g.total)).join('')}</div>
          <div class="bars bars-sep">${floors.map((g) => bar(floorText(g.f), g.signed, g.total)).join('')}</div></div></section>
        <section class="card"><div class="card-head"><h2>${esc(t('adm.recent'))}</h2><a class="link-btn small" href="#admin/audit">→</a></div>
          <div class="card-body"><div class="feed">${ov.recent.length ? ov.recent.map((r) => `<div class="feed-item"><span><b>${esc(t('audit.' + r.action))}</b>${r.name_en ? ' · ' + esc(name(r)) : ''}</span><time>${esc(fmtDate(r.at))}</time></div>`).join('') : `<p class="muted small">${esc(t('adm.empty'))}</p>`}</div></div></section>
      </div>`;
  }

  /* ---------- admin: units ---------- */
  const F = { units: { q: '', status: 'all', floor: 'all', type: 'all' }, members: { q: '', status: 'all' }, audit: { action: 'all', offset: 0 } };

  function renderUnits() {
    const f = F.units;
    shell(`
      <div class="page-head"><div><h1>${esc(t('nav.units'))}</h1><p id="u-count" class="small"></p></div><a class="btn" href="/api/admin/export.csv" download>${esc(t('adm.export'))}</a></div>
      <section class="card">
        <div class="card-head filters">
          <input class="input grow" id="u-q" type="search" placeholder="${esc(t('adm.search'))}" value="${esc(f.q)}" aria-label="${esc(t('adm.search'))}">
          <select class="input" id="u-status" aria-label="${esc(t('adm.col.status'))}">${['all', 'signed', 'partial', 'unsigned'].map((s) => `<option value="${s}" ${f.status === s ? 'selected' : ''}>${esc(t('status.' + s))}</option>`).join('')}</select>
          <select class="input" id="u-floor" aria-label="${esc(t('adm.allFloors'))}"><option value="all">${esc(t('adm.allFloors'))}</option>${['-1', '1', '2', '3', '4', 'M'].map((x) => `<option value="${x}" ${f.floor === x ? 'selected' : ''}>${esc(floorText(x))}</option>`).join('')}</select>
          <select class="input" id="u-type" aria-label="${esc(t('adm.allTypes'))}"><option value="all">${esc(t('adm.allTypes'))}</option>${['apartment', 'parking', 'commercial', 'auxiliary'].map((x) => `<option value="${x}" ${f.type === x ? 'selected' : ''}>${esc(t('unit.' + x))}</option>`).join('')}</select>
        </div>
        <div class="table-wrap" id="u-table"><div class="empty">${esc(t('adm.loading'))}</div></div>
      </section>`);
    const load = async () => {
      const qs = new URLSearchParams(f).toString();
      try {
        const { units } = await api('GET', '/api/admin/units?' + qs);
        $('#u-count').textContent = t('adm.results', { n: units.length });
        $('#u-table').innerHTML = units.length ? `<table class="data stackable"><thead><tr>
          <th>${esc(t('adm.col.unit'))}</th><th>${esc(t('adm.col.code'))}</th><th class="r">${esc(t('adm.col.area'))}</th><th>${esc(t('adm.col.owners'))}</th><th>${esc(t('adm.col.status'))}</th></tr></thead><tbody>
          ${units.map((u) => `<tr>
            <td data-label="${esc(t('adm.col.unit'))}"><b>${esc(unitTitle(u))}</b><br><span class="xs muted">${esc(floorText(u.floor))}</span></td>
            <td data-label="${esc(t('adm.col.code'))}" class="mono xs">${esc(u.code)}</td>
            <td data-label="${esc(t('adm.col.area'))}" class="r num">${esc(fmtNum(u.area, 2))}</td>
            <td data-label="${esc(t('adm.col.owners'))}">${u.owners.map((o) => `<div class="owner-line"><span class="ok-dot ${o.signatureId ? 'yes' : 'no'}" aria-hidden="true">${o.signatureId ? '✓' : ''}</span><button type="button" class="link-btn" data-person="${o.id}">${esc(name(o))}</button>${o.signedAt ? `<span class="xs muted">${esc(fmtDate(o.signedAt, false))}</span>` : ''}</div>`).join('')}</td>
            <td data-label="${esc(t('adm.col.status'))}">${statusChip(u.status)}</td></tr>`).join('')}
          </tbody></table>` : `<div class="empty">${esc(t('adm.empty'))}</div>`;
      } catch (ex) { $('#u-table').innerHTML = `<div class="alert alert-error">${esc(errText(ex.code))}</div>`; }
    };
    $('#u-q').addEventListener('input', debounce((e) => { f.q = e.target.value; load(); }, 250));
    for (const k of ['status', 'floor', 'type']) $('#u-' + k).addEventListener('change', (e) => { f[k] = e.target.value; load(); });
    load();
  }

  /* ---------- admin: members ---------- */
  function renderMembers() {
    const f = F.members;
    shell(`
      <div class="page-head"><div><h1>${esc(t('nav.members'))}</h1><p id="m-count" class="small"></p></div><a class="btn" href="/api/admin/export.csv" download>${esc(t('adm.export'))}</a></div>
      <section class="card">
        <div class="card-head filters">
          <input class="input grow" id="m-q" type="search" placeholder="${esc(t('adm.search'))}" value="${esc(f.q)}" aria-label="${esc(t('adm.search'))}">
          <select class="input" id="m-status" aria-label="${esc(t('adm.col.status'))}">${['all', 'signed', 'partial', 'unsigned', 'nocode'].map((s) => `<option value="${s}" ${f.status === s ? 'selected' : ''}>${esc(t('status.' + s))}</option>`).join('')}</select>
        </div>
        <div class="table-wrap" id="m-table"><div class="empty">${esc(t('adm.loading'))}</div></div>
      </section>`);
    const load = async () => {
      try {
        const { persons } = await api('GET', '/api/admin/persons?' + new URLSearchParams(f));
        $('#m-count').textContent = t('adm.results', { n: persons.length });
        $('#m-table').innerHTML = persons.length ? `<table class="data stackable"><thead><tr>
          <th>${esc(t('adm.col.name'))}</th><th>${esc(t('adm.col.ids'))}</th><th>${esc(t('adm.col.units'))}</th><th>${esc(t('adm.col.access'))}</th><th>${esc(t('adm.col.lastLogin'))}</th><th>${esc(t('adm.col.status'))}</th></tr></thead><tbody>
          ${persons.map((p) => `<tr class="clickable" data-person="${p.id}" tabindex="0">
            <td data-label="${esc(t('adm.col.name'))}"><b>${esc(name(p))}</b>${p.role === 'superadmin' ? ` <span class="chip chip-info">${esc(t('role.superadmin'))}</span>` : ''}</td>
            <td data-label="${esc(t('adm.col.ids'))}" class="mono xs">${p.ids.map(esc).join('<br>')}</td>
            <td data-label="${esc(t('adm.col.units'))}" class="small">${esc(p.unit_labels || '')}</td>
            <td data-label="${esc(t('adm.col.access'))}">${p.locked_until && p.locked_until > new Date().toISOString() ? `<span class="chip chip-danger">${esc(t('adm.locked'))}</span>` : p.has_code ? `<span class="chip chip-ok">${esc(t('adm.hasCode'))}</span>` : `<span class="chip chip-muted">${esc(t('adm.noCode'))}</span>`}</td>
            <td data-label="${esc(t('adm.col.lastLogin'))}" class="small">${esc(p.last_login_at ? fmtDate(p.last_login_at) : t('adm.never'))}</td>
            <td data-label="${esc(t('adm.col.status'))}">${statusChip(p.status)} <span class="xs muted num">${p.signed_count}/${p.unit_count}</span></td></tr>`).join('')}
          </tbody></table>` : `<div class="empty">${esc(t('adm.empty'))}</div>`;
      } catch (ex) { $('#m-table').innerHTML = `<div class="alert alert-error">${esc(errText(ex.code))}</div>`; }
    };
    renderMembers.reload = load;
    $('#m-q').addEventListener('input', debounce((e) => { f.q = e.target.value; load(); }, 250));
    $('#m-status').addEventListener('change', (e) => { f.status = e.target.value; load(); });
    load();
  }

  /* ---------- admin: person drawer ---------- */
  let drawerReturn = null, drawerId = null;
  async function openPerson(id) {
    closeDrawer();
    drawerReturn = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'scrim'; scrim.id = 'drawer';
    scrim.innerHTML = `<aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="dr-title"><div class="drawer-head"><div><span class="xs muted">${esc(t('p.details'))}</span><h2 id="dr-title">…</h2></div><button type="button" class="x-btn" data-action="close-drawer" aria-label="${esc(t('p.close'))}">×</button></div><div class="drawer-body" id="dr-body"><div class="empty">${esc(t('adm.loading'))}</div></div></aside>`;
    document.body.appendChild(scrim);
    document.body.style.overflow = 'hidden';
    scrim.addEventListener('click', (e) => { if (e.target === scrim) closeDrawer(); });
    $('.x-btn', scrim).focus();
    await drawPerson(id);
  }
  function closeDrawer() {
    const d = $('#drawer'); if (!d) return;
    d.remove(); document.body.style.overflow = '';
    if (drawerReturn?.focus) drawerReturn.focus();
    if (route() === 'admin/members' && renderMembers.reload) renderMembers.reload();
  }

  async function drawPerson(id, newCode) {
    drawerId = id;
    let d;
    try { d = await api('GET', '/api/admin/persons/' + id); }
    catch (ex) { $('#dr-body').innerHTML = `<div class="alert alert-error">${esc(errText(ex.code))}</div>`; return; }
    const p = d.person;
    const locked = p.locked_until && p.locked_until > new Date().toISOString();
    $('#dr-title').textContent = name(p);
    $('#dr-body').innerHTML = `
      <section>
        <div class="row">${p.role === 'superadmin' ? `<span class="chip chip-info">${esc(t('role.superadmin'))}</span>` : `<span class="chip chip-muted">${esc(t('role.member'))}</span>`}
          ${locked ? `<span class="chip chip-danger">${esc(t('p.lockedUntil', { date: fmtDate(p.locked_until) }))}</span>` : ''}</div>
        <dl class="kv">
          <dt>KA</dt><dd>${esc(p.name_ka)}</dd><dt>EN</dt><dd>${esc(p.name_en)}</dd>
          <dt>${esc(t('adm.col.ids'))}</dt><dd class="mono">${p.ids.map((i) => `${esc(i.kind)} ${esc(i.value)}`).join('<br>')}</dd>
          <dt>${esc(t('adm.col.lastLogin'))}</dt><dd>${esc(p.last_login_at ? fmtDate(p.last_login_at) : t('adm.never'))}</dd>
        </dl>
      </section>
      <section><h3>${esc(t('p.access'))}</h3>
        ${newCode ? `<div class="code-reveal"><span class="label">${esc(t('p.newCode'))}</span><span class="code">${esc(newCode)}</span><span class="small">${esc(t('p.newCodeNote'))}</span>
          <div class="row"><button type="button" class="btn btn-sm" data-copy-msg="${esc(newCode)}">${esc(t('p.copyMessage'))}</button></div></div>` : ''}
        <p class="small muted">${esc(p.has_code ? t('p.codeIssuedAt', { date: fmtDate(p.code_issued_at) }) : t('p.noCodeYet'))}</p>
        <div class="row"><button type="button" class="btn btn-sm btn-primary" data-issue="${p.id}">${esc(p.has_code ? t('p.reset') : t('p.issue'))}</button>
          ${p.has_code && p.id !== S.user.id ? `<button type="button" class="btn btn-sm btn-danger" data-revoke-code="${p.id}">${esc(t('p.revokeCode'))}</button>` : ''}</div>
        <div id="revoke-code-confirm" hidden class="alert alert-warn col">${esc(t('p.revokeCodeAsk'))}
          <div class="row"><button type="button" class="btn btn-sm btn-danger" data-revoke-code-yes="${p.id}">${esc(t('p.confirm'))}</button><button type="button" class="btn btn-sm" data-cancel-confirm>${esc(t('p.cancel'))}</button></div></div>
      </section>
      <section><h3>${esc(t('p.contact'))}</h3>
        <form id="contact-form" class="stack" novalidate>
          <div class="field"><label for="c-phone">${esc(t('p.phone'))}</label><input class="input" id="c-phone" type="tel" value="${esc(p.phone || '')}"></div>
          <div class="field"><label for="c-email">${esc(t('p.email'))}</label><input class="input" id="c-email" type="email" value="${esc(p.email || '')}"></div>
          <div class="field"><label for="c-note">${esc(t('p.note'))}</label><textarea class="input" id="c-note" rows="2">${esc(p.note || '')}</textarea></div>
          <div><button class="btn btn-sm" type="submit">${esc(t('p.save'))}</button></div>
        </form>
      </section>
      <section><h3>${esc(t('p.units'))}</h3>
        <div class="unit-list">${d.units.map((u) => `<div class="unit-item"><b>${esc(unitTitle(u))}</b><span class="small num">${esc(t('unit.area', { a: fmtNum(u.area, 2) }))}</span><div class="meta"><span>${esc(floorText(u.floor))}</span><span class="mono">${esc(u.code)}</span></div></div>`).join('')}</div>
      </section>
      <section><h3>${esc(t('p.signatures'))}</h3>
        ${d.signatures.length ? `<div class="sig-list">${d.signatures.map((s) => `
          <div class="sig-item ${s.revoked_at ? 'revoked' : ''}"><img src="/api/admin/signatures/${s.id}/image" alt="${esc(t('me.pad'))}" loading="lazy">
            <div class="small stack gap-4"><span><b class="mono xs">${esc(s.unit_code)}</b> ${s.revoked_at ? statusChip('revoked') : statusChip('signed')}</span>
              <span class="muted">${esc(fmtDate(s.signed_at))} · ${esc(s.signed_name)} · ${esc(t('p.signedFrom', { ip: s.ip || '—' }))}</span>
              ${s.revoked_at ? `<span class="xs text-danger">${esc(t('p.revokedOn', { date: fmtDate(s.revoked_at), reason: s.revoke_reason }))}</span>`
                : `<div class="row" data-sigrow="${s.id}"><button type="button" class="link-btn xs" data-revoke-sig="${s.id}">${esc(t('p.revokeSig'))}</button></div>`}
            </div></div>`).join('')}</div>` : `<p class="muted small">${esc(t('p.noSigs'))}</p>`}
      </section>
      <section><h3>${esc(t('p.history'))}</h3>
        ${d.history.length ? `<div class="feed">${d.history.map((h) => `<div class="feed-item"><span>${esc(t('audit.' + h.action))}${h.actor ? ' · ' + esc(h.actor) : ''}</span><time>${esc(fmtDate(h.at))}</time></div>`).join('')}</div>` : `<p class="muted small">${esc(t('adm.empty'))}</p>`}
      </section>`;

    $('#contact-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('PATCH', '/api/admin/persons/' + p.id, { phone: $('#c-phone').value, email: $('#c-email').value, note: $('#c-note').value }); toast(t('p.saved')); }
      catch (ex) { toast(errText(ex.code)); }
    });
  }

  /* ---------- admin: audit ---------- */
  const AUDIT_ACTIONS = ['login', 'logout', 'login_failed', 'login_locked', 'login_blocked', 'access_code_issued', 'access_code_reset', 'access_code_revoked', 'signature_created', 'signature_denied', 'signature_revoked', 'person_updated', 'admin_view_person', 'export_csv', 'role_granted', 'role_revoked'];
  function renderAudit() {
    const f = F.audit;
    shell(`
      <div class="page-head"><div><h1>${esc(t('nav.audit'))}</h1></div></div>
      <section class="card">
        <div class="card-head filters"><select class="input" id="a-action" aria-label="${esc(t('adm.col.action'))}"><option value="all">${esc(t('adm.allActions'))}</option>${AUDIT_ACTIONS.map((a) => `<option value="${a}" ${f.action === a ? 'selected' : ''}>${esc(t('audit.' + a))}</option>`).join('')}</select></div>
        <div class="table-wrap" id="a-table"><div class="empty">${esc(t('adm.loading'))}</div></div>
        <div class="pager"><span id="a-page"></span><span class="row"><button class="btn btn-sm" id="a-prev" type="button">${esc(t('adm.prev'))}</button><button class="btn btn-sm" id="a-next" type="button">${esc(t('adm.next'))}</button></span></div>
      </section>`);
    const PAGE = 50;
    const load = async () => {
      try {
        const { entries, total } = await api('GET', `/api/admin/audit?limit=${PAGE}&offset=${f.offset}&action=${encodeURIComponent(f.action)}`);
        $('#a-page').textContent = total ? t('adm.page', { from: f.offset + 1, to: Math.min(total, f.offset + PAGE), total }) : '';
        $('#a-prev').disabled = f.offset === 0; $('#a-next').disabled = f.offset + PAGE >= total;
        $('#a-table').innerHTML = entries.length ? `<table class="data stackable"><thead><tr><th>${esc(t('adm.col.time'))}</th><th>${esc(t('adm.col.action'))}</th><th>${esc(t('adm.col.actor'))}</th><th>${esc(t('adm.col.target'))}</th><th>${esc(t('adm.col.ip'))}</th></tr></thead><tbody>
          ${entries.map((e) => `<tr>
            <td data-label="${esc(t('adm.col.time'))}" class="small num">${esc(fmtDate(e.at))}</td>
            <td data-label="${esc(t('adm.col.action'))}"><b>${esc(t('audit.' + e.action))}</b></td>
            <td data-label="${esc(t('adm.col.actor'))}" class="small">${e.name_en ? esc(name(e)) : `<span class="muted">${esc(t('audit.system'))}</span>`}</td>
            <td data-label="${esc(t('adm.col.target'))}" class="small">${e.target_en ? esc(S.lang === 'ka' ? e.target_ka : e.target_en) : `<span class="mono xs">${esc(e.target || '')}</span>`}</td>
            <td data-label="${esc(t('adm.col.ip'))}" class="mono xs">${esc(e.ip || '')}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">${esc(t('adm.empty'))}</div>`;
      } catch (ex) { $('#a-table').innerHTML = `<div class="alert alert-error">${esc(errText(ex.code))}</div>`; }
    };
    $('#a-action').addEventListener('change', (e) => { f.action = e.target.value; f.offset = 0; load(); });
    $('#a-prev').addEventListener('click', () => { f.offset = Math.max(0, f.offset - PAGE); load(); });
    $('#a-next').addEventListener('click', () => { f.offset += PAGE; load(); });
    load();
  }

  // Inline style attributes are blocked by the Content-Security-Policy; widths are set through the CSSOM.
  new MutationObserver(() => $$('[data-w]').forEach((el) => { el.style.width = Math.max(0, Math.min(100, Number(el.dataset.w))) + '%'; el.removeAttribute('data-w'); }))
    .observe(document.getElementById('app'), { childList: true, subtree: true });

  /* ---------- global events ---------- */
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('button, tr[data-person]');
    if (!el) return;
    const ds = el.dataset;
    if (ds.lang) { $('#toast').hidden = true; return setLang(ds.lang); }
    if (ds.action === 'logout') { $('#toast').hidden = true; try { await api('POST', '/api/auth/logout'); } catch (_) {} S.user = null; S.me = null; S.doc = null; return go('login'); }
    if (ds.action === 'close-drawer') return closeDrawer();
    if (ds.person) return openPerson(Number(ds.person));
    if (ds.issue) {
      el.disabled = true;
      try { const r = await api('POST', `/api/admin/persons/${ds.issue}/access-code`); await drawPerson(Number(ds.issue), r.code); }
      catch (ex) { toast(errText(ex.code)); el.disabled = false; }
      return;
    }
    if (ds.copyMsg) return copy(t('p.message', { code: ds.copyMsg, url: location.origin }));
    if (ds.revokeCode) { $('#revoke-code-confirm').hidden = false; return; }
    if (ds.cancelConfirm !== undefined) { $('#revoke-code-confirm').hidden = true; return; }
    if (ds.revokeCodeYes) {
      try { await api('DELETE', `/api/admin/persons/${ds.revokeCodeYes}/access-code`); await drawPerson(Number(ds.revokeCodeYes)); }
      catch (ex) { toast(errText(ex.code)); }
      return;
    }
    if (ds.revokeSig) {
      const row = $(`[data-sigrow="${ds.revokeSig}"]`);
      row.innerHTML = `<input class="input input-sm" placeholder="${esc(t('p.revokeReason'))}" aria-label="${esc(t('p.revokeReason'))}" id="rr-${esc(ds.revokeSig)}">
        <button type="button" class="btn btn-sm btn-danger" data-revoke-sig-yes="${esc(ds.revokeSig)}">${esc(t('p.confirm'))}</button>`;
      $(`#rr-${ds.revokeSig}`).focus();
      return;
    }
    if (ds.revokeSigYes) {
      const reason = $(`#rr-${ds.revokeSigYes}`).value;
      try {
        await api('POST', `/api/admin/signatures/${ds.revokeSigYes}/revoke`, { reason });
        if (drawerId) await drawPerson(drawerId);
      } catch (ex) { toast(errText(ex.code)); }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#drawer')) closeDrawer();
    if (e.key === 'Enter' && e.target.matches('tr[data-person]')) openPerson(Number(e.target.dataset.person));
  });

  /* ---------- boot ---------- */
  (async () => {
    try {
      const r = await api('GET', '/api/auth/session');
      S.user = r.user;
      let stored = null; try { stored = localStorage.getItem('alpiki.lang'); } catch (_) {}
      if (!LANGS.includes(stored) && LANGS.includes(r.user.lang)) S.lang = r.user.lang;
    } catch (_) { S.user = null; }
    render();
  })();
})();
