((defaultValue) => {
  try {
    return global.customDebuggerDescription(this, defaultValue);
  } catch (e) {
    return e.stack || e.message || String(e);
  }
})()
