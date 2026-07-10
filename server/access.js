'use strict';
const db = require('./db');

// Returns the list of point ids a user is allowed to see/act on.
function visiblePointIds(user) {
  if (user.role === 'ADMIN') {
    return db.prepare('SELECT id FROM points').all().map((r) => r.id);
  }
  if (user.role === 'BRE') {
    return db.prepare('SELECT id FROM points WHERE bre_id = ?').all(user.id).map((r) => r.id);
  }
  // SE: only points they are connected to
  return db.prepare('SELECT point_id AS id FROM point_se WHERE se_id = ?').all(user.id).map((r) => r.id);
}

function canSeePoint(user, pointId) {
  return visiblePointIds(user).includes(Number(pointId));
}

// SE must be actively connected to act on a point
function seConnected(userId, pointId) {
  return !!db.prepare('SELECT 1 FROM point_se WHERE se_id = ? AND point_id = ?').get(userId, pointId);
}

module.exports = { visiblePointIds, canSeePoint, seConnected };
