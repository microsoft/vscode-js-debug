const skipped = require('./skippedScript');

const fns = {
  ...skipped,
  caughtInUserCode: () => {
    try {
      skipped.uncaught();
    } catch (e) {
      // ignored
    }
  },
};

setTimeout(() => {
  fns[process.argv[3]]();
}, process.argv[2]);
