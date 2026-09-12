module.exports = {
  apps: [
    {
      name: 'lh-api',
      cwd: __dirname,
      script: 'dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 10000,
      listen_timeout: 10000,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 8080,
      },
    },
  ],
}
