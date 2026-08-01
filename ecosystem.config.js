/**
 * pm2 config for a client deployment:  pm2 start ecosystem.config.js
 *
 * instances MUST stay 1. Data lives in JSON files with a per-process read cache,
 * so a second worker writes from a stale copy and silently loses orders. The
 * server refuses to boot as worker #1+ to make that mistake loud instead of
 * expensive. (This limit goes away when a store moves to SQLite.)
 */
module.exports = {
  apps: [{
    name: 'store',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',        // not 'cluster' — see above
    autorestart: true,
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    // Keep logs where a client's host can rotate them.
    out_file: 'logs/out.log',
    error_file: 'logs/error.log',
    merge_logs: true,
    time: true
  }]
};
