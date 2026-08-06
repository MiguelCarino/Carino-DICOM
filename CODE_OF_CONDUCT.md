# Code of Conduct

This is a small project run by one person, and the people who show up here are
mostly radiographers, medical physicists, hospital IT staff and imaging
engineers trying to solve a real problem at work. The point of this document is
to make that a pleasant place to be, and to say in advance what happens if it
is not.

## What is expected

- **Assume the other person is competent and busy.** Somebody asking a question
  that seems basic is usually an expert in something else — a technologist who
  runs a CT suite every day may have never touched a virtualenv, and that is
  fine in both directions.
- **Be specific rather than sharp.** "This drops studies when the destination is
  down, here is the trace" is useful. "This is broken" with no detail is not,
  and neither is contempt for the code or the person who wrote it.
- **Accept that the answer is sometimes no.** Scope decisions on this project
  are deliberate and are written down in `CONTRIBUTING.md`. A declined feature
  is a decision about the project, not a judgement about you.
- **Give people time.** There is one maintainer, working on this outside a day
  job. A slow reply is not a snub.
- **Credit people's work**, including work you are replacing.

## What is not acceptable

- Harassment, insults, or demeaning comments — including about someone's
  nationality, ethnicity, religion, sex, gender identity or expression, sexual
  orientation, disability, age, body size, appearance, level of experience, or
  the language they speak or the standard of their English. This project has a
  four-language interface and international users; contributors writing in a
  second or third language are to be met halfway, not corrected with disdain.
- Sexualised language or imagery, and unwelcome sexual attention of any kind.
- Publishing anyone's private information — address, employer, workplace,
  personal contact details — without their explicit permission.
- Sustained disruption: brigading a thread, reopening a settled decision to
  wear people down, or persistent off-topic argument.
- Deliberately introducing insecure or unsafe code, or misrepresenting what a
  change does. Given what this software moves, that is treated as one of the
  most serious things on this list.

## Patient data

One rule specific to this project, and it is absolute:

**Never post patient data.** Not in an issue, not in a pull request, not in a
log excerpt, not in a screenshot, not in an attached DICOM file, not in an HL7
message. Redact patient names, identifiers, accession numbers, dates of birth,
institution names and referring physicians before you paste anything, and check
screenshots for a visible worklist or study list before you attach them.

If you need a sample object to demonstrate a bug, synthesise one — the test
suite shows how to build DICOM instances with pydicom — or describe the tag
structure in words.

Posting patient data is not treated as a discipline problem in the first
instance; it is treated as an incident. The content will be removed as fast as
it can be, and you will be asked to check whether your institution has a
notification obligation. Doing it deliberately, or repeatedly after being asked
not to, is grounds for a permanent ban.

## Scope

This applies in every project space — issues, pull requests, discussions, commit
messages, code comments — and when someone is representing the project
elsewhere.

## Reporting

Report a problem to **miguel.carino1994@outlook.com**. If the report is about
the maintainer, GitHub's own abuse reporting is the right channel, and using it
will not be held against you here.

Reports are read by one person and kept confidential. You will get an
acknowledgement within about a week; if you have not, send a reminder rather
than assuming you were ignored.

## What happens next

There is no committee and no appeals board — there is one maintainer, who will
try to be proportionate and will say what they decided and why. Depending on
what happened, that means:

1. **A private word.** For a comment that landed badly and can be fixed by an
   edit and moving on.
2. **A public correction**, with the offending content edited or removed.
3. **A temporary ban** from interacting with the project.
4. **A permanent ban**, for sustained harassment, or for deliberate harm.

Severity is judged on effect rather than intent. "I did not mean it that way" is
worth saying, and it changes what happens next, but it does not undo the effect
on the person who received it.
