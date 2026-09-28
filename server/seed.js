'use strict';
/* Demo data: three users, one shared project with tasks and a few comments.
   Run with `npm run seed`. Sign in as ada@lane.dev / password123 */
const { db, tx } = require('./db');
const { hashPassword } = require('./auth');

const now = (offsetMin = 0) => new Date(Date.now() - offsetMin * 60000).toISOString();

if (db.prepare("SELECT 1 FROM users WHERE email = 'ada@lane.dev'").get()) {
  console.log('Demo data already exists.');
  process.exit(0);
}

tx(() => {
  const addUser = db.prepare('INSERT INTO users (name, email, password_hash, color, created_at) VALUES (?,?,?,?,?)');
  const ids = [
    ['Ada Lovelace', 'ada@lane.dev', '#1E78E6'],
    ['Grace Hopper', 'grace@lane.dev', '#1F9D63'],
    ['Linus Pauling', 'linus@lane.dev', '#DB6A1B'],
  ].map(([n, e, c]) => Number(addUser.run(n, e, hashPassword('password123'), c, now()).lastInsertRowid));
  const [ada, grace, linus] = ids;

  const pid = Number(db.prepare('INSERT INTO projects (name, owner_id, created_at) VALUES (?,?,?)').run('Website relaunch', ada, now(600)).lastInsertRowid);
  const addMember = db.prepare('INSERT INTO members (project_id, user_id) VALUES (?,?)');
  ids.forEach((u) => addMember.run(pid, u));

  const addTask = db.prepare(
    'INSERT INTO tasks (project_id, title, description, status, position, assignee_id, creator_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const t = (title, description, status, position, assignee, creator, ago) =>
    Number(addTask.run(pid, title, description, status, position, assignee, creator, now(ago), now(ago)).lastInsertRowid);

  t('Audit current navigation', 'List every page and how visitors reach it.', 'todo', 0, grace, ada, 500);
  const hero = t('Write homepage copy', 'Short, plain, one call to action.', 'todo', 1, ada, ada, 480);
  t('Set up analytics events', '', 'todo', 2, null, linus, 470);
  const nav = t('Design new navigation', 'Three top-level items, no dropdowns.', 'doing', 0, linus, ada, 300);
  t('Pick typefaces', 'One family, two weights.', 'doing', 1, ada, grace, 280);
  t('Collect brand assets', '', 'done', 0, grace, ada, 900);
  t('Choose hosting', '', 'done', 1, linus, linus, 880);

  const addComment = db.prepare('INSERT INTO comments (task_id, user_id, body, created_at) VALUES (?,?,?,?)');
  addComment.run(nav, grace, 'Can we test two variants with real visitors before committing?', now(90));
  addComment.run(nav, linus, 'Yes. I will have a prototype ready tomorrow.', now(45));
  addComment.run(hero, grace, 'Draft is in the shared folder when you want to compare.', now(20));
});

console.log('Seeded. Sign in with ada@lane.dev / password123');
