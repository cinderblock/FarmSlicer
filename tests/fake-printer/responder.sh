#!/bin/sh
# Answers pushall with a full report, acks commands, and on project_file
# checks the file was uploaded, then walks PREPARE -> RUNNING -> FINISH.
S=FAKE00000000001
O="-h localhost -p 8883 --insecure --cafile /etc/fake/server.crt -u bblp -P 12345678"
pub() { mosquitto_pub $O -t device/$S/report -m "$1"; }
STATE=IDLE; FILE=""; PCT=0
status() {
  pub "{\"print\":{\"command\":\"push_status\",\"gcode_state\":\"$STATE\",\"mc_percent\":$PCT,\"mc_remaining_time\":$(( (100-PCT)/5 )),\"layer_num\":$PCT,\"total_layer_num\":100,\"subtask_name\":\"$SUBTASK\",\"gcode_file\":\"$FILE\",\"print_error\":${ERR:-0}}}"
}
FULL='{"print":{"command":"push_status","gcode_state":"IDLE","mc_percent":0,"print_error":0,"nozzle_temper":25.0,"nozzle_target_temper":0,"bed_temper":24.0,"bed_target_temper":0,"spd_lvl":2,"wifi_signal":"-48dBm","nozzle_diameter":"0.4","hms":[],"ams":{"tray_now":"255","ams":[{"id":"0","humidity":"4","tray":[{"id":"0","tray_type":"PLA","tray_color":"FF6A13FF","tray_sub_brands":"PLA Basic","remain":80},{"id":"1","tray_type":"PETG","tray_color":"161616FF","tray_sub_brands":"PETG HF","remain":45},{"id":"2"},{"id":"3","tray_type":"PLA","tray_color":"FFFFFFFF"}]}]},"vt_tray":{"id":"254","tray_type":"TPU","tray_color":"00AE42FF"}}}'
mosquitto_sub $O -t device/$S/request | while read -r line; do
  echo "request: $line"
  seq=$(echo "$line" | sed -n 's/.*"sequence_id":"\([0-9]*\)".*/\1/p')
  cmd=$(echo "$line" | sed -n 's/.*"command":"\([a-z_]*\)".*/\1/p')
  case "$cmd" in
    pushall) pub "$FULL" ;;
    project_file)
      url=$(echo "$line" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
      name=${url#ftp://}; name=${name#/}
      if [ -f "/sdcard/$name" ]; then
        pub "{\"print\":{\"command\":\"project_file\",\"sequence_id\":\"$seq\",\"result\":\"SUCCESS\",\"url\":\"file:///sdcard/$name\"}}"
        # Like real printers: gcode_file is the extracted plate; the job is
        # known by its subtask_name.
        FILE="/data/Metadata/plate_1.gcode"; SUBTASK=$(echo "$line" | sed -n 's/.*"subtask_name":"\([^"]*\)".*/\1/p')
        ( STATE=PREPARE; PCT=0; ERR=0; status; sleep 2
          for PCT in 10 30 60 90; do STATE=RUNNING; status; sleep 1; done
          STATE=FINISH; PCT=100; status ) &
      else
        pub "{\"print\":{\"command\":\"project_file\",\"sequence_id\":\"$seq\",\"result\":\"FAIL\",\"reason\":\"file not found\"}}"
      fi ;;
    *) pub "{\"print\":{\"command\":\"$cmd\",\"sequence_id\":\"$seq\",\"result\":\"success\",\"reason\":\"\"}}" ;;
  esac
done
