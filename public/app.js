/* Lane — client. Vanilla JS, no build step. */

/* ======================================================================
   helpers
   ====================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const COLUMNS = [
  { id: 'todo', name: 'To do' },
  { id: 'doing', name: 'In progress' },
  { id: 'done', name: 'Done' },
];
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

/** Tiny DOM builder. Text is always inserted as text nodes, never as HTML. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

const ICONS = {
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  msg: '<path d="M4 5h16v11H9l-5 4V5Z"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  out: '<path d="M9 4H5v16h4M15 8l4 4-4 4M19 12H9"/>',
  invite: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M18 8v6M15 11h6"/>',
};
function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  svg.innerHTML = ICONS[name];
  return svg;
}

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
function avatar(user, size = 24) {
  const el = h('span', {
    class: 'avatar', title: user.name,
    style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.42) + 'px' },
  }, initials(user.name));
  el.style.setProperty('--c', user.color);
  return el;
}
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const byPos = (a, b) => a.position - b.position || a.id - b.id;
const autosize = (el) => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; };
function animate(el, frames, opts) {
  if (!reduceMotion) el.animate(frames, { easing: EASE, ...opts });
}

/* ======================================================================
   state & api
   ====================================================================== */
const S = {
  token: localStorage.getItem('lane.token'),
  me: null,
  projects: [], projectId: null, project: null, members: [], tasks: [],
  online: new Set(), notifs: [],
  openId: null, comments: [],
  ws: null, retry: 0, wasDown: false,
  adding: null, addValue: '',
  dragId: null, dirty: false, slot: null,
  flash: new Set(),
  pop: null, popAnchor: null,
};
const D = {}; // drawer element refs
const H = {}; // header element refs

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && S.token && !path.startsWith('/auth')) signOut();
    throw new Error(data.error || 'Something went wrong. Try again.');
  }
  return data;
}
const member = (id) => S.members.find((m) => m.id === id);

/* ======================================================================
   auth screen
   ====================================================================== */
function logoMark(size = 26) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32'); svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect width="32" height="32" rx="9" fill="#2b3bff"/><rect x="8" y="8" width="6" height="16" rx="2" fill="#fff"/><rect x="18" y="8" width="6" height="10" rx="2" fill="#fff"/>';
  return svg;
}
const brand = () => h('div', { class: 'brand' }, logoMark(), h('span', {}, 'Lane'));

function renderAuth() {
  closeSocket();
  document.title = 'Lane';
  let mode = 'login';
  const host = h('div', { class: 'auth-form-wrap' });

  const draw = () => {
    const isNew = mode === 'register';
    const err = h('p', { class: 'form-error', role: 'alert' });
    const name = h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: '60' });
    const email = h('input', { type: 'email', autocomplete: 'email', required: true });
    const pw = h('input', { type: 'password', autocomplete: isNew ? 'new-password' : 'current-password', required: true, minlength: isNew ? '8' : null });
    const btn = h('button', { class: 'btn primary wide', type: 'submit' }, isNew ? 'Create account' : 'Sign in');

    const form = h('form', {
      class: 'auth-form',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        try {
          const r = await api(`/auth/${isNew ? 'register' : 'login'}`, { method: 'POST', body: { name: name.value, email: email.value, password: pw.value } });
          S.token = r.token; S.me = r.user;
          localStorage.setItem('lane.token', r.token);
          await enterApp();
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
        }
      },
    },
      isNew && h('label', { class: 'field' }, 'Name', name),
      h('label', { class: 'field' }, 'Email', email),
      h('label', { class: 'field' }, isNew ? 'Password (8+ characters)' : 'Password', pw),
      err, btn);

    host.replaceChildren(
      h('h2', {}, isNew ? 'Create your account' : 'Sign in'),
      form,
      h('p', { class: 'auth-switch' }, isNew ? 'Already have an account? ' : 'New to Lane? ',
        h('button', { class: 'link-btn', type: 'button', onclick: () => { mode = isNew ? 'login' : 'register'; draw(); } }, isNew ? 'Sign in' : 'Create an account')));
    (isNew ? name : email).focus();
  };
  draw();

  const demo = h('div', { class: 'demo', 'aria-hidden': 'true' },
    [0, 1, 2].map(() => h('div', { class: 'demo-col' }, h('i'), h('i'), h('i'))),
    h('div', { class: 'demo-card' }));

  $('#app').replaceChildren(h('div', { class: 'auth' },
    h('section', { class: 'auth-hero' }, brand(),
      h('div', { class: 'hero-copy' }, h('h1', {}, 'Move work forward, together.'), h('p', {}, 'Projects, tasks and conversations for small teams.')),
      demo),
    h('section', { class: 'auth-panel' }, host)));
}

function signOut() {
  localStorage.removeItem('lane.token');
  closeSocket();
  closePops(true);
  Object.assign(S, { token: null, me: null, projects: [], projectId: null, project: null, members: [], tasks: [], openId: null, notifs: [], comments: [], online: new Set() });
  history.replaceState(null, '', location.pathname);
  renderAuth();
}

/* ======================================================================
   app shell
   ====================================================================== */
async function enterApp() {
  buildShell();
  connect();
  const [{ projects }, { notifications }] = await Promise.all([api('/projects'), api('/notifications')]);
  S.projects = projects;
  S.notifs = notifications;
  renderSidebar();
  renderBell();
  await route();
}

function buildShell() {
  const bell = h('button', { class: 'icon-btn', id: 'bell', type: 'button', 'aria-label': 'Notifications', 'data-pop-anchor': '', onclick: (e) => toggleNotifs(e.currentTarget) }, icon('bell', 18));
  $('#app').replaceChildren(
    h('div', { class: 'shell' },
      h('aside', { class: 'sidebar' },
        brand(),
        h('div', { class: 'nav-label' }, 'Projects'),
        h('nav', { class: 'nav', id: 'nav', 'aria-label': 'Projects' }, h('div', { class: 'nav-indicator' })),
        newProjectControl(),
        h('div', { class: 'me' },
          h('div', { class: 'me-name' }, avatar(S.me, 26), h('span', {}, S.me.name)),
          h('span', { class: 'live off', id: 'live', title: 'Connecting' }),
          bell,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Sign out', title: 'Sign out', onclick: signOut }, icon('out', 18)))),
      h('main', { class: 'main', id: 'main' })),
    h('div', { class: 'scrim', id: 'scrim', onclick: closeTask }),
    h('aside', { class: 'drawer', id: 'drawer', tabindex: '-1', 'aria-label': 'Task details' }));
}

function newProjectControl(inMain = false) {
  const wrap = h('div', { class: 'new-project' });
  const btn = h('button', { class: 'nav-add', type: 'button', onclick: open }, icon('plus', 15), 'New project');
  function close() { wrap.replaceChildren(btn); }
  function open() {
    const input = h('input', { placeholder: 'Project name', maxlength: '80', 'aria-label': 'Project name', onkeydown: (e) => e.key === 'Escape' && close(), onblur: () => !input.value.trim() && close() });
    wrap.replaceChildren(h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        try { await createProject(name); close(); } catch (ex) { toast(ex.message); }
      },
    }, input));
    input.focus();
  }
  wrap.append(btn);
  return wrap;
}

async function createProject(name) {
  const { project } = await api('/projects', { method: 'POST', body: { name } });
  if (!S.projects.some((p) => p.id === project.id)) S.projects.push(project);
  renderSidebar();
  location.hash = `#/p/${project.id}`;
}

function renderSidebar() {
  const nav = $('#nav');
  if (!nav) return;
  nav.querySelectorAll('.nav-item').forEach((n) => n.remove());
  for (const p of S.projects) {
    nav.append(h('a', { class: 'nav-item', href: `#/p/${p.id}`, 'aria-current': p.id === S.projectId ? 'page' : null }, p.name));
  }
  moveIndicator();
}
function moveIndicator() {
  const ind = $('.nav-indicator');
  const cur = $('.nav-item[aria-current]');
  if (!ind) return;
  if (!cur) { ind.style.opacity = '0'; return; }
  ind.style.opacity = '1';
  ind.style.height = cur.offsetHeight + 'px';
  ind.style.transform = `translateY(${cur.offsetTop}px)`;
  requestAnimationFrame(() => ind.classList.add('ready'));
}

/* ======================================================================
   routing: #/p/<projectId>[/t/<taskId>]
   ====================================================================== */
async function route() {
  if (!S.me) return;
  const m = location.hash.match(/^#\/p\/(\d+)(?:\/t\/(\d+))?/);
  let pid = m ? Number(m[1]) : null;
  let tid = m && m[2] ? Number(m[2]) : null;
  if (!pid || !S.projects.some((p) => p.id === pid)) {
    pid = S.projects[0]?.id ?? null;
    tid = null;
    if (pid) history.replaceState(null, '', `#/p/${pid}`);
  }
  if (pid !== S.projectId || !S.project) await loadProject(pid);
  if (tid && S.tasks.some((t) => t.id === tid)) showTask(tid); else hideTask();
}
window.addEventListener('hashchange', route);

async function loadProject(pid, { refresh = false } = {}) {
  S.projectId = pid;
  if (pid == null) {
    S.project = null; S.members = []; S.tasks = [];
    renderSidebar();
    renderNoProject();
    return;
  }
  try {
    const data = await api('/projects/' + pid);
    if (S.projectId !== pid) return; // user navigated elsewhere while loading
    S.project = data.project; S.members = data.members; S.tasks = data.tasks;
  } catch (ex) {
    toast(ex.message);
    S.projects = S.projects.filter((p) => p.id !== pid);
    S.projectId = null; S.project = null;
    return route();
  }
  renderSidebar();
  if (refresh && $('.board')) {
    renderBoard(); updateProgress(); renderMembers(); if (S.openId) syncDrawer();
  } else {
    document.title = `${S.project.name} · Lane`;
    renderProjectView();
  }
}

function renderNoProject() {
  document.title = 'Lane';
  hideTask();
  const input = h('input', { placeholder: 'Project name', maxlength: '80', 'aria-label': 'Project name' });
  $('#main').replaceChildren(h('div', { class: 'empty' },
    h('h2', {}, 'Start with a project'),
    h('p', {}, 'Create one to add tasks and invite your team.'),
    h('form', { onsubmit: async (e) => { e.preventDefault(); if (input.value.trim()) try { await createProject(input.value.trim()); } catch (ex) { toast(ex.message); } } },
      input, h('button', { class: 'btn primary', type: 'submit' }, 'Create project'))));
  animate($('.empty'), [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 400 });
}

/* ======================================================================
   project view: header + board
   ====================================================================== */
function renderProjectView() {
  const isOwner = S.project.owner_id === S.me.id;
  H.fill = h('i');
  H.text = h('span');
  H.members = h('div', { class: 'members' });
  H.del = isOwner && h('button', { class: 'btn ghost danger', type: 'button', onclick: confirmDeleteProject }, icon('trash', 15), 'Delete');

  $('#main').replaceChildren(
    h('header', { class: 'top' },
      h('div', {},
        h('h1', {}, S.project.name),
        h('div', { class: 'progress' }, h('span', { class: 'bar', role: 'presentation' }, H.fill), H.text)),
      h('div', { class: 'top-right' },
        H.members,
        h('button', { class: 'btn', type: 'button', 'data-pop-anchor': '', onclick: (e) => openInvite(e.currentTarget) }, icon('invite', 16), 'Invite'),
        H.del)),
    h('div', { class: 'board' }));

  renderMembers();
  renderBoard({ enter: true });
  requestAnimationFrame(updateProgress);
}

function updateProgress() {
  if (!H.fill) return;
  const total = S.tasks.length;
  const done = S.tasks.filter((t) => t.status === 'done').length;
  H.fill.style.transform = `scaleX(${total ? done / total : 0})`;
  H.text.textContent = total ? `${done} of ${total} done` : 'No tasks yet';
}

function renderMembers() {
  if (!H.members) return;
  H.members.replaceChildren(...S.members.map((m) =>
    h('span', { class: 'av-wrap' }, avatar(m, 30), S.online.has(m.id) && h('span', { class: 'dot', title: 'Online' }))));
}

let deleteArmed = false;
async function confirmDeleteProject(e) {
  const btn = e.currentTarget;
  if (!deleteArmed) {
    deleteArmed = true;
    btn.replaceChildren(icon('trash', 15), 'Click again to delete');
    setTimeout(() => { deleteArmed = false; if (btn.isConnected) btn.replaceChildren(icon('trash', 15), 'Delete'); }, 3000);
    return;
  }
  deleteArmed = false;
  try { await api('/projects/' + S.projectId, { method: 'DELETE' }); } catch (ex) { toast(ex.message); }
}

/* ---------- board rendering with FLIP animation ---------- */
function renderBoard({ enter = false } = {}) {
  const board = $('.board');
  if (!board) return;
  if (S.dragId != null) { S.dirty = true; return; } // never rebuild under a drag in progress

  const before = new Map();
  board.querySelectorAll('.card').forEach((c) => before.set(c.dataset.id, c.getBoundingClientRect()));
  const scrolls = [...board.querySelectorAll('.list')].map((l) => l.scrollTop);

  const cols = COLUMNS.map((col) => {
    const tasks = S.tasks.filter((t) => t.status === col.id).sort(byPos);
    const list = h('div', { class: 'list' }, tasks.map(cardEl));
    return wireColumn(h('section', { class: 'col', dataset: { status: col.id }, 'aria-label': col.name },
      h('div', { class: 'col-head' }, h('h2', {}, col.name), h('span', { class: 'count' }, String(tasks.length))),
      list, addTaskEl(col.id)), list, col.id);
  });
  board.replaceChildren(...cols);
  board.querySelectorAll('.list').forEach((l, i) => (l.scrollTop = scrolls[i] || 0));

  if (S.adding) {
    const input = $(`.col[data-status="${S.adding}"] .add-input`);
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  if (enter) {
    // one orchestrated moment: lanes settle in, left to right
    cols.forEach((c, i) => animate(c, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 520, delay: i * 70, fill: 'backwards' }));
  } else {
    board.querySelectorAll('.card').forEach((c) => {
      const old = before.get(c.dataset.id);
      if (old) {
        const r = c.getBoundingClientRect();
        const dx = old.left - r.left, dy = old.top - r.top;
        if (dx || dy) animate(c, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 340 });
      } else {
        animate(c, [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 300 });
      }
    });
  }

  for (const id of S.flash) $(`.card[data-id="${id}"]`)?.classList.add('flash');
  S.flash.clear();
}

function cardEl(t) {
  const assignee = member(t.assignee_id);
  return h('div', {
    class: 'card', draggable: 'true', tabindex: '0', role: 'button', dataset: { id: t.id },
    onclick: () => openTask(t.id),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTask(t.id); } },
    ondragstart: (e) => onDragStart(e, t),
  },
    h('p', { class: 'card-title' }, t.title),
    (t.comment_count > 0 || assignee) && h('div', { class: 'card-meta' },
      h('span', { class: 'meta-item', title: `${t.comment_count} comments` }, t.comment_count > 0 && [icon('msg', 14), String(t.comment_count)]),
      assignee && avatar(assignee, 22)));
}

function addTaskEl(status) {
  if (S.adding !== status) {
    return h('button', { class: 'add', type: 'button', onclick: () => { S.adding = status; S.addValue = ''; renderBoard(); } }, icon('plus', 15), 'Add task');
  }
  const close = () => { S.adding = null; S.addValue = ''; renderBoard(); };
  return h('input', {
    class: 'add-input', placeholder: 'Task title, then Enter', maxlength: '200', 'aria-label': 'New task title', value: S.addValue,
    oninput: (e) => (S.addValue = e.target.value),
    onkeydown: async (e) => {
      if (e.key === 'Escape') return close();
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const title = e.target.value.trim();
      if (!title) return close();
      S.addValue = '';
      e.target.value = '';
      try {
        const { task } = await api(`/projects/${S.projectId}/tasks`, { method: 'POST', body: { title, status } });
        upsertTask(task);
      } catch (ex) { toast(ex.message); }
    },
    onblur: (e) => { if (!e.target.value.trim() && S.adding === status) setTimeout(() => S.adding === status && close(), 0); },
  });
}

/* ---------- drag and drop ---------- */
function onDragStart(e, t) {
  S.dragId = t.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(t.id));
  const el = e.currentTarget;
  S.slot = h('div', { class: 'slot', style: {} });
  S.slot.style.setProperty('--slot-h', el.offsetHeight + 'px');
  requestAnimationFrame(() => el.classList.add('dragging'));
}

function wireColumn(col, list, status) {
  col.addEventListener('dragover', (e) => {
    if (S.dragId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cards = [...list.querySelectorAll('.card:not(.dragging)')];
    const ref = cards.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; }) || null;
    let next = S.slot.nextElementSibling;
    while (next && next.classList.contains('dragging')) next = next.nextElementSibling;
    if (S.slot.parentNode !== list || next !== ref) list.insertBefore(S.slot, ref);
  });
  col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) S.slot?.remove(); });
  col.addEventListener('drop', (e) => {
    if (S.dragId == null) return;
    e.preventDefault();
    const id = S.dragId;
    const kids = [...list.children];
    const stop = kids.indexOf(S.slot);
    const before = (stop < 0 ? kids : kids.slice(0, stop)).filter((k) => k.classList.contains('card') && !k.classList.contains('dragging'));
    endDrag();
    moveTask(id, status, before.length);
  });
  return col;
}
function endDrag() {
  S.dragId = null;
  S.slot?.remove();
  document.querySelectorAll('.card.dragging').forEach((c) => c.classList.remove('dragging'));
  if (S.dirty) { S.dirty = false; renderBoard(); }
}
document.addEventListener('dragend', endDrag);

/** Pure: returns a new task list with `id` placed at `index` in column `status`. */
function applyMove(tasks, id, status, index) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return tasks;
  const others = tasks.filter((x) => x.status === status && x.id !== id).sort(byPos);
  others.splice(Math.min(index, others.length), 0, { ...t, status });
  const pos = new Map(others.map((x, i) => [x.id, i]));
  return tasks.map((x) => (pos.has(x.id) ? { ...x, status: x.id === id ? status : x.status, position: pos.get(x.id) } : x));
}

async function moveTask(id, status, index) {
  const cur = S.tasks.find((t) => t.id === id);
  if (!cur) return;
  const sameSpot = cur.status === status && S.tasks.filter((t) => t.status === status).sort(byPos).findIndex((t) => t.id === id) === Math.min(index, S.tasks.filter((t) => t.status === status).length - 1);
  if (sameSpot) return renderBoard();
  const prev = S.tasks;
  S.tasks = applyMove(S.tasks, id, status, index);
  renderBoard(); updateProgress(); if (S.openId === id) syncDrawer();
  try {
    await api(`/tasks/${id}/move`, { method: 'POST', body: { status, index } });
  } catch (ex) {
    S.tasks = prev; renderBoard(); updateProgress(); toast(ex.message);
  }
}

/* ---------- task list mutations (used by API responses and websocket events) ---------- */
function upsertTask(task, remote = false) {
  if (task.project_id !== S.projectId) return;
  const i = S.tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) S.tasks[i] = task; else S.tasks.push(task);
  if (remote) S.flash.add(task.id);
  renderBoard(); updateProgress();
  if (S.openId === task.id) syncDrawer();
}
function removeTask(id) {
  S.tasks = S.tasks.filter((t) => t.id !== id);
  renderBoard(); updateProgress();
  if (S.openId === id) closeTask();
}
function setCount(taskId, count) {
  const t = S.tasks.find((x) => x.id === taskId);
  if (!t || t.comment_count === count) return;
  t.comment_count = count;
  renderBoard();
  if (S.openId === taskId) D.count.textContent = String(count);
}

/* ======================================================================
   task drawer
   ====================================================================== */
const openTask = (id) => { location.hash = `#/p/${S.projectId}/t/${id}`; };
const closeTask = () => { if (S.projectId) location.hash = `#/p/${S.projectId}`; };

function showTask(id) {
  const drawer = $('#drawer');
  if (S.openId !== id) {
    S.openId = id; S.comments = [];
    buildDrawer();
    loadComments(id);
  } else syncDrawer();
  clearTimeout(D.closeTimer);
  requestAnimationFrame(() => {
    drawer.classList.add('open');
    $('#scrim').classList.add('show');
  });
  if (!D.focused) { drawer.focus({ preventScroll: true }); D.focused = true; }
}
function hideTask() {
  if (S.openId == null && !$('#drawer')?.classList.contains('open')) return;
  S.openId = null; D.focused = false;
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('show');
  D.closeTimer = setTimeout(() => $('#drawer')?.replaceChildren(), 420);
}

function buildDrawer() {
  D.title = h('textarea', {
    class: 'd-title', rows: '1', maxlength: '200', 'aria-label': 'Task title',
    oninput: (e) => autosize(e.target),
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
    onchange: (e) => {
      const v = e.target.value.trim();
      const t = S.tasks.find((x) => x.id === S.openId);
      if (!v) { e.target.value = t.title; return autosize(e.target); }
      patchTask({ title: v });
    },
  });
  D.pills = h('div', { class: 'seg', role: 'group', 'aria-label': 'Status' },
    COLUMNS.map((c) => h('button', { class: 'seg-btn', type: 'button', dataset: { status: c.id }, onclick: () => moveTask(S.openId, c.id, 1e6) }, c.name)));
  D.assignee = h('select', { class: 'select', 'aria-label': 'Assignee', onchange: (e) => patchTask({ assignee_id: e.target.value ? Number(e.target.value) : null }) });
  D.desc = h('textarea', { class: 'd-desc', placeholder: 'Add details', maxlength: '5000', 'aria-label': 'Description', oninput: (e) => autosize(e.target), onchange: (e) => patchTask({ description: e.target.value }) });
  D.meta = h('p', { class: 'd-meta' });
  D.count = h('span', { class: 'count' });
  D.list = h('div', { class: 'comments' });
  D.input = h('textarea', { class: 'composer-input', rows: '1', maxlength: '2000', placeholder: 'Write a comment', 'aria-label': 'Write a comment', oninput: (e) => autosize(e.target), onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendComment(); } } });
  D.send = h('button', { class: 'btn primary', type: 'button', onclick: sendComment }, 'Comment');
  D.del = h('button', { class: 'btn ghost danger', type: 'button', onclick: confirmDeleteTask }, icon('trash', 15), 'Delete task');
  D.body = h('div', { class: 'd-body' },
    D.title,
    h('div', { class: 'field-row' }, h('span', { class: 'k' }, 'Assignee'), D.assignee),
    D.meta, D.desc,
    h('div', { class: 'd-comments-head' }, h('h3', {}, 'Comments'), D.count),
    D.list);
  D.optKey = '';
  $('#drawer').replaceChildren(
    h('div', { class: 'd-top' }, D.pills, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: closeTask }, icon('x', 18))),
    D.body,
    h('div', { class: 'composer' }, D.input, h('div', { class: 'composer-actions' }, h('span', { class: 'hint' }, `${MOD} + Enter to send`), D.send)),
    h('div', { class: 'd-foot' }, D.del));
  syncDrawer(true);
}

/** Bring drawer fields in line with state, without stomping on a field the user is editing. */
function syncDrawer(force = false) {
  const t = S.tasks.find((x) => x.id === S.openId);
  if (!t || !D.title) return;
  const set = (el, v) => { if (force || document.activeElement !== el) el.value = v; autosize(el); };
  set(D.title, t.title);
  set(D.desc, t.description);
  D.pills.querySelectorAll('.seg-btn').forEach((b) => { const on = b.dataset.status === t.status; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });

  const key = S.members.map((m) => m.id).join(',');
  if (force || D.optKey !== key) {
    D.optKey = key;
    D.assignee.replaceChildren(h('option', { value: '' }, 'Unassigned'), ...S.members.map((m) => h('option', { value: m.id }, m.id === S.me.id ? `${m.name} (you)` : m.name)));
  }
  if (force || document.activeElement !== D.assignee) D.assignee.value = t.assignee_id ?? '';

  const creator = member(t.creator_id);
  D.meta.textContent = `Created${creator ? ' by ' + creator.name : ''} on ${new Date(t.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  D.count.textContent = String(t.comment_count);
}

async function patchTask(fields) {
  const id = S.openId;
  try {
    const { task } = await api(`/tasks/${id}`, { method: 'PATCH', body: fields });
    upsertTask(task);
  } catch (ex) { toast(ex.message); syncDrawer(true); }
}

let taskDeleteArmed = false;
async function confirmDeleteTask(e) {
  const btn = e.currentTarget;
  if (!taskDeleteArmed) {
    taskDeleteArmed = true;
    btn.replaceChildren(icon('trash', 15), 'Click again to delete');
    setTimeout(() => { taskDeleteArmed = false; if (btn.isConnected) btn.replaceChildren(icon('trash', 15), 'Delete task'); }, 3000);
    return;
  }
  taskDeleteArmed = false;
  const id = S.openId;
  try { await api(`/tasks/${id}`, { method: 'DELETE' }); removeTask(id); } catch (ex) { toast(ex.message); }
}

/* ---------- comments ---------- */
function commentEl(c, fresh = false) {
  const u = member(c.user_id) || { name: 'Former member', color: '#888888' };
  const el = h('div', { class: 'comment' },
    avatar(u, 28),
    h('div', { class: 'c-body' }, h('div', { class: 'c-head' }, h('strong', {}, u.name), h('time', { datetime: c.created_at }, ago(c.created_at))), h('p', {}, c.body)));
  if (fresh) animate(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 300 });
  return el;
}
async function loadComments(id) {
  try {
    const { comments } = await api(`/tasks/${id}/comments`);
    if (S.openId !== id) return;
    S.comments = comments;
    D.list.replaceChildren(...(comments.length ? comments.map((c) => commentEl(c)) : [h('p', { class: 'empty-note' }, 'No comments yet. Start the conversation.')]));
  } catch (ex) { toast(ex.message); }
}
function addComment(c) {
  if (S.openId !== c.task_id || S.comments.some((x) => x.id === c.id)) return;
  S.comments.push(c);
  D.list.querySelector('.empty-note')?.remove();
  D.list.append(commentEl(c, true));
  D.body.scrollTo({ top: D.body.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
}
async function sendComment() {
  const body = D.input.value.trim();
  if (!body || S.openId == null) return;
  D.send.disabled = true;
  try {
    const r = await api(`/tasks/${S.openId}/comments`, { method: 'POST', body: { body } });
    D.input.value = ''; autosize(D.input);
    addComment(r.comment);
    setCount(r.comment.task_id, r.comment_count);
  } catch (ex) { toast(ex.message); }
  D.send.disabled = false;
  D.input.focus();
}

/* ======================================================================
   popovers: invite + notifications
   ====================================================================== */
function placePop(pop, anchor, { align = 'right' } = {}) {
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, ht = pop.offsetHeight;
  const below = r.top < innerHeight / 2;
  let left = align === 'right' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  const top = below ? r.bottom + 8 : Math.max(8, r.top - ht - 8);
  pop.classList.add(below ? 'below' : 'above');
  Object.assign(pop.style, { left: left + 'px', top: top + 'px' });
  S.pop = pop; S.popAnchor = anchor;
}
function closePops(immediate = false) {
  const pop = S.pop;
  S.pop = null; S.popAnchor = null;
  if (!pop) return;
  if (immediate || reduceMotion) return pop.remove();
  pop.classList.add('leaving');
  setTimeout(() => pop.remove(), 140);
}
document.addEventListener('mousedown', (e) => { if (S.pop && !S.pop.contains(e.target) && !e.target.closest('[data-pop-anchor]')) closePops(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (S.pop) closePops();
  else if (S.openId != null && !e.target.closest?.('.add-input')) closeTask();
});

function openInvite(btn) {
  if (S.popAnchor === btn) return closePops();
  closePops(true);
  const input = h('input', { type: 'email', required: true, placeholder: 'name@company.com', autocomplete: 'off' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', {
    class: 'pop invite',
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try {
        const { member: m } = await api(`/projects/${S.projectId}/members`, { method: 'POST', body: { email: input.value } });
        addMember(m); closePops(); toast(`${m.name} joined ${S.project.name}`);
      } catch (ex) { err.textContent = ex.message; }
    },
  }, h('label', {}, 'Invite by email', input), err, h('button', { class: 'btn primary', type: 'submit' }, 'Add to project'));
  placePop(form, btn);
  input.focus();
}
function addMember(m) {
  if (S.members.some((x) => x.id === m.id)) return;
  S.members.push(m);
  renderMembers();
  if (S.openId != null) syncDrawer();
}

function renderBell() {
  const bell = $('#bell');
  if (!bell) return;
  const unread = S.notifs.some((n) => !n.read);
  bell.querySelector('.pip')?.remove();
  if (unread) bell.append(h('span', { class: 'pip' }));
  bell.setAttribute('aria-label', unread ? 'Notifications (unread)' : 'Notifications');
}
async function toggleNotifs(btn) {
  if (S.popAnchor === btn) return closePops();
  closePops(true);
  const snapshot = S.notifs.map((n) => ({ ...n }));
  const hadUnread = snapshot.some((n) => !n.read);
  const list = h('div', { class: 'n-list' }, snapshot.length
    ? snapshot.map((n) => h('button', { class: 'n-item' + (n.read ? '' : ' unread'), type: 'button', onclick: () => { closePops(); if (n.project_id) location.hash = `#/p/${n.project_id}` + (n.task_id ? `/t/${n.task_id}` : ''); } },
        h('span', { class: 'n-dot' }), h('span', {}, h('span', { class: 'n-text' }, n.text), h('span', { class: 'n-time' }, ago(n.created_at)))))
    : h('p', { class: 'n-empty' }, 'You’re all caught up.'));
  placePop(h('div', { class: 'pop' }, h('div', { class: 'pop-head' }, 'Notifications'), list), btn, { align: 'left' });
  if (hadUnread) {
    S.notifs.forEach((n) => (n.read = 1));
    renderBell();
    api('/notifications/read', { method: 'POST' }).catch(() => {});
  }
}

/* ---------- toasts ---------- */
function toast(text, onclick) {
  const el = h('div', { class: 'toast', role: 'status', onclick: () => { onclick?.(); dismiss(); } }, text);
  $('#toasts').append(el);
  animate(el, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 320 });
  const dismiss = () => {
    if (reduceMotion) return el.remove();
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).onfinish = () => el.remove();
  };
  setTimeout(dismiss, 4500);
}

/* ======================================================================
   real-time (WebSocket)
   ====================================================================== */
function setLive(on) {
  const dot = $('#live');
  if (!dot) return;
  dot.classList.toggle('off', !on);
  dot.title = on ? 'Live' : 'Reconnecting';
}
function closeSocket() {
  const ws = S.ws;
  S.ws = null;
  if (ws) { ws.onclose = null; ws.close(); }
}
function connect() {
  if (S.ws || !S.token) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(S.token)}`);
  S.ws = ws;
  ws.onopen = () => { S.retry = 0; setLive(true); if (S.wasDown) resync(); };
  ws.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.ws = null; S.wasDown = true; setLive(false);
    if (S.token) setTimeout(connect, Math.min(10000, 500 * 2 ** S.retry++));
  };
}
async function resync() {
  S.wasDown = false;
  try {
    const [p, n] = await Promise.all([api('/projects'), api('/notifications')]);
    S.projects = p.projects; S.notifs = n.notifications;
    renderBell();
    if (S.projectId) await loadProject(S.projectId, { refresh: true });
  } catch { /* the next event or reload will catch up */ }
}

function onEvent(ev) {
  const mine = ev.by === S.me.id;
  switch (ev.type) {
    case 'presence':
      S.online = new Set(ev.online); renderMembers(); break;
    case 'notification':
      S.notifs.unshift(ev.notification); renderBell();
      toast(ev.notification.text, () => { const n = ev.notification; if (n.project_id) location.hash = `#/p/${n.project_id}` + (n.task_id ? `/t/${n.task_id}` : ''); });
      break;
    case 'task:upsert':
      upsertTask(ev.task, !mine); break;
    case 'task:delete':
      if (ev.project_id === S.projectId) removeTask(ev.id); break;
    case 'tasks:sync': {
      if (ev.project_id !== S.projectId || mine) break;
      const old = new Map(S.tasks.map((t) => [t.id, t]));
      ev.tasks.forEach((t) => { const o = old.get(t.id); if (o && (o.status !== t.status || o.position !== t.position)) S.flash.add(t.id); });
      S.tasks = ev.tasks; renderBoard(); updateProgress(); if (S.openId) syncDrawer();
      break;
    }
    case 'comment:new':
      setCount(ev.comment.task_id, ev.comment_count);
      addComment(ev.comment);
      break;
    case 'member:added':
      if (ev.project_id === S.projectId) addMember(ev.member); break;
    case 'project:added':
      if (!S.projects.some((p) => p.id === ev.project.id)) { S.projects.push(ev.project); renderSidebar(); if (S.projectId == null) route(); }
      break;
    case 'project:removed': {
      S.projects = S.projects.filter((p) => p.id !== ev.project_id);
      if (ev.project_id === S.projectId) { S.project = null; S.projectId = null; if (!mine) toast('This project was deleted'); route(); }
      else renderSidebar();
      break;
    }
  }
}

/* ======================================================================
   boot
   ====================================================================== */
(async function boot() {
  if (!S.token) return renderAuth();
  try {
    S.me = (await api('/me')).user;
    await enterApp();
  } catch {
    localStorage.removeItem('lane.token');
    S.token = null;
    renderAuth();
  }
})();
