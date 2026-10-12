#!/bin/sh
vsftpd /etc/vsftpd.conf &
mosquitto -c /etc/fake/mosquitto.conf -d
sleep 1
exec /etc/fake/responder.sh
