import { useEffect, useRef, useState } from "react";

/** Live view of a printer's camera (GET /api/printers/{id}/camera, a
 * WebSocket). X1/H2-class printers send H.264, decoded here with WebCodecs;
 * A1/P1 send JPEG frames. Reconnects while open, and makes a new decoder
 * when the browser takes the old one away (iOS does when the app goes to
 * the background: the decoder fails and is closed). */
export default function CameraView({ printerId }: { printerId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [kind, setKind] = useState<"h264" | "jpeg" | null>(null);
  const [status, setStatus] = useState("Connecting…");

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let decoder: VideoDecoder | null = null;
    let lastUrl = "";
    let retry: ReturnType<typeof setTimeout> | undefined;
    let waitingForKey = true;
    let config: VideoDecoderConfig | null = null;
    let rebuild: ReturnType<typeof setTimeout> | undefined;

    // close() throws on a decoder that is already closed (one that failed).
    const closeDecoder = () => {
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = null;
    };

    const makeDecoder = () => {
      clearTimeout(rebuild);
      closeDecoder();
      if (closed || !config) return;
      const d = new VideoDecoder({
        output: draw,
        error: (e) => {
          if (closed || decoder !== d) return;
          decoder = null;
          setStatus(`Video error: ${e.message}`);
          // A hidden page gets a new decoder when it's shown again; a visible
          // one after a pause, so a stream that keeps failing doesn't spin.
          if (!document.hidden) rebuild = setTimeout(makeDecoder, 1000);
        },
      });
      d.configure(config);
      decoder = d;
      waitingForKey = true;
    };

    const onVisibility = () => {
      if (!document.hidden && !decoder && config) makeDecoder();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const draw = (frame: VideoFrame) => {
      const canvas = canvasRef.current;
      if (canvas) {
        if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
        if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
        canvas.getContext("2d")?.drawImage(frame, 0, 0);
      }
      frame.close();
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/printers/${printerId}/camera`);
      ws.binaryType = "arraybuffer";
      ws.onmessage = async (ev) => {
        if (typeof ev.data === "string") {
          const msg = JSON.parse(ev.data);
          if (msg.type === "hello") {
            setKind(msg.kind);
            if (msg.kind === "h264" && typeof VideoDecoder === "undefined") {
              setStatus("This browser can't decode the camera's video (no WebCodecs).");
              ws?.close();
            }
          } else if (msg.type === "h264-init") {
            const description = Uint8Array.from(atob(msg.description), (c) => c.charCodeAt(0));
            const next: VideoDecoderConfig = {
              codec: msg.codec,
              description,
              codedWidth: msg.width,
              codedHeight: msg.height,
              optimizeForLatency: true,
            };
            const support = await VideoDecoder.isConfigSupported(next).catch(() => null);
            if (closed) return;
            if (!support?.supported) {
              setStatus(`This browser can't decode ${msg.codec}.`);
              return;
            }
            config = next;
            makeDecoder();
          } else if (msg.type === "error") {
            setStatus(msg.message);
          }
          return;
        }
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        if (bytes[0] === 0xff && bytes[1] === 0xd8) {
          // JPEG
          const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
          if (imgRef.current) imgRef.current.src = url;
          if (lastUrl) URL.revokeObjectURL(lastUrl);
          lastUrl = url;
          setStatus("");
          return;
        }
        if (!decoder || decoder.state !== "configured") return;
        const key = bytes[0] === 1;
        if (waitingForKey && !key) return;
        waitingForKey = false;
        const timestamp = Number(new DataView(bytes.buffer, 1, 8).getBigInt64(0, true));
        decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data: bytes.subarray(9) }));
        setStatus("");
      };
      ws.onclose = () => {
        if (closed) return;
        setStatus((s) => s || "Reconnecting…");
        retry = setTimeout(connect, 3000);
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(rebuild);
      document.removeEventListener("visibilitychange", onVisibility);
      ws?.close();
      closeDecoder();
      if (lastUrl) URL.revokeObjectURL(lastUrl);
    };
  }, [printerId]);

  return (
    <div className="camera-view">
      {kind === "jpeg" ? (
        <img ref={imgRef} alt="Camera" />
      ) : (
        <canvas ref={canvasRef} width={1280} height={720} />
      )}
      {status && <div className="camera-status">{status}</div>}
    </div>
  );
}
