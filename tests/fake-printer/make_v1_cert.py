# Make a self-signed X.509 *v1* certificate (no extensions), like the ones
# Bambu printers present. OpenSSL 3 only writes v3, so this assembles the DER
# itself and has `openssl dgst` sign it.
#
#   python3 make_v1_cert.py <key.pem> <common name> <out.pem>
import base64
import datetime
import subprocess
import sys
import tempfile


def der(tag, body):
    n = len(body)
    if n < 0x80:
        length = bytes([n])
    else:
        b = n.to_bytes((n.bit_length() + 7) // 8, "big")
        length = bytes([0x80 | len(b)]) + b
    return bytes([tag]) + length + body


def seq(*items):
    return der(0x30, b"".join(items))


def integer(v):
    b = v.to_bytes((v.bit_length() + 8) // 8 or 1, "big")
    return der(0x02, b)


def utctime(t):
    return der(0x17, t.strftime("%y%m%d%H%M%SZ").encode())


SHA256_RSA = seq(der(0x06, bytes.fromhex("2a864886f70d01010b")), der(0x05, b""))


def name(cn):
    attr = seq(der(0x06, bytes.fromhex("550403")), der(0x0C, cn.encode()))
    return seq(der(0x31, attr))


def main():
    key, cn, out = sys.argv[1:4]
    spki = subprocess.run(["openssl", "pkey", "-in", key, "-pubout", "-outform", "DER"],
                          check=True, capture_output=True).stdout
    now = datetime.datetime.now(datetime.timezone.utc)
    tbs = seq(
        integer(int.from_bytes(__import__("os").urandom(8), "big")),  # serial; no version field = v1
        SHA256_RSA,
        name(cn),
        seq(utctime(now - datetime.timedelta(days=1)), utctime(now + datetime.timedelta(days=3650))),
        name(cn),
        spki,
    )
    with tempfile.NamedTemporaryFile() as f:
        f.write(tbs)
        f.flush()
        sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key, f.name],
                             check=True, capture_output=True).stdout
    cert = seq(tbs, SHA256_RSA, der(0x03, b"\x00" + sig))
    b64 = base64.encodebytes(cert).decode().replace("\n", "")
    lines = [b64[i:i + 64] for i in range(0, len(b64), 64)]
    with open(out, "w") as f:
        f.write("-----BEGIN CERTIFICATE-----\n" + "\n".join(lines) + "\n-----END CERTIFICATE-----\n")


main()
