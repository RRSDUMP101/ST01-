"""Certificates for the mobile app (HTTPS on the local network).

A phone opens the camera only for a page on HTTPS, so the program serves its mobile app over HTTPS with
certificates made on this PC:
    ca.pem / ca.key          ใบรับรองหลักของเครื่องนี้ (local CA, 10 years) - installed once on each phone
    server.pem / server.key  the certificate of the server, signed by the CA, for the IP addresses of the PC
                             (made again when the IP changes or it is near its end; the phones keep trusting
                             it because they trust the CA)
The CA key never leaves the PC (kept readable by this user only): anyone with it could make certificates the
phones trust.
"""

from __future__ import annotations

import ipaddress
import os
import plistlib
import socket
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

CA_DAYS = 3650
SERVER_DAYS = 397  # phones refuse server certificates valid for too long
RENEW_DAYS = 30
CA_NAME = "RRS Part List Studio Local CA"


def _write(path: Path, data: bytes, secret: bool = False) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    if secret:
        try:
            os.chmod(tmp, 0o600)
        except OSError:  # pragma: no cover - Windows ACLs
            pass
    os.replace(tmp, path)


def _key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _pem_key(key) -> bytes:
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                             serialization.NoEncryption())


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _not_after(cert: x509.Certificate) -> datetime:
    try:
        return cert.not_valid_after_utc
    except AttributeError:  # pragma: no cover - cryptography < 42
        return cert.not_valid_after.replace(tzinfo=timezone.utc)


def ensure_ca(folder: str | Path) -> tuple[x509.Certificate, rsa.RSAPrivateKey]:
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    cert_path, key_path = folder / "ca.pem", folder / "ca.key"
    if cert_path.is_file() and key_path.is_file():
        try:
            cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
            key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
            if _not_after(cert) - _now() > timedelta(days=SERVER_DAYS):
                return cert, key
        except (ValueError, TypeError):
            pass
    key = _key()
    host = socket.gethostname()[:40] or "PC"
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"{CA_NAME} ({host})"),
                      x509.NameAttribute(NameOID.ORGANIZATION_NAME, "RRS")])
    ski = x509.SubjectKeyIdentifier.from_public_key(key.public_key())
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(_now() - timedelta(days=1)).not_valid_after(_now() + timedelta(days=CA_DAYS))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                         crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(ski, critical=False)
            .sign(key, hashes.SHA256()))
    _write(key_path, _pem_key(key), secret=True)
    _write(cert_path, cert.public_bytes(serialization.Encoding.PEM))
    for old in ("server.pem", "server.key"):  # signed by the old CA
        (folder / old).unlink(missing_ok=True)
    return cert, key


def _names(cert: x509.Certificate) -> tuple[set[str], set[str]]:
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return set(), set()
    return {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}, set(san.get_values_for_type(x509.DNSName))


def ensure_server_cert(folder: str | Path, ips: list[str], host: str | None = None) -> tuple[Path, Path]:
    """(certificate chain .pem, key .pem) for these IP addresses (+ 127.0.0.1, localhost, the PC name)."""
    folder = Path(folder)
    ca, ca_key = ensure_ca(folder)
    cert_path, key_path = folder / "server.pem", folder / "server.key"
    host = (host or socket.gethostname() or "").strip().lower()
    want_ips = {str(ipaddress.ip_address(ip)) for ip in [*ips, "127.0.0.1"] if ip}
    want_dns = {"localhost"} | ({host, f"{host.split('.')[0]}.local"} if host else set())
    if cert_path.is_file() and key_path.is_file():
        try:
            cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
            have_ips, have_dns = _names(cert)
            if (want_ips <= have_ips and want_dns <= have_dns and cert.issuer == ca.subject
                    and _not_after(cert) - _now() > timedelta(days=RENEW_DAYS)):
                return cert_path, key_path
        except ValueError:
            pass
    key = _key()
    first = sorted(want_ips - {"127.0.0.1"}) or ["127.0.0.1"]
    names = [x509.IPAddress(ipaddress.ip_address(ip)) for ip in sorted(want_ips)] + \
        [x509.DNSName(d) for d in sorted(want_dns) if d]
    ca_ski = ca.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, first[0]),
                                     x509.NameAttribute(NameOID.ORGANIZATION_NAME, "RRS")]))
            .issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(_now() - timedelta(days=1)).not_valid_after(_now() + timedelta(days=SERVER_DAYS))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=True,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                         crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectAlternativeName(names), critical=False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_subject_key_identifier(ca_ski), critical=False)
            .sign(ca_key, hashes.SHA256()))
    _write(key_path, _pem_key(key), secret=True)
    _write(cert_path, cert.public_bytes(serialization.Encoding.PEM) + ca.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


def ca_der(folder: str | Path) -> bytes:
    cert = ensure_ca(folder)[0]
    return cert.public_bytes(serialization.Encoding.DER)


def ca_pem(folder: str | Path) -> bytes:
    cert = ensure_ca(folder)[0]
    return cert.public_bytes(serialization.Encoding.PEM)


def fingerprint(cert: x509.Certificate) -> str:
    return cert.fingerprint(hashes.SHA256()).hex(":").upper()


def info(folder: str | Path) -> dict:
    """What the PC shows about its certificates."""
    folder = Path(folder)
    out = {"ca": "", "ca_until": "", "ca_fingerprint": "", "server_until": "", "server_ips": []}
    try:
        ca = x509.load_pem_x509_certificate((folder / "ca.pem").read_bytes())
        out.update(ca=ca.subject.rfc4514_string(), ca_until=_not_after(ca).date().isoformat(),
                   ca_fingerprint=fingerprint(ca))
        server = x509.load_pem_x509_certificate((folder / "server.pem").read_bytes())
        out.update(server_until=_not_after(server).date().isoformat(), server_ips=sorted(_names(server)[0]))
    except (OSError, ValueError):
        pass
    return out


def mobileconfig(folder: str | Path) -> bytes:
    """iPhone / iPad profile that installs the CA (Settings → General → VPN & Device Management)."""
    cert = ensure_ca(folder)[0]
    der = cert.public_bytes(serialization.Encoding.DER)
    seed = cert.fingerprint(hashes.SHA256()).hex()
    payload_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"rrs-ca-{seed}")).upper()
    profile_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"rrs-profile-{seed}")).upper()
    data = {
        "PayloadContent": [{
            "PayloadCertificateFileName": "rrs-partlist-ca.cer",
            "PayloadContent": der,
            "PayloadDescription": "ใบรับรองของโปรแกรม RRS Part List Studio บนคอมในโรงงาน ใช้เปิดแอปมือถือแบบปลอดภัย",
            "PayloadDisplayName": cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value,
            "PayloadIdentifier": f"com.rrs.partliststudio.ca.{payload_id}",
            "PayloadType": "com.apple.security.root",
            "PayloadUUID": payload_id,
            "PayloadVersion": 1,
        }],
        "PayloadDescription": "ติดตั้งครั้งเดียว แล้วเปิด ตั้งค่า → ทั่วไป → เกี่ยวกับ → การตั้งค่าความเชื่อถือใบรับรอง → เปิดสวิตช์",
        "PayloadDisplayName": "RRS Part List Studio – ใบรับรองแอปมือถือ",
        "PayloadIdentifier": f"com.rrs.partliststudio.profile.{profile_id}",
        "PayloadOrganization": "RRS",
        "PayloadRemovalDisallowed": False,
        "PayloadType": "Configuration",
        "PayloadUUID": profile_id,
        "PayloadVersion": 1,
    }
    return plistlib.dumps(data, fmt=plistlib.FMT_XML)
