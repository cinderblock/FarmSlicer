# Fake Bambu printer for FarmSlicer development: MQTT over TLS on 8883 and
# implicit FTPS on 990 (vsftpd with require_ssl_reuse, like the printers),
# user bblp, access code 12345678, serial FAKE00000000001.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      mosquitto mosquitto-clients vsftpd openssl ca-certificates procps python3 ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY vsftpd.conf /etc/vsftpd.conf
COPY mosquitto.conf /etc/fake/mosquitto.conf
COPY responder.sh start.sh jpeg6000.py make_v1_cert.py /etc/fake/
# Like the printers: an X.509 v1 certificate (OpenSSL 3 only writes v3).
RUN useradd -m -d /sdcard -s /bin/sh bblp && echo 'bblp:12345678' | chpasswd \
    && mkdir -p /var/run/vsftpd/empty \
    && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /etc/fake/server.key 2>/dev/null \
    && python3 /etc/fake/make_v1_cert.py /etc/fake/server.key FAKE00000000001 /etc/fake/server.crt \
    && openssl x509 -in /etc/fake/server.crt -noout -text | grep -q "Version: 1 " \
    && chmod 644 /etc/fake/server.key \
    && touch /etc/fake/passwd && mosquitto_passwd -b /etc/fake/passwd bblp 12345678 \
    && chmod 644 /etc/fake/passwd \
    && chmod 755 /etc/fake/*.sh
CMD ["/etc/fake/start.sh"]
