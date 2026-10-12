# Fake A1/P1 camera: JPEG frames over TLS on port 6000 after the 80-byte
# login (access code at bytes 48..80). Frames come from ffmpeg's test pattern.
import socket, ssl, struct, subprocess, threading

CODE = b"12345678"
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("/etc/fake/server.crt", "/etc/fake/server.key")


def frames():
    p = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=2",
         "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "6", "-"],
        stdout=subprocess.PIPE)
    buf = b""
    try:
        while True:
            chunk = p.stdout.read(65536)
            if not chunk:
                return
            buf += chunk
            while True:
                s = buf.find(b"\xff\xd8")
                e = buf.find(b"\xff\xd9", s + 2)
                if s < 0 or e < 0:
                    break
                yield buf[s:e + 2]
                buf = buf[e + 2:]
    finally:
        p.kill()


def handle(conn):
    try:
        c = ctx.wrap_socket(conn, server_side=True)
        login = b""
        while len(login) < 80:
            got = c.recv(80 - len(login))
            if not got:
                return
            login += got
        if login[48:48 + len(CODE)] != CODE:
            print("jpeg6000: wrong access code")
            c.close()
            return
        print("jpeg6000: viewer connected")
        for jpg in frames():
            c.sendall(struct.pack("<IIII", len(jpg), 0, 1, 0) + jpg)
    except Exception as e:
        print("jpeg6000:", e)


srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", 6000))
srv.listen(8)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
