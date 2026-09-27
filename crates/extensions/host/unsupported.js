'use strict';
// The one "not supported" error of the extension host. Every module throws it the same way, so each use is also
// reported (logged against the calling extension and listed under "Unsupported APIs used" on its details page).

let reporter = null;

function setReporter(fn) {
  reporter = fn;
}

function unsupportedMessage(name) {
  return `VS Code API '${name}' is not supported by OpenMind Studio yet.`;
}

/** Reports the use and returns the error to throw. */
function unsupportedError(name) {
  const message = unsupportedMessage(name);
  if (reporter) reporter(message);
  return new Error(message);
}

module.exports = { setReporter, unsupportedMessage, unsupportedError };
