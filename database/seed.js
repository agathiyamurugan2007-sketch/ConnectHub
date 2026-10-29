// DEVELOPMENT ONLY: creates fictional demo users. Password for all: Demo@1234
const bcrypt = require('bcryptjs');
const db = require('./db');
const hash = bcrypt.hashSync('Demo@1234', 10);
const users = [['Asha Demo', 'asha', 'Fictional demo user. Loves travel.'], ['Ravi Demo', 'ravi', 'Fictional demo user. Coffee + code.'], ['Mei Demo', 'mei', 'Fictional demo user. Photographer.']];
const ins = db.prepare('INSERT OR IGNORE INTO users(full_name,username,email,password_hash,bio) VALUES(?,?,?,?,?)');
users.forEach(([n, u, b]) => ins.run(n, u, u + '@demo.local', hash, b));
if (db.prepare('SELECT COUNT(*) c FROM posts').get().c === 0) {
  const id = u => db.prepare('SELECT id FROM users WHERE username=?').get(u).id;
  const p = db.prepare('INSERT INTO posts(user_id,content) VALUES(?,?)');
  const a = p.run(id('asha'), 'Welcome to ConnectHub! (demo post)').lastInsertRowid;
  p.run(id('ravi'), 'Shipping my first Express app today.');
  p.run(id('mei'), 'Golden hour is the best hour.');
  db.prepare('INSERT INTO comments(post_id,user_id,content) VALUES(?,?,?)').run(a, id('ravi'), 'Nice to be here!');
  db.prepare('INSERT OR IGNORE INTO follows(follower_id,following_id) VALUES(?,?)').run(id('ravi'), id('asha'));
}
console.log('Seeded. Demo login: asha / Demo@1234 (development only)');
