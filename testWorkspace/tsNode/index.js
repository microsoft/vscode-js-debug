require('ts-node').register({ transpileModule: true })

const { double } = require('./double.ts');

const timeout = Date.now() + 10000;

(async () => {
  // Keep trying, giving the debugger time to parse sourcemaps; Node doesn't
  // let us pause on entry (at least right now) so this is, unfortunately, necessary.
  while (Date.now() < timeout) {
    await new Promise(resolve => setTimeout(resolve, 100));
    console.log(double(21));
  }
})();

