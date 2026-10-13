# Fake OctoPrint printer

Real OctoPrint (from PyPI) driving its bundled Virtual Printer, with a known
API key (`FARMSLICERTESTKEY0123456789ABCDEF`) and the first-run wizard
skipped. The virtual printer heats at about 10 °C/s and moves 10x faster
than real time; `M220` speeds it up further.

```sh
docker build -t fake-octoprint tests/fake-octoprint                      # 1.11.8
docker build -t fake-octoprint:2 --build-arg OCTOPRINT_VERSION=2.0.0rc6 tests/fake-octoprint
docker run -d --name fake-octoprint -p 127.0.0.1:5000:5000 fake-octoprint
```

Add a printer in FarmSlicer with protocol OctoPrint, address
`127.0.0.1:5000` and that API key. `THUMBNAILS=0` leaves out the Slicer
Thumbnails plugin (1.x has no thumbnails of its own; 2.0 does).
