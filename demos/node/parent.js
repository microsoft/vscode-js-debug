const { spawn } = require('child_process');

let counter = 0;
setInterval(() => {
  const id = counter++;
  console.log('Spawning child', id);
  spawn('node', ['child', id], { cwd: __dirname, stdio: 'inherit' });
}, 5000);
