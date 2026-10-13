# Real OctoPrint with its bundled Virtual Printer, for testing FarmSlicer's
# OctoPrint driver: docker build --build-arg OCTOPRINT_VERSION=2.0.0rc6 ...
FROM python:3.12-slim
ARG OCTOPRINT_VERSION=1.11.8
ARG THUMBNAILS=1
# 1.11 needs netifaces, which has no wheel for this Python: build it.
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
 && pip install --no-cache-dir "OctoPrint==${OCTOPRINT_VERSION}" \
 && if [ "$THUMBNAILS" = 1 ]; then pip install --no-cache-dir \
      https://github.com/jneilliii/OctoPrint-PrusaSlicerThumbnails/archive/master.zip; fi \
 && apt-get purge -y gcc libc6-dev &&apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY config.yaml users.yaml /seed/
# OctoPrint won't run as root.
RUN useradd --create-home octoprint && mkdir -p /data && cp /seed/* /data/ && chown -R octoprint /data
USER octoprint
EXPOSE 5000
CMD ["octoprint", "--basedir", "/data", "serve", "--host", "0.0.0.0", "--port", "5000"]
