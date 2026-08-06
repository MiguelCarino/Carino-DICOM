<!--
Thanks for sending this. Keep the sections that apply and delete the ones that
do not — an honest short PR description beats a complete-looking empty one.
If this is your first change here, CONTRIBUTING.md is worth ten minutes.
-->

## What this changes

<!-- One or two sentences, from the point of view of someone using the software.
     What can they do now that they could not before, or what stops going wrong? -->

## Why

<!-- The problem behind it. Link the issue if there is one: "Fixes #12". -->

## How it was tested

<!-- The most useful section in the whole description. Be specific:

     - Which OS, and installed how (source / packaged / desktop dev).
     - Which listeners were running.
     - For DICOM changes, WHAT EQUIPMENT it actually talked to — make, model,
       software version — or the tool that stood in for it (storescu, dcmtk,
       another PACS, a viewer) with its version.
     - Which tests you ran:
         ./.venv/bin/python -m pytest tests/ -v
         ./.venv/bin/python tests/test_index.py
         ./.venv/bin/python test_print.py
     - Anything you could not test and why.

     "Ran the test suite" alone is not enough for a change that touches the
     network. -->

## Checklist

- [ ] I read the safety rule in CONTRIBUTING.md, and this change introduces no
      path where a study can be silently not delivered. Failures still retry and
      stay visible.
- [ ] No patient data anywhere in the diff, the tests, the screenshots or this
      description.
- [ ] No AI or tool attribution in commits, comments or docs.
- [ ] Commit messages are imperative, sentence case, and describe the effect a
      user would notice.
- [ ] Comments explain *why*, not what.

Delete any that do not apply:

- [ ] **New config key** — added to `DEFAULTS` in `pacs/config.py`, to
      `config.example.json`, and validated in `validate()`.
- [ ] **New config key with no dashboard form field** — carried through a
      `loadedX` snapshot in `pacs/web/app.js`, so a Settings Save does not
      silently reset it.
- [ ] **New user-visible string** — added to all four locales (`es`, `pt-BR`,
      `ja`, `ru`) in `pacs/web/i18n.js`, and `desktop/i18n.js` if it is in the
      Electron shell. Counted strings go in `PLURALS` with the right number of
      forms (1 for `ja`, 2 for `en`/`es`/`pt-BR`, 3 for `ru`) and use `TN()`.
      Protocol identifiers (AE, SCP, MWL, HL7, MLLP, C-FIND…) are deliberately
      left untranslated.
- [ ] **New background worker or thread** — `stop()` sets the event *and*
      joins the thread with a timeout, guarding `is_alive()` and
      `current_thread()`, so a restart cannot hit `EADDRINUSE`.
- [ ] **Dashboard CSS** — follows the three-class value policy (ATOMIC
      identifiers ellipsise and mirror into a `title`; `.path` is the only place
      mid-token breaking is allowed; everything else wraps at spaces). No
      `word-break: break-all`, and no `overflow-wrap: anywhere` outside `.path`.
- [ ] **New runtime dependency** — justified in the linked issue, and checked to
      survive a PyInstaller freeze on all three operating systems.
- [ ] **Touches auth, config validation, the `X-Carino` write guard, or
      `safe_within()`** — described below, because those carry a security
      contract that is not obvious from a single function.

## Security notes

<!-- Only if the last box applies. In particular: nothing here makes it easier
     to run an unauthenticated PACS reachable from a network, and an empty
     web.auth_token is still refused for any non-loopback web.host.

     Found a vulnerability? Do not disclose it here — see SECURITY.md. -->

## Anything the reviewer should know

<!-- Trade-offs you made, parts you are unsure about, follow-up work you left
     out on purpose. Saying "I could not test the Windows path" is far better
     than leaving it to be discovered. -->
