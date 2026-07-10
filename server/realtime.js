'use strict';
// Thin wrapper around socket.io so routes can broadcast without importing the server.
let io = null;

function init(server) {
  io = server;
}

// Broadcast a point-scoped update (stock, sale, shift change...) to everyone
// watching that point and to all monitors (BRE/Admin dashboards).
function emitPoint(pointId, event, data) {
  if (!io) return;
  io.to(`point:${pointId}`).emit(event, data);
  io.to('monitor').emit(event, { pointId, ...data });
}

function emitUser(userId, event, data) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

function emitAll(event, data) {
  if (!io) return;
  io.emit(event, data);
}

module.exports = { init, emitPoint, emitUser, emitAll };
