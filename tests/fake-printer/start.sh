#!/bin/sh
vsftpd /etc/vsftpd.conf &
mosquitto -c /etc/fake/mosquitto.conf -d
python3 /etc/fake/jpeg6000.py &
sleep 1
exec /etc/fake/responder.sh
