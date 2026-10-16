# Printers not tested on real hardware

What each printer driver has been proven against, and what hasn't been
tried on a real printer yet. Update this when someone runs a printer for
the first time: move it to "Tested", with the date and what was checked.

A first real print on any of these is worth doing with the printer's plate
clear and someone watching: send a small test file, follow it, pause,
resume, stop.

## Tested on real printers

| Printer | Protocol | Checked |
| --- | --- | --- |
| Bambu Lab X1 Carbon | Bambu | 2026-10-12: status, AMS trays, camera (RTSPS), pictures of outside prints, sending and starting prints, stop (0300_400C → cancelled) |
| Bambu Lab H2D | Bambu | 2026-10-12: status (both nozzles, AMS), camera (RTSPS), pictures of outside prints. No print sent yet. Untried: a multi-filament job (supports in a support material), where the AMS mapping keeps each filament on an AMS that feeds the nozzle libslic3r gave it (`AmsUnit.nozzle` from bits 8-11 of the unit's `info`, as Bambu's device code reads them: 0 = right, 1 = left) |

## Tested against real printer software, not a printer

| Protocol | Against | Not yet seen on hardware |
| --- | --- | --- |
| Klipper (Moonraker) | Klipper + Moonraker with a simulated MCU (`mainsail-crew/virtual-klipper-printer`): status, upload, print to completion, pause/resume, refused send while paused, speed, cancel, camera (mjpg-streamer), heater and speed commands | any physical Klipper printer; heating (the simulator can't); Moonraker with an API key; webcams behind nginx (relative URLs); vendor forks (Creality K1/K2, Qidi, Sovol, Elegoo Neptune 4, Snapmaker U1) |
| OctoPrint | OctoPrint 1.11.8 and 2.0.0rc6 with the Virtual Printer (`tests/fake-octoprint/Dockerfile`): everything the driver does, discovery over mDNS | a real serial printer behind OctoPrint; a real webcam (OctoPi's `/webcam/`) |

## Tested against FarmSlicer's own fakes only

| Protocol | Printers | Not yet seen on hardware |
| --- | --- | --- |
| Prusa (PrusaLink) | MK4/MK4S, MK3.5/3.9, MINI, XL, CORE One (Buddy firmware); MK3 with the Raspberry Pi Prusa-Link | everything: password auth, upload speed over Wi-Fi, ATTENTION (the screen's questions), FINISHED/STOPPED tracking, `/thumb/l` previews of our G-code |
| Elegoo (SDCP) | Centauri Carbon, Centauri | everything: the 1 MiB chunked upload and the file check, Cmd 128 start (do the first one with a tiny file: a wrong payload can crash the printer), status pushes while idle, camera (one viewer), history pictures, discovery replies |

## Bambu models not yet seen

| Model | Notes |
| --- | --- |
| P1P, P1S, A1, A1 mini | JPEG camera on port 6000 (tested against the fake printer only); delta reports |
| X1, X1E, H2S, H2D Pro, P2S, X2D | model ids from OrcaSlicer's profiles |
| H2C | no OrcaSlicer profile yet |
