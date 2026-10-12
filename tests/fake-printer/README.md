# Fake Bambu printer

A container that answers like a Bambu Lab printer in LAN mode, for
developing and testing FarmSlicer's printer link without real hardware:

- MQTT over TLS on 8883 (mosquitto), user `bblp`, access code `12345678`,
  serial `FAKE00000000001`. `responder.sh` answers `pushall` with a full
  report (AMS with four trays, an external spool), acks commands, and on
  `project_file` checks the file was uploaded, then reports PREPARE →
  RUNNING → FINISH over a few seconds (`result: FAIL` if the file is
  missing).
- Implicit FTPS on 990 (vsftpd with `require_ssl_reuse=YES`, chrooted to
  `/sdcard`), the same quirk the printers have.

```sh
docker build -t fake-bambu tests/fake-printer
docker run -d --name fake-printer fake-bambu
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' fake-printer
```

Add a printer in FarmSlicer with that address, the serial and the access
code. The FTPS client's live test runs against it too:

```sh
FARMSLICER_FTPS_TEST=<ip>:990:12345678 FARMSLICER_SKIP_CXX=1 \
  cargo test -- --ignored live_upload
```
