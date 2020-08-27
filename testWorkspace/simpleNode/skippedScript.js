exports.uncaught = () => {
  throw 'uncaught';
}

exports.caught = () => {
  try {
    throw 'caught';
  } catch (e) {
    // ignored
  }
}

exports.rethrown = () => {
  try {
    throw 'rethrown';
  } catch (e) {
    throw e;
  }
}
