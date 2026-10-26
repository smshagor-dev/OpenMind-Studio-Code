'use strict';
// An extension's `context.secrets` (VS Code's SecretStorage): every value lives encrypted in the app, asked for over the
// host channel; nothing is kept in the host. Split out of host.js.

/** `request` is the host's request to the app. */
function secretStorage(request, extensionId) {
  const changed = new (require('./vscode.js').EventEmitter)();
  const checkKey = (key) => {
    if (typeof key !== 'string' || key === '' || key.length > 256) throw new Error('A secret key must be a string of 1 to 256 characters.');
    return key;
  };
  return {
    async get(key) {
      const answer = await request('secrets/get', { extension: extensionId, key: checkKey(key) });
      return answer && typeof answer.value === 'string' ? answer.value : undefined;
    },
    async store(key, value) {
      if (typeof value !== 'string') throw new Error('A secret value must be a string.');
      if (value.length > 64 * 1024) throw new Error('A secret value may not be longer than 64 KB.');
      await request('secrets/store', { extension: extensionId, key: checkKey(key), value });
      changed.fire({ key });
    },
    async delete(key) {
      await request('secrets/delete', { extension: extensionId, key: checkKey(key) });
      changed.fire({ key });
    },
    async keys() {
      const answer = await request('secrets/keys', { extension: extensionId });
      return Array.isArray(answer && answer.keys) ? answer.keys : [];
    },
    onDidChange: changed.event,
  };
}

module.exports = { secretStorage };
