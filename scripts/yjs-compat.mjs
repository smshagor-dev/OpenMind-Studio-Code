// Drives the real `yjs` package for the Rust <-> JavaScript compatibility tests (crates/collab/tests/yjs_compat.rs).
// Reads one JSON request on stdin, writes one JSON answer on stdout. Binary values are base64. The shared text is
// `doc.getText("content")`, as in the app.
import * as Y from "yjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const bin = (text) => new Uint8Array(Buffer.from(text ?? "", "base64"));

function load(state, updates = []) {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, bin(state));
  for (const update of updates) Y.applyUpdate(doc, bin(update));
  return doc;
}

function describe(doc) {
  return {
    text: doc.getText("content").toString(),
    state: b64(Y.encodeStateAsUpdate(doc)),
    sv: b64(Y.encodeStateVector(doc)),
  };
}

const handlers = {
  create: ({ text }) => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, text);
    return describe(doc);
  },
  apply: ({ state, updates }) => describe(load(state, updates)),
  edit: ({ state, at, remove, insert }) => {
    const doc = load(state);
    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      const text = doc.getText("content");
      if (remove > 0) text.delete(at, remove);
      if (insert) text.insert(at, insert);
    });
    return { ...describe(doc), update: b64(Y.encodeStateAsUpdate(doc, before)) };
  },
  diff: ({ state, sv }) => ({ update: b64(Y.encodeStateAsUpdate(load(state), bin(sv))) }),
};

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify(handlers[request.op](request)));
});
