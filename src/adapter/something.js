function _generatedCode(defaultValue) {
  try {
    return (function (def) {
      return global.customDebuggerDescription(this, def)
    })(defaultValue);
  } catch (e) {
    return e.stack || e.message || String(e);
  }
}
