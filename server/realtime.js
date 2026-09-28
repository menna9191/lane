'use strict';
/* Minimal WebSocket server (RFC 6455) built on Node's http "upgrade" event.
   Text frames only, server -> client. Clients authenticate with ?token=... */
const crypto = require('node:crypto');
const { db } = require('./db');
const { verifyToken } = require('./auth');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20;

/** userId -> Set<socket> (a user can have several tabs open) */
const clients = new Map();

function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function send(socket, event) {
  if (socket.writable) socket.write(encodeFrame(JSON.stringify(event)));
}

/* ---- public emit helpers ---- */
function toUsers(userIds, event) {
  for (const id of new Set(userIds)) {
    for (const socket of clients.get(id) || []) send(socket, event);
  }
}

function toProject(projectId, event) {
  const ids = db.prepare('SELECT user_id FROM members WHERE project_id = ?').all(projectId).map((r) => r.user_id);
  toUsers(ids, event);
}

/** Each user only learns about presence of people they share a project with. */
function broadcastPresence() {
  const sharedStmt = db.prepare(
    `SELECT DISTINCT m2.user_id AS id FROM members m1
       JOIN members m2 ON m1.project_id = m2.project_id WHERE m1.user_id = ?`
  );
  for (const uid of clients.keys()) {
    const shared = new Set(sharedStmt.all(uid).map((r) => r.id));
    const online = [...clients.keys()].filter((id) => shared.has(id));
    toUsers([uid], { type: 'presence', online });
  }
}

/* ---- server wiring ---- */
function attach(server) {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    const userId = url.pathname === '/ws' ? verifyToken(url.searchParams.get('token')) : null;

    if (!userId || !key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n')
    );
    socket.setNoDelay(true);

    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(socket);
    broadcastPresence();

    let buffer = Buffer.alloc(0);
    let alive = true;

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (len > MAX_FRAME) return socket.destroy();
        const total = offset + (masked ? 4 : 0) + len;
        if (buffer.length < total) return;

        const payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total));
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        buffer = buffer.subarray(total);

        if (opcode === 0x8) {            // close
          socket.end(encodeFrame(Buffer.alloc(0), 0x8));
          return;
        }
        if (opcode === 0x9) socket.write(encodeFrame(payload, 0xa)); // ping -> pong
        if (opcode === 0xa) alive = true;                             // pong
        /* Text frames from clients are ignored: all writes go through the REST API. */
      }
    });

    const heartbeat = setInterval(() => {
      if (!alive) return socket.destroy();
      alive = false;
      if (socket.writable) socket.write(encodeFrame(Buffer.alloc(0), 0x9));
    }, 30000);

    const cleanup = () => {
      clearInterval(heartbeat);
      const set = clients.get(userId);
      if (!set || !set.delete(socket)) return;
      if (set.size === 0) clients.delete(userId);
      broadcastPresence();
    };
    socket.on('close', cleanup);
    socket.on('error', () => socket.destroy());
  });
}

module.exports = { attach, toUsers, toProject, broadcastPresence };
