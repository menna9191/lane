'use strict';
const { db, tx } = require('./db');
const { hashPassword, verifyPassword, signToken } = require('./auth');
const rt = require('./realtime');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const COLORS = ['#D93F4C', '#DB6A1B', '#A9820B', '#1F9D63', '#1E78E6', '#6D4FD1', '#C93A94', '#0F9587'];
const STATUSES = ['todo', 'doing', 'done'];
const now = () => new Date().toISOString();

/* ---------- validation ---------- */
function text(value, label, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `${label} is required`);
  const s = value.trim();
  if (s.length < min) throw new HttpError(400, `${label} is required`);
  if (s.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer`);
  return s;
}
function intId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid id');
  return n;
}

/* ---------- queries ---------- */
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, color: u.color });

const TASK_SQL = `
  SELECT t.id, t.project_id, t.title, t.description, t.status, t.position,
         t.assignee_id, t.creator_id, t.created_at, t.updated_at,
         (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
  FROM tasks t`;
const getTask = (id) => db.prepare(`${TASK_SQL} WHERE t.id = ?`).get(id);
const listTasks = (projectId) =>
  db.prepare(`${TASK_SQL} WHERE t.project_id = ? ORDER BY t.status, t.position, t.id`).all(projectId);
const listMembers = (projectId) =>
  db.prepare(
    `SELECT u.id, u.name, u.email, u.color FROM members m
       JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.rowid`
  ).all(projectId);
const getProject = (id) => db.prepare('SELECT id, name, owner_id, created_at FROM projects WHERE id = ?').get(id);

function memberOf(projectId, userId) {
  return !!db.prepare('SELECT 1 FROM members WHERE project_id = ? AND user_id = ?').get(projectId, userId);
}
function requireProject(projectId, userId) {
  const project = getProject(projectId);
  if (!project || !memberOf(projectId, userId)) throw new HttpError(404, 'Project not found');
  return project;
}
function requireTask(taskId, userId) {
  const task = getTask(taskId);
  if (!task) throw new HttpError(404, 'Task not found');
  requireProject(task.project_id, userId);
  return task;
}

function notify(userId, { type, text: message, project_id = null, task_id = null }) {
  const created_at = now();
  const r = db
    .prepare('INSERT INTO notifications (user_id, type, text, project_id, task_id, created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, type, message, project_id, task_id, created_at);
  const notification = { id: Number(r.lastInsertRowid), type, text: message, project_id, task_id, read: 0, created_at };
  rt.toUsers([userId], { type: 'notification', notification });
}

/** Put a task at `index` within a column and renumber that column. */
function placeTask(task, status, index) {
  const others = db
    .prepare('SELECT id FROM tasks WHERE project_id = ? AND status = ? AND id <> ? ORDER BY position, id')
    .all(task.project_id, status, task.id)
    .map((r) => r.id);
  others.splice(Math.max(0, Math.min(index, others.length)), 0, task.id);
  const update = db.prepare('UPDATE tasks SET status = ?, position = ?, updated_at = ? WHERE id = ?');
  const stamp = now();
  others.forEach((id, i) => update.run(status, i, stamp, id));
}

/* ---------- route table ---------- */
const routes = [];
const add = (method, pattern, handler, { auth = true } = {}) => routes.push({ method, pattern, handler, auth });

/* ===== auth ===== */
add('POST', '/api/auth/register', (ctx) => {
  const name = text(ctx.body.name, 'Name', { max: 60 });
  const email = text(ctx.body.email, 'Email', { max: 120 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  const password = ctx.body.password;
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (password.length > 200) throw new HttpError(400, 'Password is too long');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email is already registered');

  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const r = db
    .prepare('INSERT INTO users (name, email, password_hash, color, created_at) VALUES (?,?,?,?,?)')
    .run(name, email, hashPassword(password), COLORS[count % COLORS.length], now());
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
  ctx.status = 201;
  return { token: signToken(user.id), user: publicUser(user) };
}, { auth: false });

add('POST', '/api/auth/login', (ctx) => {
  const email = typeof ctx.body.email === 'string' ? ctx.body.email.trim().toLowerCase() : '';
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Incorrect email or password');
  return { token: signToken(user.id), user: publicUser(user) };
}, { auth: false });

add('GET', '/api/me', (ctx) => ({ user: publicUser(ctx.user) }));

/* ===== projects ===== */
add('GET', '/api/projects', (ctx) => ({
  projects: db.prepare(
    `SELECT p.id, p.name, p.owner_id, p.created_at FROM projects p
       JOIN members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.created_at, p.id`
  ).all(ctx.user.id),
}));

add('POST', '/api/projects', (ctx) => {
  const name = text(ctx.body.name, 'Project name', { max: 80 });
  const id = tx(() => {
    const r = db.prepare('INSERT INTO projects (name, owner_id, created_at) VALUES (?,?,?)').run(name, ctx.user.id, now());
    const pid = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO members (project_id, user_id) VALUES (?,?)').run(pid, ctx.user.id);
    return pid;
  });
  ctx.status = 201;
  return { project: getProject(id) };
});

add('GET', '/api/projects/:id', (ctx) => {
  const pid = intId(ctx.params.id);
  const project = requireProject(pid, ctx.user.id);
  return { project, members: listMembers(pid), tasks: listTasks(pid) };
});

add('DELETE', '/api/projects/:id', (ctx) => {
  const pid = intId(ctx.params.id);
  const project = requireProject(pid, ctx.user.id);
  if (project.owner_id !== ctx.user.id) throw new HttpError(403, 'Only the project owner can delete it');
  const memberIds = listMembers(pid).map((m) => m.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
  rt.toUsers(memberIds, { type: 'project:removed', project_id: pid, by: ctx.user.id });
  return { ok: true };
});

add('POST', '/api/projects/:id/members', (ctx) => {
  const pid = intId(ctx.params.id);
  const project = requireProject(pid, ctx.user.id);
  const email = text(ctx.body.email, 'Email', { max: 120 }).toLowerCase();
  const invitee = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!invitee) throw new HttpError(404, 'No account uses that email. Ask them to sign up first.');
  if (memberOf(pid, invitee.id)) throw new HttpError(409, `${invitee.name} is already on this project`);

  db.prepare('INSERT INTO members (project_id, user_id) VALUES (?,?)').run(pid, invitee.id);
  const member = publicUser(invitee);
  rt.toProject(pid, { type: 'member:added', project_id: pid, member, by: ctx.user.id });
  rt.toUsers([invitee.id], { type: 'project:added', project: project });
  notify(invitee.id, { type: 'project', text: `${ctx.user.name} added you to “${project.name}”`, project_id: pid });
  rt.broadcastPresence();
  ctx.status = 201;
  return { member };
});

/* ===== tasks ===== */
add('POST', '/api/projects/:id/tasks', (ctx) => {
  const pid = intId(ctx.params.id);
  requireProject(pid, ctx.user.id);
  const title = text(ctx.body.title, 'Title', { max: 200 });
  const status = STATUSES.includes(ctx.body.status) ? ctx.body.status : 'todo';
  const position = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tasks WHERE project_id = ? AND status = ?')
    .get(pid, status).p;
  const stamp = now();
  const r = db
    .prepare('INSERT INTO tasks (project_id, title, status, position, creator_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(pid, title, status, position, ctx.user.id, stamp, stamp);
  const task = getTask(Number(r.lastInsertRowid));
  rt.toProject(pid, { type: 'task:upsert', task, by: ctx.user.id });
  ctx.status = 201;
  return { task };
});

add('PATCH', '/api/tasks/:id', (ctx) => {
  const current = requireTask(intId(ctx.params.id), ctx.user.id);
  const b = ctx.body;
  const next = { title: current.title, description: current.description, assignee_id: current.assignee_id };

  if ('title' in b) next.title = text(b.title, 'Title', { max: 200 });
  if ('description' in b) {
    if (typeof b.description !== 'string' || b.description.length > 5000) throw new HttpError(400, 'Description must be 5000 characters or fewer');
    next.description = b.description;
  }
  if ('assignee_id' in b) {
    if (b.assignee_id === null) next.assignee_id = null;
    else {
      const assignee = intId(b.assignee_id);
      if (!memberOf(current.project_id, assignee)) throw new HttpError(400, 'Assignee must be a member of this project');
      next.assignee_id = assignee;
    }
  }

  db.prepare('UPDATE tasks SET title = ?, description = ?, assignee_id = ?, updated_at = ? WHERE id = ?')
    .run(next.title, next.description, next.assignee_id, now(), current.id);
  const task = getTask(current.id);

  if (next.assignee_id && next.assignee_id !== current.assignee_id && next.assignee_id !== ctx.user.id) {
    notify(next.assignee_id, {
      type: 'assigned',
      text: `${ctx.user.name} assigned you “${task.title}”`,
      project_id: task.project_id,
      task_id: task.id,
    });
  }
  rt.toProject(task.project_id, { type: 'task:upsert', task, by: ctx.user.id });
  return { task };
});

add('POST', '/api/tasks/:id/move', (ctx) => {
  const task = requireTask(intId(ctx.params.id), ctx.user.id);
  if (!STATUSES.includes(ctx.body.status)) throw new HttpError(400, 'Unknown status');
  const index = Number.isFinite(ctx.body.index) ? Math.trunc(ctx.body.index) : 1e9;
  tx(() => placeTask(task, ctx.body.status, index));
  const tasks = listTasks(task.project_id);
  rt.toProject(task.project_id, { type: 'tasks:sync', project_id: task.project_id, tasks, by: ctx.user.id });
  return { tasks };
});

add('DELETE', '/api/tasks/:id', (ctx) => {
  const task = requireTask(intId(ctx.params.id), ctx.user.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  rt.toProject(task.project_id, { type: 'task:delete', id: task.id, project_id: task.project_id, by: ctx.user.id });
  return { ok: true };
});

/* ===== comments ===== */
add('GET', '/api/tasks/:id/comments', (ctx) => {
  const task = requireTask(intId(ctx.params.id), ctx.user.id);
  return {
    comments: db.prepare('SELECT id, task_id, user_id, body, created_at FROM comments WHERE task_id = ? ORDER BY id').all(task.id),
  };
});

add('POST', '/api/tasks/:id/comments', (ctx) => {
  const task = requireTask(intId(ctx.params.id), ctx.user.id);
  const body = text(ctx.body.body, 'Comment', { max: 2000 });
  const created_at = now();
  const r = db.prepare('INSERT INTO comments (task_id, user_id, body, created_at) VALUES (?,?,?,?)').run(task.id, ctx.user.id, body, created_at);
  const comment = { id: Number(r.lastInsertRowid), task_id: task.id, user_id: ctx.user.id, body, created_at };
  const comment_count = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?').get(task.id).n;

  rt.toProject(task.project_id, { type: 'comment:new', comment, comment_count, project_id: task.project_id, by: ctx.user.id });

  const recipients = new Set([task.assignee_id, task.creator_id].filter((id) => id && id !== ctx.user.id));
  for (const uid of recipients) {
    notify(uid, {
      type: 'comment',
      text: `${ctx.user.name} commented on “${task.title}”`,
      project_id: task.project_id,
      task_id: task.id,
    });
  }
  ctx.status = 201;
  return { comment, comment_count };
});

/* ===== notifications ===== */
add('GET', '/api/notifications', (ctx) => ({
  notifications: db.prepare(
    'SELECT id, type, text, project_id, task_id, read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30'
  ).all(ctx.user.id),
}));

add('POST', '/api/notifications/read', (ctx) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(ctx.user.id);
  return { ok: true };
});

module.exports = { routes, HttpError };
