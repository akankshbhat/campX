/* CampX: one script for the whole front end. */

/* ===== Settings ===== */
// Leave '' when the CampX backend serves this site (open http://localhost:5000).
// Use 'http://localhost:5000' when opening these files with VS Code Live Server,
// and add Live Server's address to CLIENT_ORIGIN in the backend .env.
var CAMPX_API = '';

/* ===== Splash screen (runs immediately, before the page paints) ===== */
/* CampX splash screen logic. Loaded in <head> so the decision is made before the page paints. */
(function () {
  'use strict';
  var KEY = 'campx_splash_seen', SHOW_MS = 3000, root = document.documentElement;

  var nav = (window.performance && performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || {};
  var seen = false;
  try { seen = sessionStorage.getItem(KEY) === '1'; } catch (e) {}
  // Skip when already shown this session; a refresh shows it again.
  if (seen && nav.type !== 'reload') {
    root.classList.add('no-splash');
    return;
  }
  root.classList.add('splash-on');

  document.addEventListener('DOMContentLoaded', function () {
    var el = document.getElementById('splash');
    if (!el) { root.classList.remove('splash-on'); return; }
    var leaving = false, finished = false, timer;

    function finish() {
      if (finished) return;
      finished = true;
      if (el.parentNode) el.parentNode.removeChild(el);
      root.classList.remove('splash-on');
      try { sessionStorage.setItem(KEY, '1'); } catch (e) {}
    }
    function leave() {
      if (leaving) return;
      leaving = true;
      clearTimeout(timer);
      document.removeEventListener('keydown', leave);
      el.classList.add('out');
      el.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 900); // safety net if transitionend never fires
    }

    el.addEventListener('click', leave);       // click or tap anywhere
    document.addEventListener('keydown', leave); // any key
    try { el.focus({ preventScroll: true }); } catch (e) {}

    // The logo is drawn by the stylesheet (already loaded), so the 3 seconds start right away.
    timer = setTimeout(leave, SHOW_MS);
  });
})();

/* ===== App (runs once the page is ready) ===== */
document.addEventListener('DOMContentLoaded', function () {
'use strict';
const $ = (s) => document.querySelector(s);
const API = CAMPX_API.replace(/\/$/, '');
const TY = { sale: ['For sale', 'Sale'], rent: ['For rent', 'Rent'], free: ['Free to borrow', 'Free'] };
const CATS = ['Books', 'Electronics', 'Lab & gear', 'Clothing', 'Sports', 'Events', 'Other'];
const EM = { Books: '📘', Electronics: '💻', 'Lab & gear': '🔧', Clothing: '🧥', Sports: '🏸', Events: '🔊', Other: '📦' };
const TYPE_EM = { sale: '🏷️', rent: '🗓️', free: '🎁' };
const COND = { new: 'New', like_new: 'Like new', good: 'Good', fair: 'Fair' };
const STATUS = { pending: 'Waiting', accepted: 'Accepted', handed_over: 'In use', completed: 'Completed', rejected: 'Declined', cancelled: 'Cancelled', disputed: 'In dispute' };
const BMSCE_EMAIL = /^[^\s@]+@bmsce\.ac\.in$/i;
const DOMAIN_ERROR = 'Access restricted. Please use your official BMSCE email address to register.';
const DOMAIN_LOGIN_ERROR = 'Access restricted. Please use your official BMSCE email address to log in.';
const S = { type: 'all', cat: 'all', q: '', sort: 'new', page: 1, total: 0, role: 'requester' };
let token = null, user = null, items = [], mine = [], incoming = [];
try { token = localStorage.getItem('campx_token'); } catch (e) {}

// ---------- helpers ----------
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const fd = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const iso = (d) => { const x = new Date(d); return new Date(x - x.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const nDays = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const priceOf = (i) => (i.type === 'sale' ? money(i.price) : i.type === 'rent' ? money(i.price) + '/day' : 'No fee');
const imgOf = (i) => (i.images && i.images[0] ? `<img src="${API}${esc(i.images[0])}" alt="">` : '');
const scrollToList = () => $('#browse').scrollIntoView({ behavior: 'smooth' });
function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2800);
}
function show(html) { const d = $('#dlg'); d.innerHTML = html; if (!d.open) d.showModal(); }

// ---------- API ----------
async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {}; let payload;
  if (token) headers.Authorization = 'Bearer ' + token;
  if (form) payload = form;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try { res = await fetch(API + '/api' + path, { method, headers, body: payload }); }
  catch { throw new Error('Cannot reach the server. Is the backend running?'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) { signOut(); }
    throw new Error(data.details && data.details.length ? data.details.map((d) => d.message).join(' ') : data.error || 'Something went wrong.');
  }
  return data;
}

// ---------- session ----------
function refreshUI() {
  $('#acct').innerHTML = user ? `<span class="nm">${esc(user.name.split(' ')[0])}</span><span class="lo">Log out</span>` : 'Log in';
  render();
  if (!$('#reqs').hidden) renderReqs();
}
function applyUser(u, t) {
  if (t) { token = t; try { localStorage.setItem('campx_token', t); } catch (e) {} }
  user = u; refreshUI(); loadListings();
}
function signOut() {
  token = null; user = null; items = []; mine = []; incoming = []; S.total = 0;
  try { localStorage.removeItem('campx_token'); } catch (e) {}
  refreshUI();
}

// ---------- listings ----------
async function loadListings(more) {
  if (!user) { items = []; S.total = 0; return render(); }
  S.page = more ? S.page + 1 : 1;
  const p = new URLSearchParams({ sort: S.sort, page: S.page, limit: 12 });
  if (S.q) p.set('q', S.q);
  if (S.type !== 'all') p.set('type', S.type);
  if (S.cat !== 'all') p.set('category', S.cat);
  try { const d = await api('/listings?' + p); items = more ? items.concat(d.items) : d.items; S.total = d.total; }
  catch (e) { toast(e.message); }
  render();
}

const card = (i) => `<button class="card ${i.type}" data-act="open" data-id="${i._id}"><div class="thumb">${imgOf(i) || EM[i.category] || '📦'}<span class="badge b-${i.type}">${TY[i.type][1]}</span></div><div class="info"><h3>${esc(i.title)}</h3><div class="price">${priceOf(i)}${i.deposit ? ` <span class="meta">+ ${money(i.deposit)} deposit</span>` : ''}</div><div class="meta">${esc(i.owner && i.owner.name || 'Student')} · ${esc(i.pickupLocation || 'Campus')}</div></div></button>`;

function render() {
  document.querySelectorAll('#seg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.t === S.type));
  $('#more').hidden = !user || items.length >= S.total;
  if (!user) { $('#grid').innerHTML = '<div class="empty">Log in with your college email to see what students are sharing. <button class="btn sm" data-act="acct">Log in</button></div>'; return; }
  const filtered = S.q || S.type !== 'all' || S.cat !== 'all';
  $('#grid').innerHTML = items.length ? items.map(card).join('')
    : `<div class="empty">${filtered ? 'Nothing matches yet. Try another search, or ' : 'No listings yet. '}<button class="btn sm" data-act="list">${filtered ? 'list the item yourself' : 'List the first item'}</button></div>`;
}

async function openItem(id) {
  const i = items.find((x) => x._id === id); if (!i) return;
  const t = iso(new Date()), own = i.owner && i.owner._id === user.id;
  let f = '';
  if (i.type === 'rent') f = `<div class="two"><div><label for="f1">Pick up</label><input type="date" id="f1" min="${t}" value="${t}"></div><div><label for="f2">Return by</label><input type="date" id="f2" min="${t}" value="${iso(Date.now() + 864e5 * 2)}"></div></div><div class="sum" id="sum"></div>`;
  else if (i.type === 'free') f = `<label for="f2">Return by</label><input type="date" id="f2" min="${t}" value="${iso(Date.now() + 864e5 * 3)}"><div class="sum">No fee. Keep it for up to ${i.maxRentalDays} days and return it in the same condition.</div>`;
  else f = `<div class="sum">Price ${money(i.price)}. Pay offline when you meet.</div>`;
  const msg = `<label for="f3">Message to ${esc(i.owner && i.owner.name)} (optional)</label><textarea id="f3" rows="2" maxlength="500" placeholder="Hi! Is this still available?"></textarea>`;
  show(`<div class="dh b-${i.type}">${imgOf(i) || EM[i.category] || '📦'}</div><div class="db"><span class="badge b-${i.type}">${TY[i.type][0]}</span><h2>${esc(i.title)}</h2>
    <div class="meta">${esc(i.category)} · ${COND[i.condition] || ''} · Listed by ${esc(i.owner && i.owner.name)}<br>Pickup: ${esc(i.pickupLocation || 'Agree in chat')}</div>
    ${i.description ? `<p>${esc(i.description)}</p>` : ''}
    <p class="price" style="margin:10px 0 0">${priceOf(i)}${i.deposit ? ` + ${money(i.deposit)} refundable deposit` : ''}</p>
    <div class="meta" id="booked"></div>
    ${own ? '<div class="sum">This is your listing.</div>' : f + msg}
    <div class="acts"><button class="btn ghost" data-act="close">Close</button>${own ? `<button class="btn ghost" data-act="rm" data-id="${i._id}">Remove listing</button>` : `<button class="btn" data-act="send" data-id="${i._id}">${i.type === 'sale' ? 'Send purchase request' : i.type === 'rent' ? 'Send rental request' : 'Send borrow request'}</button>`}</div></div>`);
  $('#dlg').dataset.key = uid(); // a double click cannot create two requests
  if (i.type !== 'sale') {
    api(`/listings/${i._id}/availability`).then((d) => {
      const el = $('#booked');
      if (el && d.booked.length) el.innerHTML = 'Already booked: ' + d.booked.map((b) => `${fd(b.startDate)} to ${fd(b.endDate)}`).join(', ');
    }).catch(() => {});
  }
  if (i.type === 'rent' && !own) {
    const u = () => {
      const n = nDays($('#f1').value, $('#f2').value);
      $('#sum').innerHTML = n < 1 ? 'Return date must be after pick up.' : `${n} day${n > 1 ? 's' : ''} × ${money(i.price)} = <b>${money(n * i.price)}</b> fee, plus ${money(i.deposit)} deposit returned after you give it back. Up to ${i.maxRentalDays} days.`;
    };
    $('#f1').oninput = $('#f2').oninput = u; u();
  }
}

async function send(id, btn) {
  const i = items.find((x) => x._id === id);
  const body = { listingId: id, message: $('#f3').value.trim(), idempotencyKey: $('#dlg').dataset.key };
  if (i.type !== 'sale') {
    body.endDate = $('#f2').value;
    if (!body.endDate) return toast('Choose a return date');
    if (i.type === 'rent') { body.startDate = $('#f1').value; if (nDays(body.startDate, body.endDate) < 1) return toast('Return date must be after pick up'); }
  }
  btn.disabled = true;
  try { await api('/requests', { method: 'POST', body }); $('#dlg').close(); toast('Request sent to ' + i.owner.name); }
  catch (e) { toast(e.message); } finally { btn.disabled = false; }
}

async function removeListing(id) {
  if (!confirm('Remove this listing?')) return;
  try { await api('/listings/' + id, { method: 'DELETE' }); $('#dlg').close(); toast('Listing removed'); loadListings(); }
  catch (e) { toast(e.message); }
}

function openList() {
  if (!user) return openAuth('login');
  show(`<div class="db"><h2>List an item</h2><div class="meta">Share something you are not using.</div>
    <label for="n1">Item name</label><input id="n1" maxlength="80" placeholder="e.g. Scientific calculator">
    <label for="n7">Description (optional)</label><textarea id="n7" rows="2" maxlength="1000"></textarea>
    <div class="two"><div><label for="n2">Category</label><select id="n2">${CATS.map((c) => `<option>${c}</option>`).join('')}</select></div>
    <div><label for="n3">Listing type</label><select id="n3"><option value="free">Free to borrow</option><option value="rent">For rent</option><option value="sale">For sale</option></select></div></div>
    <div class="two"><div><label for="n4" id="l4">Price (₹)</label><input id="n4" type="number" min="0" value="0"></div><div><label for="n5">Deposit (₹)</label><input id="n5" type="number" min="0" value="0"></div></div>
    <div class="two"><div><label for="n8">Condition</label><select id="n8">${Object.entries(COND).map(([k, v]) => `<option value="${k}"${k === 'good' ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
    <div><label for="n6">Pickup spot</label><input id="n6" maxlength="80" placeholder="e.g. Library entrance"></div></div>
    <label for="n9">Photos (up to 4, JPG/PNG/WebP, 3 MB each)</label><input id="n9" type="file" accept="image/jpeg,image/png,image/webp" multiple>
    <div class="acts"><button class="btn ghost" data-act="close">Cancel</button><button class="btn" data-act="pub">Publish listing</button></div></div>`);
  $('#n3').onchange = () => {
    const t = $('#n3').value;
    $('#l4').textContent = t === 'rent' ? 'Fee per day (₹)' : 'Price (₹)';
    $('#n4').disabled = t === 'free'; $('#n5').disabled = t !== 'rent';
  };
  $('#n3').onchange();
}

async function publish(btn) {
  const title = $('#n1').value.trim(), type = $('#n3').value, price = +$('#n4').value || 0;
  if (title.length < 3) return toast('Add an item name (3+ characters)');
  if (type !== 'free' && price <= 0) return toast('Enter a price above ₹0');
  const files = [...$('#n9').files];
  if (files.length > 4) return toast('Choose up to 4 photos');
  if (files.some((x) => x.size > 3 * 1024 * 1024)) return toast('Each photo must be under 3 MB');
  const f = new FormData();
  f.append('title', title); f.append('description', $('#n7').value.trim()); f.append('category', $('#n2').value);
  f.append('type', type); f.append('price', type === 'free' ? 0 : price); f.append('deposit', type === 'rent' ? +$('#n5').value || 0 : 0);
  f.append('condition', $('#n8').value); f.append('pickupLocation', $('#n6').value.trim());
  files.forEach((x) => f.append('images', x));
  btn.disabled = true;
  try {
    await api('/listings', { method: 'POST', form: f });
    $('#dlg').close();
    Object.assign(S, { type: 'all', cat: 'all', q: '', sort: 'new' });
    $('#q').value = ''; $('#cat').value = 'all'; $('#sort').value = 'new';
    view('home'); loadListings(); toast('Listing published');
  } catch (e) { toast(e.message); } finally { btn.disabled = false; }
}

// ---------- requests ----------
async function loadReqs() {
  try { [mine, incoming] = await Promise.all([api('/requests?role=requester&limit=50'), api('/requests?role=owner&limit=50')]); }
  catch (e) { toast(e.message); }
  renderReqs();
}

function reqRow(r) {
  const own = S.role === 'owner', other = own ? r.requester : r.owner, l = r.listing || {};
  const btn = (d, label, cls = '') => `<button class="btn sm ${cls}" data-act="rq" data-do="${d}" data-r="${r._id}">${label}</button>`;
  const detail = r.type === 'sale' ? `Purchase · ${money(r.fee)}` : `${fd(r.startDate)} to ${fd(r.endDate)}` + (r.type === 'rent' ? ` · ${money(r.fee)} fee + ${money(r.deposit)} deposit` : ' · No fee');
  const iDid = own ? (r.status === 'accepted' ? r.ownerHandover : r.ownerReturn) : (r.status === 'accepted' ? r.requesterHandover : r.requesterReturn);
  const wait = '<span class="meta">Waiting for the other student</span>';
  let a = '';
  if (r.status === 'pending') a = own ? btn('accept', 'Accept') + btn('reject', 'Decline', 'ghost') : btn('cancel', 'Cancel', 'ghost');
  else if (r.status === 'accepted') a = (iDid ? wait : btn('hand', 'Confirm handover')) + (!r.ownerHandover && !r.requesterHandover ? btn('cancel', 'Cancel', 'ghost') : '') + btn('dispute', 'Dispute', 'ghost');
  else if (r.status === 'handed_over') a = (iDid ? wait : btn('ret', 'Confirm return')) + (own ? btn('dmg', 'Report damage', 'ghost') : '') + btn('dispute', 'Dispute', 'ghost');
  const label = r.isOverdue ? 'Overdue' : own && r.status === 'pending' ? 'New request' : STATUS[r.status];
  return `<div class="req">${l.images && l.images[0] ? `<img src="${API}${esc(l.images[0])}" alt="">` : `<div class="em">${TYPE_EM[r.type]}</div>`}<div class="mid"><b>${esc(l.title || 'Listing')}</b><div class="meta">${own ? 'From' : 'Owner'}: ${esc(other && other.name)} · ${detail}${r.message ? `<br>“${esc(r.message)}”` : ''}</div></div><span class="pill ${r.isOverdue ? 'warn' : ''}">${label}</span><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${a}</div></div>`;
}

function renderReqs() {
  if (!user) return;
  const done = mine.concat(incoming).filter((r) => r.status === 'completed');
  const reused = done.filter((r) => r.type !== 'sale').length, sold = done.filter((r) => r.type === 'sale').length;
  $('#stats').innerHTML = [[done.length, 'Completed exchanges'], [reused, 'Items borrowed or rented'], [sold, 'Second-hand purchases'], [done.length, 'New purchases avoided']].map((s) => `<div class="stat"><b>${s[0]}</b>${s[1]}</div>`).join('');
  const pend = incoming.filter((r) => r.status === 'pending').length;
  document.querySelectorAll('#rseg button').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.r === S.role);
    if (b.dataset.r === 'owner') b.textContent = 'Incoming' + (pend ? ` (${pend})` : '');
  });
  const list = S.role === 'owner' ? incoming : mine;
  $('#rlist').innerHTML = list.length ? list.map(reqRow).join('')
    : `<div class="empty">${S.role === 'owner' ? 'No one has requested your items yet.' : 'No requests yet. Find something on <button class="btn sm" data-act="view" data-v="home">Browse</button>.'}</div>`;
}

const ROUTE = { accept: ['PATCH', 'accept'], reject: ['PATCH', 'reject'], cancel: ['PATCH', 'cancel'], hand: ['POST', 'handover'], ret: ['POST', 'return'], dmg: ['POST', 'return'], dispute: ['POST', 'dispute'] };
const DONE_MSG = { accept: 'Request accepted. Arrange a campus handover.', reject: 'Request declined', cancel: 'Request cancelled', hand: 'Handover confirmed', ret: 'Return confirmed', dmg: 'Damage reported. An administrator will review it.', dispute: 'Dispute opened. An administrator will review it.' };
async function doReq(b) {
  const act = b.dataset.do; let body;
  if (act === 'dispute') { const reason = prompt('What went wrong? (at least 10 characters)'); if (!reason) return; body = { reason }; }
  if (act === 'dmg') { const notes = prompt('Describe the damage'); if (notes === null) return; body = { damaged: true, notes }; }
  if (act === 'reject') { const reason = prompt('Reason (optional)'); if (reason === null) return; body = { reason }; }
  if (act === 'cancel' && !confirm('Cancel this request?')) return;
  b.disabled = true;
  try { await api(`/requests/${b.dataset.r}/${ROUTE[act][1]}`, { method: ROUTE[act][0], body }); toast(DONE_MSG[act]); await loadReqs(); }
  catch (e) { toast(e.message); b.disabled = false; }
}

// ---------- auth dialog ----------
function openAuth(mode) {
  const reg = mode === 'register';
  show(`<div class="db"><h2>${reg ? 'Create your account' : 'Log in'}</h2><div class="meta">${reg ? 'Use your @bmsce.ac.in email. Students only.' : 'Welcome back.'}</div>
    ${reg ? '<label for="a1">Full name</label><input id="a1" autocomplete="name" maxlength="60">' : ''}
    <label for="a2">College email</label><input id="a2" type="email" autocomplete="email">
    ${reg ? '<div class="two"><div><label for="a3">Student ID</label><input id="a3" maxlength="30"></div><div><label for="a4">College</label><input id="a4" maxlength="80"></div></div>' : ''}
    <label for="a5">Password${reg ? ' (8+ characters)' : ''}</label><input id="a5" type="password" autocomplete="${reg ? 'new' : 'current'}-password">
    <div class="err" id="err" role="alert"></div>
    <div class="acts"><button class="btn ghost" data-act="${reg ? 'login' : 'register'}">${reg ? 'I have an account' : 'Create account'}</button><button class="btn" data-act="auth" data-mode="${mode}">${reg ? 'Sign up' : 'Log in'}</button></div></div>`);
}

async function submitAuth(mode, btn) {
  const v = (id) => $(id).value.trim();
  const err = (m, ok) => { const e = $('#err'); e.textContent = m; e.className = 'err' + (ok ? ' ok' : ''); };
  const email = v('#a2'), password = $('#a5').value;
  if (!email || !password) return err('Enter your email and password.');
  if (!BMSCE_EMAIL.test(email)) return err(mode === 'register' ? DOMAIN_ERROR : DOMAIN_LOGIN_ERROR);
  const body = { email, password };
  if (mode === 'register') Object.assign(body, { name: v('#a1'), studentId: v('#a3'), college: v('#a4') });
  btn.disabled = true; err('');
  try {
    if (mode === 'register') {
      const d = await api('/auth/register', { method: 'POST', body });
      openAuth('login'); $('#a2').value = email; err(d.message, true);
    } else {
      const d = await api('/auth/login', { method: 'POST', body });
      $('#dlg').close(); applyUser(d.user, d.token); toast('Welcome, ' + d.user.name.split(' ')[0]);
    }
  } catch (e) { err(e.message); } finally { btn.disabled = false; }
}

// ---------- navigation + events ----------
function view(v) {
  if (v === 'reqs' && !user) return openAuth('login');
  $('#home').hidden = v !== 'home'; $('#reqs').hidden = v !== 'reqs'; $('#faq').hidden = v !== 'faq'; $('#about').hidden = v !== 'about';
  document.querySelectorAll('.nb:not(.acct)').forEach((b) => b.setAttribute('aria-current', b.dataset.v === v));
  if (v === 'reqs') loadReqs();
  window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const d = b.dataset;
  switch (d.act) {
    case 'open': openItem(d.id); break;
    case 'close': $('#dlg').close(); break;
    case 'send': send(d.id, b); break;
    case 'list': openList(); break;
    case 'pub': publish(b); break;
    case 'rm': removeListing(d.id); break;
    case 'view': view(d.v); break;
    case 'type': S.type = d.t; loadListings(); break;
    case 'go': S.q = $('#q').value.trim(); loadListings(); scrollToList(); break;
    case 'more': loadListings(true); break;
    case 'acct': if (user) { signOut(); toast('Logged out'); } else openAuth('login'); break;
    case 'login': openAuth('login'); break;
    case 'register': openAuth('register'); break;
    case 'auth': submitAuth(d.mode, b); break;
    case 'role': S.role = d.r; renderReqs(); break;
    case 'rq': doReq(b); break;
  }
});
$('#dlg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'file') {
    e.preventDefault(); const p = $('#dlg .acts .btn:not(.ghost)'); if (p) p.click();
  }
});
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { S.q = e.target.value.trim(); loadListings(); scrollToList(); } });
$('#cat').innerHTML = '<option value="all">All categories</option>' + CATS.map((c) => `<option>${c}</option>`).join('');
$('#cat').onchange = (e) => { S.cat = e.target.value; loadListings(); };
$('#sort').onchange = (e) => { S.sort = e.target.value; loadListings(); };

// ---------- start ----------
(async function boot() {
  view('home');
  if (token) { try { user = await api('/auth/me'); } catch (e) {} }
  if (user) applyUser(user); else refreshUI();
})();
});
