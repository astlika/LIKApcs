# Wake-on-LAN — turning gaming PCs on from LIKApcs (0.7.0)

LIKApcs Admin can power on an offline gaming PC with one click (Stations → offline PC → **Power
on**, or **Power on all** in the toolbar). Under the hood the **LIKApcs Server** sends the standard
Wake-on-LAN "magic packet" to the PC's network card; the card, which stays powered while the PC is
off, starts the machine. LIKApcs-Client then boots with Windows, connects and locks the screen as
usual.

Three things have to be true for a PC to react. LIKApcs handles two of them and shows the result
as a readiness badge in the PC details (**Ready** / **Not ready** / **Unknown**):

| Requirement                                          | Who does it                                                                      | Visible in Admin              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------- |
| Windows: adapter "wake on magic packet" enabled      | LIKApcs — **Enable Wake-on-LAN** button while the PC is online (`wol.configure`) | `wake on magic packet is off` |
| Windows: Fast startup **off**                        | same button (sets `HiberbootEnabled = 0`)                                        | `Windows Fast startup is on`  |
| BIOS/UEFI: Wake-on-LAN / "Power On By PCI-E" enabled | **you, once per PC** — Windows cannot read or change firmware settings           | not visible (cannot be read)  |

The PC must be connected with **a cable**. Wi-Fi adapters practically never wake a PC and are only
used when nothing else is on record.

## 1. Enable it in the BIOS/UEFI (once per PC)

1. Restart the PC and open the firmware setup (usually `Del`, `F2` or `F12` during the first
   seconds).
2. Look under _Power Management_, _Advanced → APM_, _ACPI_ or _Onboard Devices_ for one of:
   **Wake on LAN**, **Power On By PCI-E / PCI**, **Resume by LAN**, **WOL from S5**,
   **Network Boot/Wake** — set it to **Enabled**.
3. Set **ErP / EuP / Deep Sleep / Deep S5** to **Disabled** (these cut power to the network card when
   the PC is off).
4. Save and exit.

Common locations: ASUS — _Advanced → APM Configuration → Power On By PCI-E_; MSI — _Settings →
Advanced → Wake Up Event Setup → Resume By PCI-E Device_; Gigabyte — _Power → ErP = Disabled_,
_Wake on LAN = Enabled_; ASRock — _Advanced → ACPI Configuration → PCIE Devices Power On_; Dell /
HP / Lenovo prebuilt — _Power Management → Wake on LAN_ (choose "LAN only" / "Enabled").

## 2. Enable it in Windows (from the Admin)

Open the PC in **Stations** while it is online → **Wake-on-LAN → Enable Wake-on-LAN**. The client
turns _wake on magic packet_ on for every physical adapter and switches Fast startup off.

This needs administrator rights on the PC. If the gaming account is a standard user, Windows shows
a **UAC confirmation on the PC's screen** — walk over and approve it (an administrator password may
be asked). The outcome is reported back and the badge turns **Ready**; a declined prompt shows up
in the audit log as `station.wol_configured` with the message.

To do the same by hand: _Device Manager → Network adapters → (your adapter) → Properties → Power
Management_: tick **Allow this device to wake the computer** and **Only allow a magic packet to wake
the computer**; then _Control Panel → Power Options → Choose what the power buttons do → Change
settings that are currently unavailable_ → untick **Turn on fast startup**.

## 3. Use it

- The PC must have connected **at least once with LIKApcs-Client 0.7 or newer**, so the server
  knows its MAC address (shown in the PC details). Older clients do not report adapters — the
  button says _no network adapter on record_ until the client is updated.
- **Power on** is offered for offline PCs only; **Power on all (n)** counts the offline PCs with a
  MAC on record. Both show a toast: _signal sent_ or, if the client reported a known problem,
  _signal sent, but the PC may not react: …_. The PC should appear online within about a minute.
- The PC wakes from a **proper shut-down** (Shut down from LIKApcs or from Windows). After a power
  cut or when the power strip was switched off most boards will not wake until they have booted
  once; some boards also need "Power loss → Power on" in the BIOS for that case.
- The server sends the packets from inside the LAN (broadcast of every network it is on, plus the
  PC's last IP), so the Admin may run anywhere. If the PCs sit behind a different router/VLAN than
  the server, that router must forward directed broadcasts (most do not) — put the server on the
  same network as the PCs.

## Troubleshooting

| Symptom                                           | Check                                                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Badge **Unknown**, _no network adapter on record_ | Client older than 0.7, or the PC never connected since the update. Update the client, reconnect.                                                                                               |
| Badge **Not ready** after _Enable Wake-on-LAN_    | The UAC prompt was declined/timed out (audit log), or the adapter driver does not support it (see Device Manager → Power Management tab missing).                                              |
| Badge **Ready** but the PC does not start         | BIOS/UEFI setting (section 1), ErP/Deep sleep enabled, PC was unplugged, Wi-Fi only, PC in a different network segment, link light off when the PC is off (then the card is unpowered — BIOS). |
| Starts only from sleep, not from shut-down        | Fast startup still on (check manually) or BIOS "WOL from S5" disabled.                                                                                                                         |
| Works for one PC, not for others                  | Same model? Settings are per PC: repeat sections 1–2 on each one.                                                                                                                              |

Everything LIKApcs does here is audited (`station.wake`, `station.wake_all`, `station.wol_configured`,
`station.command.wol.configure`). No credentials are stored or transmitted for any of it.
