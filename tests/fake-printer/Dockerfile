# Fake Bambu printer for FarmSlicer development: MQTT over TLS on 8883 and
# implicit FTPS on 990 (vsftpd with require_ssl_reuse, like the printers),
# user bblp, access code 12345678, serial FAKE00000000001.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      mosquitto mosquitto-clients vsftpd openssl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -d /sdcard -s /bin/sh bblp && echo 'bblp:12345678' | chpasswd \
    && mkdir -p /etc/fake /var/run/vsftpd/empty \
    && openssl req -x509 -newkey rsa:2048 -nodes -keyout /etc/fake/server.key \
         -out /etc/fake/server.crt -days 3650 -subj "/CN=FAKE00000000001" 2>/dev/null \
    && chmod 644 /etc/fake/server.key \
    && touch /etc/fake/passwd && mosquitto_passwd -b /etc/fake/passwd bblp 12345678 \
    && chmod 644 /etc/fake/passwd
COPY vsftpd.conf /etc/vsftpd.conf
COPY mosquitto.conf /etc/fake/mosquitto.conf
COPY responder.sh start.sh /etc/fake/
RUN chmod 755 /etc/fake/*.sh
CMD ["/etc/fake/start.sh"]
