# Encryption at rest

Carino DICOM writes everything it holds as ordinary files: received studies, the
sqlite index (patient names and IDs, in the clear and indexed), orders, captured
prints, the audit trail, the logs, and `config.json` with the access token,
`deid.secret`, the notification secrets, every profile's password hash and the
paths to the TLS keys. The application does not encrypt any of it. The volume
underneath has to.

This page is the step-by-step for doing that on the machine that stores the
studies. It covers Linux (LUKS2), Windows (BitLocker) and macOS (FileVault), who
holds the recovery keys, how to show an auditor that it is done, and how to make
sure Carino DICOM never writes to a volume that is not there.

Read [SECURITY.md](../SECURITY.md#why-encryption-at-rest-is-deferred) first if
you have not. The short version: a key kept beside the data protects nothing.
Disk encryption protects a disk that leaves the building — a stolen machine, a
decommissioned one, a drive sent back under warranty. It does not protect a
running machine that somebody has broken into, and nothing on this page claims
it does.

> **How these commands were checked.** The Linux commands were checked against
> the man pages of cryptsetup, systemd-cryptenroll, crypttab(5), fstab(5) and
> systemd.unit(5) as shipped with systemd 259 and cryptsetup on Fedora 44. They
> were **not** run: the machine this was written on has no spare disk and no
> root. The Windows (`manage-bde`, PowerShell BitLocker module) and macOS
> (`fdesetup`) commands were written from Microsoft's and Apple's documentation
> and were not run either. Rehearse on a spare machine or a virtual machine
> before you touch the real one, and keep a backup you have restored from.

---

## What has to be encrypted

Everything under the data directory, plus anything that ever held a copy:

| Install | Data directory |
| --- | --- |
| systemd ([packaging/README.md](../packaging/README.md)) | `/var/lib/carino-pacs` |
| Podman quadlet | `~/CarinoDICOM` of the account that runs it, mounted at `/data` |
| Docker Compose | `./data` next to `docker-compose.yml`, mounted at `/data` |
| Desktop app, from source | `~/CarinoDICOM` (`~/CarinoPACS` on installs made before the rename) |

Also:

- **Swap.** Pages of a running engine — tokens, study headers — can be written to
  swap. A full-disk install encrypts swap with everything else. If you only
  encrypt a data volume, encrypt swap too or turn it off.
- **Free space that once held studies.** Encrypting a disk in place does not
  scrub what was deleted from it before. If the disk has ever held studies in the
  clear, encrypt the whole volume (not "used space only"), or move the data to a
  new encrypted volume and wipe the old disk.
- **Backups.** See [Backups](#backups). An encrypted server with a plain backup
  drive on the shelf next to it is a plain server.
- **The outgoing, sent and pending folders, if you moved them.** `scu.watch_dir`,
  `scu.sent_dir`, `scu.pending_dir`, `ris.store_dir`, `index.path` and
  `audit.dir` can each point outside the data directory. Each one has to be on an
  encrypted volume too.

---

## Linux: LUKS2

There are two ways. Pick one.

1. **The whole disk, at installation.** Every mainstream installer has an
   *Encrypt my data* option (Fedora, RHEL, Rocky, Ubuntu, Debian). It encrypts
   root, home and swap with LUKS2 and asks for the passphrase at boot. For a new
   machine this is the simplest correct answer: do it, then skip to
   [Unattended boot with the TPM](#unattended-boot-with-the-tpm) and
   [Key custody](#key-custody).
2. **A dedicated data volume** on a second disk or a spare partition, mounted at
   the data directory. Use this on a machine that is already installed, or when
   you want the studies on their own disk. The rest of this section is this
   case.

The examples use `/dev/sdb` as the new disk, `/dev/sdb1` as its partition,
`carino-data` as the mapping name and `/var/lib/carino-pacs` as the data
directory. **Check the device name twice. `luksFormat` destroys what is on it.**

### 1. Find the disk

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,MODEL,SERIAL
```

Write down the serial number. It goes in the evidence for the auditor.

### 2. Partition and format it as LUKS2

```bash
sudo parted /dev/sdb -- mklabel gpt mkpart carino-data 1MiB 100%
sudo cryptsetup luksFormat --type luks2 --pbkdf argon2id /dev/sdb1
```

`luksFormat` asks for the first passphrase. Make it long and random — a
generated six-word phrase, not a word anyone could guess — because it is the key
that a human types when everything else has failed. Current cryptsetup defaults
to AES-XTS with a 512-bit key, which is what you want; `cryptsetup luksDump`
shows it later.

Add a recovery key as a second, independent way in. `systemd-cryptenroll`
generates a high-entropy one and prints it once:

```bash
sudo systemd-cryptenroll --recovery-key /dev/sdb1
```

Copy it straight onto the custody form (see [Key custody](#key-custody)). It is
not shown again.

Back up the LUKS header. If the first megabytes of the partition are damaged,
the header backup is the only way back to the data:

```bash
sudo cryptsetup luksHeaderBackup /dev/sdb1 --header-backup-file carino-data-header.img
```

The header backup opens the volume with any passphrase that was valid when it
was taken. Store it like a key, never on the same disk, and destroy old copies
when you rotate (see [Rotation](#rotation)).

### 3. Open it and make a file system

```bash
sudo cryptsetup open /dev/sdb1 carino-data
sudo mkfs.xfs -L carino-data /dev/mapper/carino-data     # or mkfs.ext4
```

### 4. Move the existing data onto it

Stop the service first, so nothing is written mid-copy:

```bash
sudo systemctl stop carino-pacs.service
sudo mkdir -p /mnt/carino-new
sudo mount /dev/mapper/carino-data /mnt/carino-new
sudo rsync -aHAX --numeric-ids /var/lib/carino-pacs/ /mnt/carino-new/
sudo diff -r /var/lib/carino-pacs /mnt/carino-new && echo identical
sudo umount /mnt/carino-new
```

Keep the old copy until the new volume has been running for a while and a backup
has been taken from it. Then remove it and wipe the old disk — the old copy is
the plain-text archive you are trying to get rid of.

To make the old directory the empty mountpoint, move it aside rather than
deleting it straight away:

```bash
sudo mv /var/lib/carino-pacs /var/lib/carino-pacs.plain
sudo mkdir /var/lib/carino-pacs
```

### 5. Unlock and mount at boot

Find the LUKS UUID (the partition's, not the file system's):

```bash
sudo cryptsetup luksUUID /dev/sdb1
```

`/etc/crypttab`:

```
carino-data  UUID=<luks-uuid>  none  luks,nofail
```

`none` means "ask for the passphrase at boot". For an appliance that has to come
back on its own after a power cut, see the next section.

`/etc/fstab`:

```
/dev/mapper/carino-data  /var/lib/carino-pacs  xfs  defaults,nofail  0  2
```

`nofail` in both files keeps the machine booting, and reachable over SSH, when
the volume cannot be unlocked. Carino DICOM itself stays down in that case (see
[Never write to an empty mountpoint](#never-write-to-an-empty-mountpoint)),
which is what you want.

Leave `discard` out of crypttab unless the disk is an SSD that needs it for
performance. With it, an attacker who has the disk can see which blocks are in
use — not their content, but the pattern.

Then:

```bash
sudo systemctl daemon-reload
sudo mount /var/lib/carino-pacs                       # reads the fstab line
sudo restorecon -R /var/lib/carino-pacs               # SELinux systems only
sudo systemctl start carino-pacs.service
```

On SELinux systems, the `restorecon` puts back the labels `rsync -X` may not have
carried onto the new file system. Reboot once, on purpose, while you are there to
watch it come back.

### Unattended boot with the TPM

A passphrase at boot means somebody has to be at the console after every power
cut. For most departments that is not acceptable. `systemd-cryptenroll` can bind
an extra key slot to the machine's TPM2 chip, so the volume unlocks by itself on
this machine and only on this machine:

```bash
sudo systemd-cryptenroll --tpm2-device=list
sudo systemd-cryptenroll --tpm2-device=auto --tpm2-pcrs=7 /dev/sdb1
```

and in `/etc/crypttab`:

```
carino-data  UUID=<luks-uuid>  none  luks,nofail,tpm2-device=auto
```

`--tpm2-pcrs=7` ties the unlock to the Secure Boot state. Name the PCRs
explicitly: the default has changed between systemd versions, and with no PCRs
at all the TPM releases the key to anything that boots on this board.

Know what you are trading:

- **What it still protects:** a disk taken out of the machine. The key is in the
  TPM on the motherboard, not on the disk.
- **What it no longer protects:** the whole machine, carried out the door. It
  boots and unlocks the volume by itself. From then on the data is protected
  only by the operating system's logins, the firewall and Carino DICOM's own
  token — the same as a running machine. That is the "key beside the data" case
  SECURITY.md describes, one step removed. Decide whether your threat is "a
  drive leaves" (TPM is fine) or "the box leaves" (it is not).
- **Firmware and Secure Boot changes break it.** A BIOS update, a Secure Boot key
  change, or turning Secure Boot off changes PCR 7. The next boot then waits for
  the passphrase or the recovery key at the console, and the appliance is down
  until somebody types it. Plan firmware updates with the recovery key at hand,
  and re-enroll afterwards:

  ```bash
  sudo systemd-cryptenroll --wipe-slot=tpm2 --tpm2-device=auto --tpm2-pcrs=7 /dev/sdb1
  ```

- **`--tpm2-with-pin=yes`** adds a PIN to the TPM unlock. That protects the
  stolen-machine case again, and brings back the person at the console at every
  boot. It is the right choice for a laptop, rarely for an appliance.

Keep the passphrase and the recovery key slots. The TPM slot is a convenience,
not the only way in.

### Never write to an empty mountpoint

When the volume is not mounted, `/var/lib/carino-pacs` is still there — an empty
directory on the root file system. A service that starts anyway receives studies
into it, unencrypted, and they disappear from view the moment the encrypted
volume is mounted over them.

The shipped unit, `packaging/systemd/carino-pacs.service`, prevents that:

```
RequiresMountsFor=/var/lib/carino-pacs
```

The service waits for the mount and does not start without it. (`StateDirectory=`
in the same unit implies the same dependency; the line is there so it does not
depend on a side effect.) Check that systemd sees it:

```bash
systemctl show carino-pacs.service -p RequiresMountsFor -p After | tr ' ' '\n' | grep -i carino
```

If you moved any data path to another mount, add it in a drop-in, together with
`ReadWritePaths=` so the sandbox lets the service write there:

```bash
sudo systemctl edit carino-pacs.service
```

```
[Unit]
RequiresMountsFor=/srv/carino-outgoing

[Service]
ReadWritePaths=/srv/carino-outgoing
```

For Docker or Podman, the same rule applies to the host directory mounted at
`/data`. For a system service (`docker.service`, or a rootful quadlet), add
`RequiresMountsFor=<host data directory>` to its `[Unit]` with a drop-in. For a
rootless Podman quadlet, the user's systemd cannot mount system volumes; mount
the volume at boot (fstab, as above) and make sure it is mounted before anyone
logs in to start the container.

Belt and braces: make the empty mountpoint itself unwritable, so that even a
process that ignores the dependency cannot put a file there:

```bash
sudo umount /var/lib/carino-pacs        # only with the service stopped
sudo chattr +i /var/lib/carino-pacs
sudo mount /var/lib/carino-pacs
```

The flag is on the directory underneath; the mounted file system is unaffected.

### Proving it is encrypted (Linux)

Run these and keep the output, with the date and the disk serial, as the
evidence:

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,SERIAL /dev/sdb
#  sdb1 must show FSTYPE crypto_LUKS, with carino-data (TYPE crypt) under it,
#  mounted at /var/lib/carino-pacs.

sudo cryptsetup luksDump /dev/sdb1
#  Version: 2, the cipher (aes-xts-plain64) and key size, the key slots, and
#  tokens named systemd-recovery / systemd-tpm2 if you enrolled them.

sudo cryptsetup status carino-data
#  type LUKS2, cipher, the device it sits on.

findmnt /var/lib/carino-pacs
#  SOURCE must be /dev/mapper/carino-data — not the root file system.

systemctl show carino-pacs.service -p RequiresMountsFor
```

And the negative: with the service stopped and the volume closed, the raw
partition holds nothing readable. Take a value you know is stored on the volume
and long enough not to turn up by chance — a StudyInstanceUID from the History
page — and search the raw partition for it:

```bash
sudo systemctl stop carino-pacs.service
sudo umount /var/lib/carino-pacs && sudo cryptsetup close carino-data
sudo grep -c -a -F '1.2.826.0.1.3680043.8.498.<rest of the UID>' /dev/sdb1   # expect 0; reads the whole disk
```

(Do not search for the four bytes `DICM` that start every DICOM file: on a disk
of random-looking ciphertext, four bytes turn up by chance hundreds of times.)

Re-open, re-mount and start the service afterwards (`cryptsetup open`, `mount`,
`systemctl start`), or reboot.

---

## Windows: BitLocker

This applies to the desktop app and to an engine run as a Windows service. The
data directory is normally `%USERPROFILE%\CarinoDICOM` on the system drive, so
the system drive is what has to be encrypted. If you moved the data to a second
drive, encrypt that one too.

BitLocker needs Windows Pro, Enterprise or Education. Run these in an elevated
Command Prompt or PowerShell.

### 1. Check the current state

```
manage-bde -status
```

### 2. Encrypt the system drive

```
manage-bde -protectors -add C: -TPM
manage-bde -protectors -add C: -RecoveryPassword
manage-bde -on C: -EncryptionMethod XtsAes256
```

The second command prints a 48-digit **recovery password**. Write it onto the
custody form now. Do not add `-UsedSpaceOnly` on a machine that has ever held
studies: free space that once held a study is encrypted only by a full pass.

The TPM protector unlocks the drive by itself at boot, so the machine comes back
after a power cut. The same trade as on Linux applies: it protects a drive taken
out of the machine, not a whole machine carried away. A TPM-plus-PIN protector
(`-TPMAndPIN`) protects that case too, at the cost of somebody typing the PIN at
every boot.

### 3. A second data drive

```
manage-bde -on D: -RecoveryPassword -EncryptionMethod XtsAes256
manage-bde -autounlock -enable D:
```

Auto-unlock needs the system drive to be BitLocker-protected first. Without it,
somebody has to unlock D: after every boot, and until then the data directory
simply does not exist: Carino DICOM reports errors instead of storing studies,
which is the failure you want. It never writes the studies somewhere else.

### 4. Escrow the recovery password

Get the protector's ID and password:

```
manage-bde -protectors -get C:
```

Then store it in the directory, as well as on paper:

- **Active Directory:** `manage-bde -protectors -adbackup C: -id {protector-ID}`
- **Microsoft Entra ID (PowerShell):**
  `BackupToAAD-BitLockerKeyProtector -MountPoint "C:" -KeyProtectorId "{protector-ID}"`

Check in the directory that the key arrived. A key escrow you have not looked at
is a key escrow you do not have.

### Proving it is encrypted (Windows)

```
manage-bde -status C:
```

Expect *Conversion Status: Fully Encrypted*, *Percentage Encrypted: 100%*,
*Encryption Method: XTS-AES 256*, *Protection Status: Protection On*, and the
protectors listed under *Key Protectors*. In PowerShell,
`Get-BitLockerVolume | Format-List *` gives the same as one record. Keep the
output with the date and the machine's serial number.

### Rotation (Windows)

Add the new recovery password, escrow it, then delete the old one:

```
manage-bde -protectors -add C: -RecoveryPassword
manage-bde -protectors -get C:
manage-bde -protectors -delete C: -id {old-protector-ID}
```

---

## macOS: FileVault

FileVault encrypts the whole startup disk. The data directory is
`~/CarinoDICOM`, on that disk.

### 1. Check and enable

```bash
fdesetup status
sudo fdesetup enable -user <admin-account>
```

`enable` prints a **personal recovery key**. Write it onto the custody form now.

If the Mac is managed by an MDM, let the MDM enable FileVault and escrow the
personal recovery key instead. That is Apple's recommended path for
organisations.

### 2. Institutional recovery key

An institutional recovery key is one key, held by the organisation, that opens
every Mac it was installed on. It is created once as `FileVaultMaster.keychain`
and enabled with:

```bash
sudo fdesetup enable -keychain -user <admin-account>
```

Apple documents institutional recovery keys as **not supported on Mac computers
with Apple silicon**. On those, use the personal recovery key escrowed by MDM,
or kept under the custody rules below. Check Apple's current *Platform
Deployment* guide before relying on either.

### The unattended-restart problem

A FileVault Mac does not unlock itself. After a power cut it waits at the login
window, and Carino DICOM is down until somebody logs in. For a planned restart,
`sudo fdesetup authrestart` restarts once without the prompt. For an
unplanned one there is no way around it, and a Mac is therefore a poor choice
for an appliance that must come back on its own.

### Proving it is encrypted (macOS)

```bash
fdesetup status                       # "FileVault is On."
fdesetup haspersonalrecoverykey       # true
fdesetup hasinstitutionalrecoverykey  # true, if you use one
sudo fdesetup validaterecovery        # asks for the recovery key and says whether it works
```

`validaterecovery` is the one to run in front of the auditor: it proves the key
on the custody form actually opens this disk.

### Rotation (macOS)

```bash
sudo fdesetup changerecovery -personal
```

prints a new personal recovery key and invalidates the old one.

---

## Key custody

Encryption is only as good as the answer to *who can open it, and how would we
know?* Decide these before you encrypt anything, and write the answers down.

**What the keys are.** Per encrypted volume: the passphrase (Linux), the
recovery key or recovery password (all three), and the LUKS header backup
(Linux), which counts as a key. The TPM slot is not something anybody holds.

**Who holds them.**

- Not the person who operates Carino DICOM day to day, alone. The technician who
  runs the dashboard should not also be the only person who can open the disk.
- **Two-person rule.** Split custody between two named roles — for example the
  head of IT and the department's information-security or data-protection
  officer. Neither opens the sealed copy without the other present, and both
  sign the log when it is opened.
- **Directory escrow** where it exists (Active Directory, Entra ID, MDM). It is
  the copy you will actually use, and it records who looked.
- **One printed, sealed copy** in a tamper-evident envelope, in a safe that is
  not in the same room as the server. Write on the outside: the machine name,
  the disk serial, the date, the key's identifier (BitLocker protector ID, LUKS
  key slot, macOS: "personal recovery key, issued <date>"), and the two
  custodians' signatures across the seal. Never the key itself on the outside.
- **Never** in the same place as the disk: not in a file on the server, not in a
  password manager whose vault is synced to the server, not taped inside the
  case, not in `config.json`, not in the ticket that asked for the work.

**The custody log.** One page per machine: who created each key and when,
where each copy is, and every time the envelope was opened — by whom, why, and
what was rotated afterwards.

**Test it.** Once a year, and after any change, open the volume with the
recovery key on a test boot (macOS: `fdesetup validaterecovery`; Linux:
`cryptsetup open --test-passphrase /dev/sdb1` and type the recovery key; Windows:
check the protector ID on the envelope matches `manage-bde -protectors -get`).
A recovery key that has never been tried is a guess.

### Rotation

Rotate:

- after any recovery key has been used, or the envelope opened;
- when a custodian or anybody else who saw a key leaves or changes role;
- on a fixed schedule your policy sets (yearly is common).

Add the new key first, check it works, then remove the old one. On Linux:

```bash
sudo cryptsetup luksAddKey /dev/sdb1                # new passphrase
sudo cryptsetup open --test-passphrase /dev/sdb1    # check it
sudo cryptsetup luksKillSlot /dev/sdb1 <old-slot>   # remove the old one (luksDump shows the slots)
sudo systemd-cryptenroll --wipe-slot=recovery --recovery-key /dev/sdb1   # new recovery key
sudo cryptsetup luksHeaderBackup /dev/sdb1 --header-backup-file carino-data-header-<date>.img
```

Then **destroy every older LUKS header backup**. An old header backup still
opens the volume with the old passphrase, whatever you removed from the live
header. Rotation on a passphrase alone does not change the volume's master key;
if you believe the master key itself is exposed (the volume was opened on a
machine you no longer trust), re-encrypt with `cryptsetup reencrypt` or move the
data to a freshly formatted volume.

### When the technician leaves

The day somebody with access leaves:

1. Rotate every disk key they knew or handled (above), and record it in the
   custody log.
2. In Carino DICOM: rotate `web.auth_token` (Settings → Access, or
   `POST /api/auth/token`); every session is signed out when it changes. Disable
   or delete their profile. If they knew a profile's password, change it.
3. If they held the TLS private key for the dashboard, issue a new certificate
   (`python -m pacs tls-cert --force --enable`, or from your CA) and restart.
4. Consider `deid.secret` separately. Changing it changes every pseudonym this
   box produces from then on, so exports made before and after can no longer be
   linked. That is the point if the old key may be out; it is a cost if it is
   not.
5. Remove their SSH keys and accounts on the host, and check the audit trail for
   what they did in their last weeks.

---

## Backups

The studies are the one thing that cannot be rebuilt (the index can). So there
will be backups, and every one of them is a copy of the archive:

- **Encrypt them.** Use a tool that encrypts before the data leaves the machine
  (restic and borg both do, with a repository key), or write to a target disk
  that is itself LUKS/BitLocker/FileVault-encrypted.
- **The backup key follows the same custody rules** as the disk keys, held by
  the same two custodians, in the same log. A backup whose key lives on the
  server it backs up dies with that server.
- **Back up `config.json` with the data**, and know that it carries the token,
  `deid.secret` and the password hashes. It must be encrypted like everything
  else.
- **Restore, for real, on a schedule.** Restore to a spare machine, start
  Carino DICOM against the restored data directory, and query a study. Write the
  date in the custody log.
- **Destroy media that leave service.** An old backup disk is encrypted, but its
  key may outlive your custody of it. Wipe or physically destroy, and record it.

---

## Checklist

- [ ] The data directory (and every moved data path, swap and backups) is on an
      encrypted volume.
- [ ] Data that existed before encryption has been moved off, and the old disk
      wiped.
- [ ] Linux: `RequiresMountsFor=` covers every data path;
      `systemctl show carino-pacs -p RequiresMountsFor` confirms it.
- [ ] A reboot was done on purpose and the appliance came back (or waited for the
      key, if that is the chosen design).
- [ ] Recovery keys exist, are escrowed and printed, sealed, logged, and held by
      two named custodians, away from the machine.
- [ ] A recovery key was tested and the test is in the log.
- [ ] The evidence (`lsblk`/`cryptsetup luksDump`, `manage-bde -status` or
      `fdesetup status`) is filed with the date and the disk serial.
- [ ] Rotation and leaver steps are written into the department's procedures.
