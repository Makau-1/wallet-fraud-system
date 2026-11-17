// The session store, shared so that "sign out my other devices" can end
// sessions other than the current one.
//
// Sessions are kept in the web server's memory (express-session's
// MemoryStore), which suits the single web process this project deploys.
// Running several web processes would need a shared store such as Redis.

const session = require('express-session');

module.exports = new session.MemoryStore();
