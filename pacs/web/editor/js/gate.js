/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Input gate: until every script has run, user input could reach a handler whose helpers live in a later file.
// DOMContentLoaded fires only after all parser-inserted scripts (defer included) have executed.
(function () {
  const EVENTS = ['click', 'dblclick', 'keydown', 'input', 'change', 'paste', 'submit', 'dragover', 'drop'];
  const hold = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  EVENTS.forEach((type) => window.addEventListener(type, hold, true));
  document.addEventListener('DOMContentLoaded', () => {
    EVENTS.forEach((type) => window.removeEventListener(type, hold, true));
  }, { once: true });
})();
