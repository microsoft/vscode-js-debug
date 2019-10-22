const fs = require('fs');
const path = require('path');
const desiredCrashes = 3;
const crashFile = path.join(__dirname, 'crashes.txt');

setTimeout(() => {
  let crashes;
  if (fs.existsSync(crashFile)) {
    crashes = Number(fs.readFileSync(crashFile, 'utf-8'));
  } else {
    crashes = 0;
  }

  if (crashes < desiredCrashes) {
    fs.writeFileSync(crashFile, String(crashes + 1));
    console.error(`Crash #${crashes + 1}`);
    process.exit(1);
  } else {
    fs.unlinkSync(crashFile);
    console.log('Finished crashes, running now...');
    debugger;
    setInterval(() => undefined, 1000);
  }
}, 1000);
