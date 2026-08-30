"""De-identification applied on forward — DICOM PS3.15 Annex E.

The gateway stores what it receives, untouched. When a routing rule (or the
global ``deid`` config) asks for it, the copy that *leaves* is de-identified;
the archived original is never rewritten. That asymmetry is the whole point of
this module and it is why the only entry point is
:meth:`Deidentifier.deidentified_copy`, which returns a new ``Dataset``.

Profiles
--------
``off``     nothing happens; ``from_config`` returns ``None`` so the caller
            never installs a transform at all.
``basic``   PS3.15 Basic Application Level Confidentiality Profile (code
            113100) *plus* these standard Retain options, each declared in
            (0012,0064) so a recipient can see exactly what was kept:
              113106/113107  Retain Longitudinal Temporal Information —
                             Full Dates when ``keep_dates`` is true, Modified
                             Dates when it is false (we shift, never blank).
                             The shift is a whole number of days, so every
                             interval in the study survives to the second and
                             clock times land on themselves — see "Why the
                             offset is whole days" beside ``_MAX_SHIFT_DAYS``.
                             That the clock did not move is stated in
                             (0012,0063) rather than left for the recipient to
                             assume; see "Does 113107 still hold" there.
              113108         Retain Patient Characteristics (a reduced form:
                             sex, age, size, weight, pregnancy, smoking).
              113109         Retain Device Identity.
              113112         Retain Institution Identity.
``strict``  the same Basic Profile with the device- and institution-identity
            options dropped, and private attributes removed even if
            ``keep_private`` asks to keep them. Temporal and patient
            characteristics survive, because a study with no dates and no sex
            is not research data, it is noise.

``keep_private`` forwards private attributes unvetted, which the Basic Profile
forbids, so an object produced with it carries neither 113100 nor
PatientIdentityRemoved=YES. The coded evidence has to be a true statement about
what was done; a study claiming a profile it did not receive is worse than one
claiming nothing.

What this does NOT do
---------------------
It does not touch pixels. Burned-in patient demographics — the banner an
ultrasound or a secondary capture prints into the image itself — survive every
profile here untouched, and they are the single most common way "anonymised"
data walks out the door with a name on it. The Clean Pixel Data option
(113101) is deliberately not claimed. Nothing downstream of this module can
detect that leak for you; a human has to look at the images.

It also cannot clean free text. Study/series descriptions, protocol names and
comments are removed rather than retained, because a request to "please repeat,
patient is Mrs X from ward 4" is a perfectly ordinary thing to find in a
ProtocolName. That costs the recipient some usability and it is the right
trade.

Structured Reports are a third gap: SR content is walked and profiled like any
other sequence, but narrative text inside a report is not read for identifiers.
Do not forward SR objects to an untrusted recipient on the strength of this
module alone.

Determinism
-----------
Every generated value comes from HMAC-SHA256 over a site key, so there is no
lookup table to keep, back up or lose: restart the service, reinstall the
machine, and the same PatientID still maps to the same pseudonym and the same
StudyInstanceUID still maps to the same remapped UID. Re-sending a study is
therefore idempotent — the recipient overwrites the instance it already has
instead of growing a duplicate study.

The site key comes from the optional ``deid.secret`` config value. With no
secret the mapping is a pure function of the input, which means anyone who can
guess a PatientID can confirm it is present in your anonymised set. Set a
secret for anything leaving the building. Changing it later re-pseudonymises
everything, so previously exported studies will no longer line up.

Consistency with the bundled editor
-----------------------------------
The action table below is generated from ``pacs/web/editor/deid-profile.js``,
the same PS3.15 Table E.1-1 the browser tool's Anonymize button uses, so the
two agree on which attributes are identifying. ``tests/test_deid.py`` re-parses
that JS file and fails if the two ever drift. Where behaviour differs it is
deliberate and listed in the comment above the action table below.
"""

from __future__ import annotations

import copy
import datetime
import hashlib
import hmac
import json
import os
import tempfile
import threading
from contextlib import contextmanager
from typing import Iterator, Optional

from pydicom import dcmread
from pydicom.dataset import Dataset

PROFILES = ("off", "basic", "strict")

# Where the browser tool's copy of the same table lives. Only the test reads
# it; the runtime table is embedded below so a packaged build cannot end up
# de-identifying less than it thinks because a web asset was left out.
PROFILE_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "web", "editor", "deid-profile.js")

# Deliberate differences from pacs/web/editor (index.html anonymize()):
#   * the editor invents a random culture-appropriate fake name and a random
#     2.25 UID per run; we derive both from a keyed hash so two sends of the
#     same study match. A gateway that randomised would multiply one study into
#     a new study on every retry.
#   * the editor blanks dates (its dummyFor() never fabricates temporal data);
#     we shift them, because blanked dates destroy the follow-up intervals that
#     make a research export worth exporting.
#   * the editor applies no Retain options at all, so its output is closest to
#     our ``strict``. Our ``basic`` deliberately keeps device, institution and
#     patient-characteristic attributes.
#   * the editor sets PatientAge to 000Y; we keep the real age, capped at 089Y.

# ---------------------------------------------------------------------------
# PS3.15 Table E.1-1, Basic Profile column. GENERATED — do not hand-edit; run
# the generator against pacs/web/editor/deid-profile.js and paste the result.
# Action codes: X remove, Z zero-length, D dummy, U remapped UID,
# X/Z, X/D, Z/D, X/Z/D "any of", X/Z/U* keep and recurse.
#
# 656 rows: the 652 single-tag rows of Table E.1-1 (2026c) plus four we add.
# The four repeating-group/private rows the standard states as patterns
# ((50xx,xxxx), (60xx,3000), (60xx,4000), odd groups) are handled in code
# because a flat tag->action map cannot express them. What we add:
#   (0002,0013) ImplementationVersionName — group 2 is outside E.1-1 entirely,
#               and the value names the software that wrote the object.
#   (0010,0033) PatientBirthDateInAlternativeCalendar
#   (0010,0034) PatientDeathDateInAlternativeCalendar
#   (0010,0035) PatientAlternativeCalendar
# The three alternative-calendar attributes are a genuine hole in E.1-1 as
# published: they are LO/CS, not DA, so nothing that keys off the VR sees them
# either, and a real date of birth walks out in full. We remove them.
# ---------------------------------------------------------------------------
_TABLE = """
00001000:X 00001001:U 00020003:U 00020013:D 00041511:U 00080012:X/D 00080013:X/Z/D
00080014:U 00080015:X 00080017:U 00080018:U 00080019:U 00080020:Z 00080021:X/D 00080022:X/Z
00080023:Z/D 00080024:X 00080025:X 0008002A:X/Z/D 00080030:Z 00080031:X/D 00080032:X/Z
00080033:Z/D 00080034:X 00080035:X 00080050:Z 00080054:X 00080055:X 00080058:U
00080080:X/Z/D 00080081:X 00080082:X/Z/D 00080090:Z 00080092:X 00080094:X 00080096:X
0008009C:Z 0008009D:X 00080106:D 00080107:D 00080201:X 00081000:X 00081010:X/Z/D 00081030:X
0008103E:X 00081040:X 00081041:X 00081048:X 00081049:X 00081050:X 00081052:X 00081060:X
00081062:X 00081070:X/Z/D 00081072:X/D 00081080:X 00081084:X 00081088:X 00081110:X/Z
00081111:X/Z/D 00081120:X 00081140:X/Z/U* 00081155:U 00081195:U 00081301:X 00081302:X
00081303:X 00081304:X 00082111:X 00082112:X/Z/U* 00083010:U 00084000:X 00100010:Z 00100011:X
00100012:X 00100013:X 00100014:X 00100015:X 00100016:X 00100020:Z/D 00100021:X 00100030:Z
00100032:X 00100033:X 00100034:X 00100035:X 00100040:Z 00100041:X 00100042:X 00100043:X
00100044:X 00100045:X 00100046:X 00100047:X 00100050:X 00100101:X 00100102:X 00101000:X
00101001:X 00101002:X 00101005:X 00101010:X 00101020:X 00101030:X 00101040:X 00101050:X
00101060:X 00101080:X 00101081:X 00101090:X 00101100:X 00102000:X 00102110:X 00102150:X
00102152:X 00102154:X 00102155:X 00102160:X 00102161:X 00102162:X 00102180:X 001021A0:X
001021B0:X 001021C0:X 001021D0:X 001021F0:X 00102203:X/Z 00102297:X 00102299:X 00104000:X
00120010:D 00120020:D 00120021:Z 00120022:X 00120023:X 00120030:Z 00120031:Z 00120032:X
00120040:D 00120041:X 00120042:D 00120043:X 00120050:Z 00120051:X 00120055:X 00120060:Z
00120071:X 00120072:X 00120073:X 00120081:D 00120082:X 00120086:X 00120087:X 0014407C:X
0014407E:X 0016002B:X 0016004B:X 0016004D:X 0016004E:X 0016004F:X 00160050:X 00160051:X
00160070:X 00160071:X 00160072:X 00160073:X 00160074:X 00160075:X 00160076:X 00160077:X
00160078:X 00160079:X 0016007A:X 0016007B:X 0016007C:X 0016007D:X 0016007E:X 0016007F:X
00160080:X 00160081:X 00160082:X 00160083:X 00160084:X 00160085:X 00160086:X 00160087:X
00160088:X 00160089:X 0016008A:X 0016008B:X 0016008C:X 0016008D:X 0016008E:X 00180010:Z/D
00180027:X 00180035:X 00181000:X/Z/D 00181002:U 00181004:X 00181005:X 00181007:X 00181008:X
00181009:X 0018100A:X 0018100B:U 00181010:X 00181011:X 00181012:X 00181014:X 00181030:X/D
00181042:X 00181043:X 00181072:X 00181073:X 00181078:X 00181079:X 001811BB:D 00181200:X
00181201:X 00181202:X 00181203:Z 00181204:X 00181205:X 00181400:X/D 00182042:U 00184000:X
00185011:X 0018700A:X/D 0018700C:X/D 0018700E:X/D 00189074:D 00189151:D 00189185:X
00189367:D 00189369:D 0018936A:D 00189371:D 00189373:X 0018937B:X 0018937F:X 00189424:X
00189516:X/D 00189517:X/D 00189623:D 00189701:D 00189804:D 00189919:Z/D 00189937:X
0018A002:X 0018A003:X 0020000D:U 0020000E:U 00200010:Z 00200027:X 00200052:U 00200200:U
00203401:X 00203403:X 00203405:X 00203406:X 00204000:X 00209158:X 00209161:U 00209164:U
00281199:U 00281214:U 00284000:X 00320012:X 00320032:X 00320033:X 00320034:X 00320035:X
00321000:X 00321001:X 00321010:X 00321011:X 00321020:X 00321021:X 00321030:X 00321032:X
00321033:X 00321040:X 00321041:X 00321050:X 00321051:X 00321060:X/Z 00321066:X 00321067:X
00321070:X 00324000:X 00340001:D 00340002:D 00340005:D 00340007:D 00380004:X 00380010:X
00380011:X 00380014:X 0038001A:X 0038001B:X 0038001C:X 0038001D:X 0038001E:X 00380020:X
00380021:X 00380030:X 00380032:X 00380040:X 00380050:X 00380060:X 00380061:X 00380062:X
00380064:X 00380300:X 00380400:X 00380500:X 00384000:X 003A0020:X 003A0203:X 003A020C:X
003A0310:U 003A0314:D 003A0329:X 003A032B:X 00400001:X 00400002:X 00400003:X 00400004:X
00400005:X 00400006:X 00400007:X 00400009:X 0040000B:X 00400010:X 00400011:X 00400012:X
00400241:X 00400242:X 00400243:X 00400244:X 00400245:X 00400250:X 00400251:X 00400253:X
00400254:X 00400275:X 00400280:X 00400310:X 0040050A:X 00400512:D 00400513:Z 0040051A:X
00400551:D 00400554:U 00400555:X/Z 00400556:X 00400562:Z 00400600:X 00400602:X 00400610:Z
004006FA:X 00401001:X 00401002:X 00401004:X 00401005:X 0040100A:X 00401010:X 00401011:X
00401101:D 00401102:X 00401103:X 00401104:X 00401400:X 00402001:X 00402004:X 00402005:X
00402008:X 00402009:X 00402010:X 00402011:X 00402016:Z 00402017:Z 00402400:X 00403001:X
00404005:X 00404008:X 00404010:X 00404011:X 00404023:U 00404025:X 00404027:X 00404028:X
00404030:X 00404034:X 00404035:X 00404036:X 00404037:X 00404050:X 00404051:X 00404052:X
0040A023:X 0040A024:X 0040A027:D 0040A030:D 0040A032:X/D 0040A033:X 0040A034:X 0040A035:X
0040A073:D 0040A075:D 0040A078:X 0040A07A:X 0040A07C:X 0040A082:Z 0040A088:Z 0040A110:X
0040A112:X 0040A120:D 0040A121:D 0040A122:D 0040A123:D 0040A124:U 0040A13A:D 0040A171:U
0040A172:U 0040A192:X 0040A193:X 0040A307:X 0040A352:X 0040A353:X 0040A354:X 0040A358:X
0040A402:U 0040A730:D 0040B020:X/D 0040B034:X 0040B036:X 0040B03B:X 0040B03F:X 0040DB06:X
0040DB07:X 0040DB0C:U 0040DB0D:U 0040E004:X 0040E012:X 00420011:D 00440004:X 0044000B:X
00440010:X 00440104:D 00440105:X 0050001B:X 00500020:X 00500021:X 00620021:U 00640003:U
00686226:D 00686270:D 006A0003:D 006A0005:D 006A0006:X 00700001:D 00700006:D 00700082:X
00700083:X 00700084:Z/D 00700086:X 0070031A:U 00701101:U 00701102:U 0072000A:D 0072005E:D
0072005F:D 00720061:D 00720063:D 00720065:D 00720066:D 00720068:D 0072006A:D 0072006B:D
0072006C:D 0072006D:D 0072006E:D 00720070:D 00720071:D 00741234:X 00741236:X 00880140:U
00880200:X 00880904:X 00880906:X 00880910:X 00880912:X 01000420:X 04000100:U 04000105:D
04000115:D 04000310:X 04000402:X 04000403:X 04000404:X 04000550:X 04000551:X 04000552:X
04000561:X 04000562:D 04000563:D 04000564:Z 04000565:D 04000600:X 20300020:X 21000040:X
21000050:X 21000070:X 21000140:D 22000002:X/Z 22000005:X/Z 30020121:X 30020123:X 30060002:D
30060004:X 30060006:X 30060008:Z 30060009:Z 30060024:U 30060026:Z 30060028:X 3006002D:X
3006002E:X 30060038:X 3006004D:X 3006004E:X 30060085:X 30060088:X 300600A6:Z 300600C2:U
30080024:D 30080025:D 30080054:X/D 30080056:X/D 30080105:X/Z 30080162:D 30080164:D
30080166:D 30080168:D 30080250:X/D 30080251:X/D 300A0002:D 300A0003:X 300A0004:X
300A0006:X/D 300A0007:X/D 300A000B:X 300A000E:X 300A0013:U 300A0016:X 300A0054:U 300A0072:X
300A0083:U 300A00B2:X/Z 300A00C3:X 300A00DD:X 300A0196:X 300A01A6:X 300A01B2:X 300A0216:X
300A022C:D 300A022E:D 300A02EB:X 300A0608:D 300A0609:U 300A0611:Z 300A0615:Z 300A0619:D
300A0623:D 300A062A:D 300A0650:U 300A0676:X 300A067C:D 300A067D:Z 300A0700:U 300A0734:D
300A0736:D 300A073A:D 300A0741:D 300A0742:D 300A0760:D 300A0783:D 300A0785:U 300A078E:X
300A0792:X 300A0794:X 300A079A:X 300C0113:X 300C0127:D 300E0004:Z 300E0005:Z 300E0008:X/Z
30100006:U 3010000B:U 3010000F:Z 30100013:U 30100015:U 30100017:Z 3010001B:Z 3010002D:D
30100031:U 30100033:D 30100034:D 30100035:D 30100036:X 30100037:X 30100038:D 3010003B:U
30100043:Z 3010004C:X/D 3010004D:X/D 30100054:D 30100056:X/D 3010005A:Z 3010005C:Z
30100061:X 3010006E:U 3010006F:U 30100077:X/D 3010007A:Z 3010007B:Z 3010007F:Z 30100081:Z
30100085:X 40000010:X 40004000:X 40080040:X 40080042:X 40080100:X 40080101:X 40080102:X
40080108:X 40080109:X 4008010A:X 4008010B:X 4008010C:X 40080111:X 40080112:X 40080113:X
40080114:X 40080115:X 40080118:X 40080119:X 4008011A:X 40080200:X 40080202:X 40080300:X
40084000:X FFFAFFFA:X FFFCFFFC:X
"""


def _parse_table(blob: str) -> dict:
    out = {}
    for pair in blob.split():
        tag, _, action = pair.partition(":")
        out[int(tag, 16)] = action
    return out


_ACTIONS = _parse_table(_TABLE)

# Tags the UID pass is allowed to rewrite: exactly those Table E.1-1 marks U
# (plus X/Z/U*, which are the sequences kept so their nested U tags stay
# reachable). Driving this off the table rather than off VR UI matters because
# a UI element is not automatically an instance identifier — (0008,010C)
# CodingSchemeUID and (0008,0118) MappingResourceUID name SNOMED, LOINC and
# friends, and a recipient handed a fresh 2.25 value in their place can no
# longer resolve a single coded concept in the object.
#
# Table E.1-1 marks the main instance and frame-of-reference UIDs U but misses
# members of both families, and a frame-of-reference UID that does not move
# with (0020,0052) both hands over the site's OID tree and stops matching the
# geometry it belongs to. These are instance identifiers this site generated,
# never registry or scheme identifiers, so they are safe to remap and unsafe to
# leave. (0008,010C)/(0008,010D)/(0008,0117)/(0008,0118) are deliberately not
# here: those name SNOMED, LOINC and their context groups.
_EXTRA_UID_TAGS = frozenset({
    0x00041432,  # PrivateRecordUID
    0x00081167,  # MultiframeSourceSOPInstanceUID
    0x00083012,  # RadiopharmaceuticalAdministrationEventUID
    0x0018991E,  # TargetFrameOfReferenceUID
    0x00200242,  # SOPInstanceUIDOfConcatenationSource
    0x00209312,  # VolumeFrameOfReferenceUID
    0x00209313,  # TableFrameOfReferenceUID
    0x00280304,  # ReferencedColorPaletteInstanceUID
    0x0040A021,  # FindingsGroupUIDTrial
    0x0040A022,  # ReferencedFindingsGroupUIDTrial
    0x00440102,  # AssertionUID
    0x00440108,  # ReferencedAssertionUID
    0x0070031B,  # ReferencedFiducialUID
    0x00701209,  # VolumetricPresentationInputSetUID
    0x300A0675,  # EquipmentFrameOfReferenceUID
})
_UID_TAGS = frozenset(tag for tag, action in _ACTIONS.items()
                      if "U" in action) | _EXTRA_UID_TAGS

# Attributes exempted by the Retain options. UID-valued device attributes
# ((0018,1002) Device UID, (0018,100B) Manufacturer Device Class UID) are
# intentionally absent: the UID pass remaps every non-standard UID anyway, and
# a remapped device UID still identifies the device consistently without
# handing over the site's real UID tree.
_DEVICE_IDENTITY = frozenset({
    0x00081010,  # StationName
    0x00181000,  # DeviceSerialNumber
    0x00181004,  # PlateID
    0x00181005,  # GeneratorID
    0x00181007,  # CassetteID
    0x00181008,  # GantryID
    0x00181009,  # UniqueDeviceIdentifier
    0x0018100A,  # UDISequence
    0x0018700A,  # DetectorID
    0x30100043,  # ManufacturerDeviceIdentifier
})
_INSTITUTION_IDENTITY = frozenset({
    0x00080080,  # InstitutionName
    0x00080081,  # InstitutionAddress
    0x00080082,  # InstitutionCodeSequence
    0x00081040,  # InstitutionalDepartmentName
    0x00081041,  # InstitutionalDepartmentTypeCodeSequence
})
# A reduced form of the Retain Patient Characteristics option: retaining less
# than the option allows is still conformant, and ethnic group, allergies and
# patient history are either free text or too identifying to hand over.
_PATIENT_CHARACTERISTICS = frozenset({
    0x00100040,  # PatientSex
    0x00101010,  # PatientAge
    0x00101020,  # PatientSize
    0x00101030,  # PatientWeight
    0x001021A0,  # SmokingStatus
    0x001021C0,  # PregnancyStatus
})
# Exactly the attributes Table E.1-1 marks under "Rtn. Long. Full Dates Opt."
# or "Rtn. Long. Modif. Dates Opt." — study/series/acquisition timing and the
# scheduling, calibration and treatment stamps that travel with it. Anything
# else with a DA/DT/TM value is NOT covered by either temporal option and takes
# its Basic Profile action, so an allowlist is the only safe shape here: keying
# off the VR retained (0016,0077) GPS Time Stamp, which pins an acquisition to
# a second and a place at once.
_TEMPORAL_RETAIN = frozenset(int(t, 16) for t in """
00080012 00080013 00080015 00080020 00080021 00080022 00080023 00080024
00080025 0008002A 00080030 00080031 00080032 00080033 00080034 00080035
00080106 00080107 00080201 001021D0 00120086 00120087 0014407C 0014407E
0016008D 00180027 00180035 00181012 00181014 00181042 00181043 00181072
00181073 00181078 00181079 00181200 00181201 00181202 00181203 00181204
00181205 0018700C 0018700E 00189074 00189151 00189369 0018936A 00189516
00189517 00189623 00189701 00189804 00189919 0018A002 00203403 00203405
00320032 00320033 00320034 00320035 00321000 00321001 00321010 00321011
00321040 00321041 00321050 00321051 00340007 0038001A 0038001B 0038001C
0038001D 00380020 00380021 00380030 00380032 003A0314 00400002 00400003
00400004 00400005 00400244 00400245 00400250 00400251 00402004 00402005
00404005 00404008 00404010 00404011 00404050 00404051 00404052 0040A023
0040A024 0040A030 0040A032 0040A033 0040A034 0040A035 0040A082 0040A110
0040A112 0040A120 0040A121 0040A122 0040A13A 0040A192 0040A193 0040B034
0040B036 0040DB06 0040DB07 0040E004 00440004 0044000B 00440010 00440104
00440105 00686226 00686270 00700082 00700083 0072000A 00720061 00720063
0072006B 01000420 04000105 04000310 04000562 21000040 21000050 30060008
30060009 3006002D 3006002E 30080024 30080025 30080054 30080056 30080162
30080164 30080166 30080168 30080250 30080251 300A0006 300A0007 300A022C
300A022E 300A0736 300A073A 300A0741 300A0760 300C0127 300E0004 300E0005
3010004C 3010004D 30100085 40080100 40080101 40080108 40080109 40080112
40080113
""".split())
# ...and never these, whatever the table says. Date of birth is patient
# identity, not longitudinal information. The alternative-calendar pair carries
# the same birth and death dates in LO/CS, where nothing keyed on a temporal VR
# would ever look for them.
_TEMPORAL_EXCLUDE = frozenset({
    0x00100030,  # PatientBirthDate
    0x00100032,  # PatientBirthTime
    0x00100033,  # PatientBirthDateInAlternativeCalendar
    0x00100034,  # PatientDeathDateInAlternativeCalendar
    0x00100035,  # PatientAlternativeCalendar
})

_PATIENT_ID = 0x00100020
_PATIENT_NAME = 0x00100010
_SOURCE_AE = 0x00020016  # SourceApplicationEntityTitle, in file meta
# Group 2 is not covered by Table E.1-1 and is not reached by the recursive
# passes (file meta is a separate dataset), so these two are handled by hand.
# Private Information is an opaque vendor blob living in the Part-10 header —
# exactly the sort of place a patient name goes to hide.
_META_PRIVATE = (0x00020100, 0x00020102)

# UIDs under the DICOM root are SOP classes, transfer syntaxes and coding
# schemes — file *type*, not patient data. Remapping them corrupts the object.
_STANDARD_ROOT = "1.2.840.10008"
# 2.25.<128-bit UUID as decimal> is the registered UUID-derived branch; no
# registration or site OID is needed, and the value fits UI's 64 bytes.
_UID_PREFIX = "2.25."

# Ten years of jitter is enough to defeat "which Tuesday was this scanned on"
# without pushing plausible acquisition dates outside the digital era.
_MAX_SHIFT_DAYS = 3650

# Why the offset is whole days, and the clock never moves
# ------------------------------------------------------
# 113107 Modified Dates is a promise that the temporal *relationships* in the
# object survive the shift: subtract any two temporal values after, get the
# same answer as before. That promise is the whole reason a research recipient
# is allowed to keep dates at all, and it is the one thing this code must not
# break. A whole-day offset keeps it unconditionally — every DA, every DT and
# every TM lands exactly N*86400 s from where it started, so no interval can
# move, in the day, across the day, or across the study.
#
# The tempting alternative — also shift the clock by a per-patient number of
# seconds, to hide the fact that this patient is always scanned at 14:32 —
# cannot be made to hold that promise, and all three ways of trying fail:
#   * shift the time and wrap it at midnight: the value silently jumps 24 h
#     relative to everything it is meant to be compared with. This is what the
#     code used to do, and it inverted a 30-minute study/series interval into
#     -23.5 h for roughly a quarter of patients.
#   * shift the time and carry into the date: a DT and a DA/TM pair can carry,
#     but a bare DA has no clock beside it to carry from. One ContentDate with
#     no ContentTime then lands a day away from the StudyDate+StudyTime it was
#     recorded with, and the object contradicts itself.
#   * shift DA/TM pairs as a unit and leave bare TM alone: same hole, plus the
#     shift now depends on which optional attributes a modality happened to
#     send, which is not something a recipient can reason about.
# So the clock stays. The cost is real and is stated here rather than hidden:
# an exact acquisition time survives de-identification, and a department
# schedule plus 14:32:07 is a linkage key — but only against a known date, and
# the date is what we moved, by up to ten years, per patient. Trading a certain
# corruption of the data for a conditional weakening of the pseudonymity is the
# right way round. If a recipient must not see clock times at all, the honest
# answer is to blank every TM and the time half of every DT — losing the
# within-day intervals outright and saying so — never to reintroduce a sub-day
# offset that claims to preserve what it destroys.
#
# Does 113107 still hold when no TM changes?
# -----------------------------------------
# E.3.6 says "any dates and times present in the Attributes listed in Table
# E.1-1 shall be modified", and in the same breath requires the modification to
# preserve "the fine temporal relationships between images and real-world
# events". Those two cannot both be met literally: a transform that changes
# every clock time and preserves every difference between clock times is a
# rotation of a 24-hour circle, and a rotation wraps — the wrap is precisely the
# bug catalogued above. So one of the two has to give, and it is not the one
# that says the data must still be usable: the option exists so a recipient can
# do longitudinal and kinetic analysis (PET decay correction reads
# RadiopharmaceuticalStartTime against SeriesTime to the second), and a version
# of it that corrupts those intervals is not a weaker option, it is a different
# and useless one.
#
# What we do satisfies E.3.6's three stated goals as written: the dates are
# aggregated away from anything matchable, the gross relationships across dates
# survive, the fine ones survive. Read as moments rather than as digits, every
# date-and-time in the object HAS been modified — each one moved by N*86400 s.
# The component that did not move is the time of day, and the honest response to
# that is not to drop the code (113107 names the option we implemented, in the
# form every date-shifting de-identifier implements it), nor to keep it silently
# — it is to say in the object which component moved. E.3.6 asks for the manner
# of modification to be described anyway; _stamp_evidence writes it into
# DeidentificationMethod (0012,0063), where a recipient will actually see it.

# HIPAA Safe Harbor treats an age over 89 as an identifier in its own right.
# The cap deliberately understates: a recipient reading 089Y must not assume it
# is exact. Removing the attribute outright would lose more than it protects.
_AGE_CAP_YEARS = 89

# PS3.16 CID 7050 de-identification method codes.
_CODE_BASIC = ("113100", "Basic Application Confidentiality Profile")
_CODE_FULL_DATES = ("113106", "Retain Longitudinal Temporal Information Full Dates Option")
_CODE_MOD_DATES = ("113107", "Retain Longitudinal Temporal Information Modified Dates Option")
_CODE_PATIENT_CHARS = ("113108", "Retain Patient Characteristics Option")
_CODE_DEVICE = ("113109", "Retain Device Identity Option")
_CODE_INSTITUTION = ("113112", "Retain Institution Identity Option")

# VRs that cannot carry a meaningful dummy: numeric, binary, and anything
# temporal (fabricating a date is worse than an empty one).
_EMPTY_DUMMY_VRS = frozenset({
    "AS", "AT", "DA", "DS", "DT", "FD", "FL", "IS", "OB", "OD", "OF", "OL",
    "OV", "OW", "SL", "SS", "SV", "TM", "UI", "UL", "UN", "US", "UV",
})

# Secondary Capture and Ultrasound routinely print demographics into the
# raster and just as routinely forget to declare BurnedInAnnotation.
_PIXEL_RISK_SOP_PREFIXES = (
    "1.2.840.10008.5.1.4.1.1.7",    # Secondary Capture family
    "1.2.840.10008.5.1.4.1.1.3.1",  # Ultrasound Multi-frame
    "1.2.840.10008.5.1.4.1.1.6",    # Ultrasound
)

_WARN_CAP = 1024  # bounded dedupe set; the log ring only holds 500 entries


class DeidError(Exception):
    """De-identification could not be completed for this instance.

    Raised rather than returning a half-scrubbed dataset. Callers must treat it
    as a send failure so the file stays on disk, retries with backoff and stays
    visible — never as a reason to skip the file.
    """


def _vr(elem) -> str:
    return str(elem.VR)


def _shift_ymd(value: str, days: int) -> Optional[str]:
    """Shift a YYYY / YYYYMM / YYYYMMDD string, preserving its precision.

    Returns None when the value is not a date we can move, which the caller
    turns into a blank. Leaving an unparseable-but-real date unshifted would be
    the one thing worse than losing it.
    """
    v = value.strip()
    if len(v) == 4 and v.isdigit():
        base, prec = v + "0101", 4
    elif len(v) == 6 and v.isdigit():
        base, prec = v + "01", 6
    elif len(v) >= 8 and v[:8].isdigit():
        base, prec = v[:8], 8
    else:
        return None
    try:
        d = datetime.date(int(base[:4]), int(base[4:6]), int(base[6:8]))
        d += datetime.timedelta(days=days)
    except (ValueError, OverflowError):
        return None
    return ("%04d%02d%02d" % (d.year, d.month, d.day))[:prec]


def _split_dt(value: str):
    """Split a DT into its value and its trailing &ZZXX timezone suffix."""
    for i, ch in enumerate(value):
        if ch in "+-" and i > 0:
            return value[:i], value[i:]
    return value, ""


def _shift_da(value: str, days: int) -> Optional[str]:
    return _shift_ymd(value, days)


def _shift_dt(value: str, days: int) -> Optional[str]:
    """Shift a DT by whole days, keeping its clock time and its timezone.

    The date is the only thing that moves, and it moves through a real
    ``datetime`` so the day count carries the way a calendar does — leap days,
    month ends and, if a sub-day component is ever added above, midnight. Doing
    the two halves independently is what used to lose a day here.

    The timezone offset is a local-time modifier, not data about the patient,
    and rewriting it would silently move every value in the object relative to
    UTC, so it is re-attached exactly as it arrived.
    """
    body, tz = _split_dt(value.strip())
    digits, dot, frac = body.partition(".")
    if not digits.isdigit():
        return None
    if len(digits) < 8:
        # A fraction with no seconds in front of it is malformed, not a date.
        head = None if dot else _shift_ymd(digits, days)
        return None if head is None else head + tz
    if len(digits) not in (8, 10, 12, 14) or (dot and len(digits) != 14):
        return None
    if dot and not (frac.isdigit() or frac == ""):
        return None
    h = int(digits[8:10]) if len(digits) >= 10 else 0
    m = int(digits[10:12]) if len(digits) >= 12 else 0
    s = int(digits[12:14]) if len(digits) >= 14 else 0
    if h > 23 or m > 59 or s > 60:
        return None
    try:
        # A leap second lands on :59 rather than being rejected — losing one
        # second of a real acquisition time beats blanking the attribute.
        moment = datetime.datetime(int(digits[:4]), int(digits[4:6]),
                                   int(digits[6:8]), h, m, min(s, 59))
        moment += datetime.timedelta(days=days)
    except (ValueError, OverflowError):
        return None
    out = "%04d%02d%02d%02d%02d%02d" % (moment.year, moment.month, moment.day,
                                        moment.hour, moment.minute, moment.second)
    return out[:len(digits)] + (dot + frac if dot else "") + tz


# TM is absent on purpose: the offset is whole days, so a bare clock time
# shifts onto itself and rewriting it could only lose precision. See "Why the
# offset is whole days" above. A TM we cannot parse therefore travels as it
# arrived rather than being blanked — it is being retained unmodified like
# every other TM, not forwarded unshifted.
_SHIFTERS = {"DA": _shift_da, "DT": _shift_dt}


def _cap_age(value: str) -> str:
    """Clamp an AS value to the HIPAA age ceiling; pass anything odd through."""
    v = str(value).strip().upper()
    if len(v) == 4 and v[:3].isdigit() and v[3] == "Y" and int(v[:3]) > _AGE_CAP_YEARS:
        return "%03dY" % _AGE_CAP_YEARS
    return v


def load_profile_table(path: str = PROFILE_JS) -> dict:
    """Parse the editor's deid-profile.js into {tag_int: action}.

    Only the drift test uses this. The runtime table is embedded so a packaged
    build never depends on a web asset being present.
    """
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    start = text.index("{", text.index("window.DEID_PROFILE"))
    end = text.index("}", start)
    return {int(k, 16): v for k, v in json.loads(text[start:end + 1]).items()}


def write_dataset(ds: Dataset, path: str) -> None:
    """Write a full Part-10 file (preamble + meta), across pydicom 2 and 3."""
    try:
        ds.save_as(path, enforce_file_format=True)   # pydicom >= 3
    except TypeError:
        ds.save_as(path, write_like_original=False)  # pydicom 2.x


class Deidentifier:
    """Applies one de-identification profile. Immutable, thread-safe, reusable.

    Build one per config generation and share it across sender threads. Every
    method is pure apart from a bounded warn-dedupe set.
    """

    def __init__(self, profile: str = "basic", keep_private: bool = False,
                 keep_dates: bool = False, prefix: str = "ANON",
                 secret: str = "", log=None):
        if profile not in PROFILES:
            raise ValueError("deid profile must be one of %s" % (PROFILES,))
        self.profile = profile
        self.keep_dates = bool(keep_dates)
        self.prefix = (prefix or "ANON").strip()
        self.log = log

        # strict means strict: retaining unvetted private attributes would undo
        # most of what strict adds over basic, so the flag loses here and we say
        # so rather than honouring it quietly.
        self.keep_private = bool(keep_private) and profile != "strict"
        self._private_overridden = bool(keep_private) and profile == "strict"

        # The salt keeps the pre-rename spelling on purpose: it is mixed into
        # every pseudonym, so changing it hands the same patient a second
        # identity and severs the longitudinal linkage the profile exists for.
        self._key = hashlib.sha256(b"carino-pacs/deid/v1\x00" + secret.encode("utf-8")).digest()
        self._lock = threading.Lock()
        self._warned: set = set()

        if self.enabled and self.keep_private:
            self._say("warn", "De-identification: keep_private is on — private attributes are "
                              "forwarded unvetted, which defeats the confidentiality profile. "
                              "Objects are marked PatientIdentityRemoved=NO.")
        if self._private_overridden:
            self._say("warn", "De-identification: keep_private ignored under the 'strict' profile "
                              "— private attributes are removed.")

    @classmethod
    def from_config(cls, cfg, log=None) -> Optional["Deidentifier"]:
        """Build from a Config (or a bare ``deid`` dict). None when profile=off.

        Returning None rather than a no-op object is what lets the sender skip
        installing a transform entirely, so an operator who turned this off
        pays nothing and cannot be surprised by a partially-applied profile.
        """
        d = getattr(cfg, "deid", cfg) or {}
        profile = d.get("profile", "basic")
        if profile == "off":
            return None
        return cls(profile=profile, keep_private=d.get("keep_private", False),
                   keep_dates=d.get("keep_dates", False), prefix=d.get("prefix", "ANON"),
                   secret=d.get("secret", ""), log=log)

    @property
    def enabled(self) -> bool:
        return self.profile != "off"

    # -- keyed derivations ---------------------------------------------------

    def _digest(self, kind: str, value: str) -> bytes:
        msg = ("%s\x00%s" % (kind, value)).encode("utf-8", "surrogatepass")
        return hmac.new(self._key, msg, hashlib.sha256).digest()

    def pseudo_id(self, identity: str) -> str:
        """Stable pseudonym for one patient identity. LO-safe (16 chars)."""
        return self.prefix + self._digest("pid", identity).hex()[:12].upper()

    def map_uid(self, uid: str) -> str:
        """Stable remap of one instance UID, or the UID itself if it is standard."""
        s = str(uid or "").strip()
        if not s or s.startswith(_STANDARD_ROOT):
            return s
        h = bytearray(self._digest("uid", s)[:16])
        # Shape the digest into a well-formed RFC 4122 v4 UUID before encoding
        # it, so the 2.25 value we emit is a legal member of that branch rather
        # than 128 arbitrary bits wearing its clothes.
        h[6] = (h[6] & 0x0F) | 0x40
        h[8] = (h[8] & 0x3F) | 0x80
        return _UID_PREFIX + str(int.from_bytes(bytes(h), "big"))

    def date_offset(self, identity: str) -> int:
        """Days to shift, always into the past, constant for one patient.

        The only offset there is. Whole days, so it moves the calendar and
        nothing else — see "Why the offset is whole days" above.
        """
        n = int.from_bytes(self._digest("date", identity)[:4], "big")
        return -(1 + n % _MAX_SHIFT_DAYS)

    def _identity(self, ds: Dataset) -> str:
        """The key everything else hangs off.

        PatientID first, but a blank PatientID must NOT collapse every such
        patient onto one pseudonym — that would merge unrelated people into a
        single anonymised patient, which is a clinical safety failure, not a
        privacy one. Fall back to the study, then the instance.
        """
        pid = str(ds.get("PatientID", "") or "").strip()
        if pid:
            return "pid:" + pid
        study = str(ds.get("StudyInstanceUID", "") or "").strip()
        if study:
            return "study:" + study
        return "sop:" + str(ds.get("SOPInstanceUID", "") or "")

    # -- logging -------------------------------------------------------------

    def _say(self, level: str, message: str) -> None:
        if self.log is None:
            return
        fn = getattr(self.log, level, None) or getattr(self.log, "info", None)
        if fn is not None:
            fn(message, kind="send")

    def _say_once(self, token: str, level: str, message: str) -> None:
        """One line per study, not per instance — a 400-slice CT would otherwise
        flush the entire 500-entry log ring on its own."""
        with self._lock:
            if token in self._warned:
                return
            if len(self._warned) >= _WARN_CAP:
                self._warned.clear()
            self._warned.add(token)
        self._say(level, message)

    # -- the profile pass ----------------------------------------------------

    def _retained(self, tag: int, vr: str) -> bool:
        if tag in _PATIENT_CHARACTERISTICS:
            return True
        if vr in ("DA", "DT", "TM") and tag in _TEMPORAL_RETAIN \
                and tag not in _TEMPORAL_EXCLUDE:
            return True  # governed by the temporal option, shifted later
        if self.profile == "basic" and (tag in _DEVICE_IDENTITY or tag in _INSTITUTION_IDENTITY):
            return True
        return False

    def _dummy_for(self, vr: str):
        if vr == "PN":
            return "ANON^ANON"
        if vr == "SQ":
            return []
        if vr in _EMPTY_DUMMY_VRS:
            return None
        return "ANONYMIZED"

    def _apply_profile(self, ds: Dataset) -> None:
        # list() because actions delete elements out from under the iterator.
        for elem in list(ds):
            tag = int(elem.tag)
            group = elem.tag.group
            # Repeating groups the flat table cannot express: retired Curve Data
            # and overlay planes, both of which have carried burned-in text and
            # scanned requisition forms for decades.
            if 0x5000 <= group <= 0x50FF:
                del ds[elem.tag]
                continue
            if 0x6000 <= group <= 0x60FF and elem.tag.element in (0x3000, 0x4000):
                del ds[elem.tag]
                continue

            vr = _vr(elem)
            action = None if self._retained(tag, vr) else _ACTIONS.get(tag)
            removed = False
            if action == "X":
                del ds[elem.tag]
                removed = True
            elif action in ("D", "X/D"):
                elem.value = self._dummy_for(vr)
            elif action in ("Z", "Z/D", "X/Z", "X/Z/D"):
                # Always the empty option, never the remove option: several of
                # these are Type 2, and dropping a Type 2 attribute produces an
                # object some receivers refuse outright.
                elem.value = [] if vr == "SQ" else None
            # "U" and "X/Z/U*" fall through untouched — _remap_uids handles the
            # first and the second exists purely so nested UIDs stay reachable.

            if not removed and _vr(elem) == "SQ" and elem.value is not None:
                for item in elem.value:
                    self._apply_profile(item)

    def _remap_uids(self, ds: Dataset) -> None:
        for elem in ds:
            if _vr(elem) == "SQ":
                for item in (elem.value or []):
                    self._remap_uids(item)
            elif int(elem.tag) in _UID_TAGS and _vr(elem) == "UI" \
                    and elem.value not in (None, ""):
                v = elem.value
                if isinstance(v, (list, tuple)) or type(v).__name__ == "MultiValue":
                    elem.value = [self.map_uid(x) for x in v]
                else:
                    elem.value = self.map_uid(v)

    def _shift_dates(self, ds: Dataset, days: int) -> int:
        """Shift every DA/DT in place. Returns how many values were blanked.

        TM is untouched: the offset is whole days, so there is nothing to do to
        a clock time.
        """
        lost = 0
        for elem in ds:
            vr = _vr(elem)
            if vr == "SQ":
                for item in (elem.value or []):
                    lost += self._shift_dates(item, days)
                continue
            fn = _SHIFTERS.get(vr)
            if fn is None or elem.value in (None, ""):
                continue
            v = elem.value
            if isinstance(v, (list, tuple)) or type(v).__name__ == "MultiValue":
                out = []
                for one in v:
                    s = fn(str(one), days)
                    if s is None:
                        lost += 1
                    else:
                        out.append(s)
                elem.value = out or None
            else:
                s = fn(str(v), days)
                if s is None:
                    lost += 1
                    elem.value = None
                else:
                    elem.value = s
        return lost

    def _check_pixels(self, ds: Dataset, token: str) -> None:
        burned = str(ds.get("BurnedInAnnotation", "") or "").strip().upper()
        sop = str(ds.get("SOPClassUID", "") or "")
        if burned == "YES":
            self._say_once(token + "|burned", "warn",
                           "De-identification: this study declares burned-in annotation. "
                           "Pixel data is NOT cleaned — identifiers printed into the image "
                           "are being forwarded.")
        elif not burned and sop.startswith(_PIXEL_RISK_SOP_PREFIXES):
            self._say_once(token + "|pixrisk", "warn",
                           "De-identification: secondary-capture/ultrasound object with no "
                           "BurnedInAnnotation declared. Pixel data is NOT cleaned; check the "
                           "images before releasing this study.")

    # -- evidence ------------------------------------------------------------

    def _method_codes(self) -> list:
        # The Basic Profile requires private attributes removed, so keeping them
        # means we did not apply it and must not code it. There is no honest
        # substitute: 113111 Retain Safe Private is for attributes vetted as
        # safe, and these were not vetted at all. What is left is a list of
        # retain options with no base profile under them, which is exactly the
        # truth — every code in the sequence still names something we did.
        codes = [] if self.keep_private else [_CODE_BASIC]
        codes += [_CODE_FULL_DATES if self.keep_dates else _CODE_MOD_DATES,
                  _CODE_PATIENT_CHARS]
        if self.profile == "basic":
            codes += [_CODE_DEVICE, _CODE_INSTITUTION]
        return codes

    def _stamp_evidence(self, ds: Dataset) -> None:
        codes = self._method_codes()
        seq = []
        for value, meaning in codes:
            item = Dataset()
            item.CodeValue = value
            item.CodingSchemeDesignator = "DCM"
            item.CodeMeaning = meaning
            seq.append(item)

        method = ["Carino DICOM %s profile" % self.profile] + [m for _, m in codes]
        if self.keep_private:
            method.append("PRIVATE ATTRIBUTES RETAINED UNVETTED")
        if not self.keep_dates:
            # E.3.6 requires the manner of the date modification to be stated,
            # and this is the only place a receiving system will ever read it —
            # a Conformance Statement is a PDF nobody parses. It also closes the
            # one thing 113107 does not say on its own: the offset is whole days,
            # so the time of day is carried unchanged. A recipient who assumed
            # the clock had moved too would mis-judge how much re-identification
            # risk is left in the object, and that assumption is exactly what a
            # bare code invites. See "Why the offset is whole days" above.
            method.append("DATES SHIFTED WHOLE DAYS PER PATIENT; CLOCK TIMES KEPT")
        method.append("PIXEL DATA NOT CLEANED")
        method = [m[:64] for m in method]  # LO is 64 bytes per value

        # Asserting YES while forwarding unvetted private attributes would be a
        # false claim on the one attribute a recipient is entitled to trust, so
        # keep_private downgrades it. The method text says why.
        ds.PatientIdentityRemoved = "NO" if self.keep_private else "YES"
        ds.DeidentificationMethod = method
        ds.DeidentificationMethodCodeSequence = seq
        ds.LongitudinalTemporalInformationModified = "UNMODIFIED" if self.keep_dates else "MODIFIED"

    def _fix_file_meta(self, ds: Dataset) -> None:
        fm = getattr(ds, "file_meta", None)
        if fm is None:
            return
        # A remapped SOPInstanceUID that the file meta still disagrees with
        # produces an object whose Part-10 header points at a different
        # instance; some archives index the header and lose the file.
        sop_class = ds.get("SOPClassUID", None)
        sop_inst = ds.get("SOPInstanceUID", None)
        if sop_class:
            fm.MediaStorageSOPClassUID = sop_class
        if sop_inst:
            fm.MediaStorageSOPInstanceUID = sop_inst
        fm.ImplementationVersionName = "CARINO-DICOM"
        if self.profile == "strict" and _SOURCE_AE in fm:
            del fm[_SOURCE_AE]  # the sending AE title names the originating site
        if not self.keep_private:
            for tag in _META_PRIVATE:
                if tag in fm:
                    del fm[tag]

    # -- entry point ---------------------------------------------------------

    def deidentified_copy(self, ds: Dataset) -> Dataset:
        """Return a de-identified COPY. The argument is never modified.

        The caller keeps its original dataset — and, critically, whatever file
        that dataset was read from stays byte-identical on disk. Only the copy
        travels.

        Raises DeidError if the dataset cannot be processed; treat that as a
        send failure, never as permission to skip the file.
        """
        if not self.enabled:
            return ds  # nothing was touched, so sharing the object is safe

        try:
            out = copy.deepcopy(ds)  # bytes are atomic to deepcopy: pixels are not duplicated
        except Exception as exc:
            raise DeidError("could not copy dataset: %s" % exc) from exc

        try:
            identity = self._identity(out)
            token = str(out.get("StudyInstanceUID", "") or identity)
            self._check_pixels(out, token)

            if not self.keep_private:
                out.remove_private_tags()  # recurses into sequences

            self._apply_profile(out)
            self._remap_uids(out)

            if not self.keep_dates:
                lost = self._shift_dates(out, self.date_offset(identity))
                if lost:
                    self._say_once(token + "|baddate", "warn",
                                   "De-identification: %d date/time value(s) in this study could "
                                   "not be parsed and were blanked rather than forwarded "
                                   "unshifted." % lost)

            pseudo = self.pseudo_id(identity)
            out.PatientID = pseudo
            # Table E.1-1 says Z for PatientName; a zero-length name breaks most
            # viewers and makes a pseudonymised study impossible to group by eye,
            # so we take the D route the standard allows for PatientID and apply
            # it to both. The value carries no information the ID does not.
            out.PatientName = pseudo
            if "PatientAge" in out and out.PatientAge:
                out.PatientAge = _cap_age(out.PatientAge)

            self._stamp_evidence(out)
            self._fix_file_meta(out)
        except DeidError:
            raise
        except Exception as exc:
            raise DeidError("de-identification failed: %s" % exc) from exc
        return out

    def transform(self, ds: Dataset, dest=None) -> Dataset:
        """Hook shape for ``scu.c_store(..., transform=)``.

        ``dest`` is accepted and ignored on purpose. Whether a given node gets
        the scrubbed copy is the router's answer (``Decision.needs_deid(name)``),
        and the sender decides by passing this hook or not passing it — so the
        same file can go out identified to the local archive and de-identified
        to a research node in the same pass. That only stays true because
        ``c_store`` re-reads the file per destination and this method never
        mutates its argument: hoist the read out of the loop and one
        destination's profile starts leaking into the next.
        """
        return self.deidentified_copy(ds)


@contextmanager
def deidentified_tempfile(src_path: str, deider: Optional[Deidentifier],
                          dir: Optional[str] = None) -> Iterator[str]:
    """Yield a path to a de-identified copy of ``src_path``, then delete it.

    ``src_path`` is opened read-only and is byte-identical afterwards. With a
    None (or disabled) deidentifier the source path is yielded unchanged and
    nothing is created or deleted.

    Never point ``dir`` inside the watch folder: the watcher would pick the
    temp file up as a new study and forward it in a loop. The default is the
    system temp dir, and mkstemp creates the file 0600 so a copy that still
    contains pixels is not world-readable while it exists.
    """
    if deider is None or not deider.enabled:
        yield src_path
        return

    ds = dcmread(src_path)
    out = deider.deidentified_copy(ds)
    fd, tmp = tempfile.mkstemp(prefix="carino-deid-", suffix=".dcm", dir=dir)
    os.close(fd)
    try:
        write_dataset(out, tmp)
        yield tmp
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
