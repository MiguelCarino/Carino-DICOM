// A stand-in Carino DICOM worklist for tests/suites/eyephoto.js, loaded into a same-origin frame.
// A file rather than inline script: the page's Content-Security-Policy (inherited by srcdoc
// frames) forbids inline code.
window.got = [];
window.answer = { ok: true };
addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.carinoCreate !== 'files') return;
  got.push({ origin: e.origin, d });
  setTimeout(() => parent.postMessage({ carinoCreate: 'stored', reply: d.reply, ok: answer.ok, message: answer.message }, '*'), 20);
});
