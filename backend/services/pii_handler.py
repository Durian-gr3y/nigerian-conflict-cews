"""
Nigeria CEWS - PII Encryption & Vault Service
==============================================
Handles all Personally Identifiable Information using:
  - AES-256-GCM  for encryption   (via cryptography library)
  - HMAC-SHA256  for hashing/deduplication

Environment variables required
-------------------------------
CEWS_PII_AES_KEY  : 32-byte base64-encoded AES key
                    Generate: python -c "import secrets,base64; print(base64.b64encode(secrets.token_bytes(32)).decode())"
CEWS_HMAC_SALT    : 32-byte base64-encoded HMAC secret
                    Generate: python -c "import secrets,base64; print(base64.b64encode(secrets.token_bytes(32)).decode())"

IMPORTANT: Store these in a secrets manager (Vault / AWS Secrets Manager).
           Never commit them to source control.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import logging
import os
import struct
import uuid
from typing import Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy.ext.asyncio import AsyncSession

try:
    from models.database import ReporterPIIVault
except ImportError:
    from backend.models.database import ReporterPIIVault

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Key loading
# ---------------------------------------------------------------------------

_AES_KEY_B64: str = os.environ.get("CEWS_PII_AES_KEY", "")
_HMAC_SALT_B64: str = os.environ.get("CEWS_HMAC_SALT", "")


def _load_aes_key() -> bytes:
    """Return the 32-byte AES key, decoded from the environment variable."""
    if not _AES_KEY_B64:
        raise EnvironmentError(
            "CEWS_PII_AES_KEY environment variable is not set. "
            "Generate a key with: python -c \"import secrets,base64; "
            "print(base64.b64encode(secrets.token_bytes(32)).decode())\""
        )
    key = base64.b64decode(_AES_KEY_B64)
    if len(key) != 32:
        raise ValueError(
            f"CEWS_PII_AES_KEY must decode to exactly 32 bytes, got {len(key)}."
        )
    return key


def _load_hmac_salt() -> bytes:
    """Return the HMAC salt bytes, decoded from the environment variable."""
    if not _HMAC_SALT_B64:
        raise EnvironmentError(
            "CEWS_HMAC_SALT environment variable is not set. "
            "Generate a key with: python -c \"import secrets,base64; "
            "print(base64.b64encode(secrets.token_bytes(32)).decode())\""
        )
    return base64.b64decode(_HMAC_SALT_B64)


# ---------------------------------------------------------------------------
# Ciphertext wire format
# ---------------------------------------------------------------------------
# Layout (all big-endian):
#   [ version:1 | nonce_len:1 | nonce:12 | tag:16 | ciphertext:N ]
#
# version = 0x01
# nonce_len = 12  (96-bit GCM nonce)
# tag is appended by AESGCM.encrypt() as the last 16 bytes of the returned blob.

_FORMAT_VERSION: int = 0x01
_NONCE_LEN: int = 12   # bytes — AES-GCM standard recommendation
_TAG_LEN: int = 16     # bytes — GCM authentication tag
_HEADER_LEN: int = 2   # version(1) + nonce_len(1)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def hash_phone(phone_e164: str) -> str:
    """
    Return an HMAC-SHA256 hex digest of a phone number in E.164 format.

    Used for deduplication without storing the plaintext number.

    Args:
        phone_e164: Phone number string in E.164 format, e.g. "+2348012345678".

    Returns:
        64-character lowercase hex digest.

    Raises:
        ValueError:       If the input is empty or obviously malformed.
        EnvironmentError: If CEWS_HMAC_SALT is not configured.
    """
    phone_e164 = phone_e164.strip()
    if not phone_e164.startswith("+") or not phone_e164[1:].isdigit():
        raise ValueError(
            f"phone_e164 must be in E.164 format (e.g. +2348012345678), got: {phone_e164!r}"
        )
    salt = _load_hmac_salt()
    digest = hmac.new(salt, phone_e164.encode("utf-8"), hashlib.sha256).hexdigest()
    return digest


def hash_ip_subnet(ip_str: str) -> str:
    """
    Return an HMAC-SHA256 hex digest of the /24 (IPv4) or /48 (IPv6) subnet.

    Stored as ``ip_subnet_hash`` on ReporterPIIVault for coordinated-flood
    detection without retaining individual IPs.

    Args:
        ip_str: IPv4 or IPv6 address string.

    Returns:
        64-character lowercase hex digest of the network prefix.

    Raises:
        ValueError:       If ip_str is not a valid IP address.
        EnvironmentError: If CEWS_HMAC_SALT is not configured.
    """
    try:
        ip_obj = ipaddress.ip_address(ip_str)
    except ValueError as exc:
        raise ValueError(f"Invalid IP address: {ip_str!r}") from exc

    if ip_obj.version == 4:
        network = ipaddress.ip_network(f"{ip_str}/24", strict=False)
    else:
        network = ipaddress.ip_network(f"{ip_str}/48", strict=False)

    subnet_str = str(network.network_address)
    salt = _load_hmac_salt()
    digest = hmac.new(salt, subnet_str.encode("utf-8"), hashlib.sha256).hexdigest()
    return digest


def encrypt_pii(plaintext: str) -> bytes:
    """
    Encrypt a plaintext string using AES-256-GCM.

    A fresh 96-bit nonce is generated for every call.
    The returned blob includes a version header so future key-rotation
    schemes can identify the algorithm used.

    Wire format:
        [0x01][0x0C][<12-byte nonce>][<16-byte GCM tag><ciphertext>]

    Args:
        plaintext: UTF-8 string to encrypt.

    Returns:
        Binary blob (bytes) safe to store in a BYTEA / LargeBinary column.

    Raises:
        EnvironmentError: If CEWS_PII_AES_KEY is not configured.
    """
    key = _load_aes_key()
    nonce = os.urandom(_NONCE_LEN)
    aesgcm = AESGCM(key)
    # encrypt() returns ciphertext || tag (tag appended as last 16 bytes)
    ct_with_tag = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), associated_data=None)
    header = struct.pack("BB", _FORMAT_VERSION, _NONCE_LEN)
    return header + nonce + ct_with_tag


def decrypt_pii(ciphertext_blob: bytes) -> str:
    """
    Decrypt a blob produced by ``encrypt_pii``.

    Args:
        ciphertext_blob: Raw bytes from the database column.

    Returns:
        The original UTF-8 plaintext string.

    Raises:
        ValueError:           If the blob header is invalid or truncated.
        cryptography.exceptions.InvalidTag: If authentication fails (tampered data).
        EnvironmentError:     If CEWS_PII_AES_KEY is not configured.
    """
    if len(ciphertext_blob) < _HEADER_LEN + _NONCE_LEN + _TAG_LEN + 1:
        raise ValueError("Ciphertext blob is too short to be valid.")

    version, nonce_len = struct.unpack_from("BB", ciphertext_blob, 0)
    if version != _FORMAT_VERSION:
        raise ValueError(
            f"Unsupported ciphertext version: 0x{version:02X}. "
            f"Expected 0x{_FORMAT_VERSION:02X}."
        )
    if nonce_len != _NONCE_LEN:
        raise ValueError(
            f"Unexpected nonce length in header: {nonce_len}. Expected {_NONCE_LEN}."
        )

    offset = _HEADER_LEN
    nonce = ciphertext_blob[offset: offset + nonce_len]
    ct_with_tag = ciphertext_blob[offset + nonce_len:]

    key = _load_aes_key()
    aesgcm = AESGCM(key)
    try:
        plaintext_bytes = aesgcm.decrypt(nonce, ct_with_tag, associated_data=None)
    except InvalidTag:
        logger.error("AES-GCM authentication tag verification failed — possible data tampering.")
        raise

    return plaintext_bytes.decode("utf-8")


async def create_pii_vault_entry(
    phone: Optional[str],
    ip: Optional[str],
    channel: str,
    db_session: AsyncSession,
) -> uuid.UUID:
    """
    Encrypt PII fields and persist a new ``ReporterPIIVault`` row.

    Returns the ``anon_token`` UUID which should be stored on the
    ``ConflictAlert`` row instead of any raw PII.

    Args:
        phone:      Phone number in E.164 format, or ``None``.
        ip:         Submitter IP address string, or ``None``.
        channel:    Submission channel identifier (e.g. "web", "ussd", "sms").
        db_session: Active SQLAlchemy async session (write transaction expected).

    Returns:
        ``uuid.UUID`` — the newly created ``anon_token``.

    Raises:
        EnvironmentError: If required environment variables are missing.
        ValueError:       If phone or IP is malformed.
    """
    token = uuid.uuid4()

    phone_number_enc: Optional[bytes] = None
    phone_hash: Optional[str] = None
    ip_address_enc: Optional[bytes] = None
    ip_subnet_hash: Optional[str] = None

    if phone:
        phone_number_enc = encrypt_pii(phone)
        phone_hash = hash_phone(phone)

    if ip:
        ip_address_enc = encrypt_pii(ip)
        ip_subnet_hash = hash_ip_subnet(ip)

    vault_entry = ReporterPIIVault(
        anon_token=token,
        phone_number_enc=phone_number_enc,
        ip_address_enc=ip_address_enc,
        phone_hash=phone_hash,
        ip_subnet_hash=ip_subnet_hash,
        submission_channel=channel,
    )

    db_session.add(vault_entry)
    await db_session.flush()  # assigns auto-increment id; caller commits

    logger.info(
        "PII vault entry created",
        extra={"anon_token": str(token), "channel": channel},
    )
    return token


async def retrieve_pii_for_token(
    anon_token: uuid.UUID,
    db_session: AsyncSession,
) -> dict:
    """
    Retrieve and decrypt PII for a given ``anon_token``.

    This function is ACCESS-CONTROLLED — only call it from endpoints
    protected by the ``require_admin_analyst`` dependency.

    Args:
        anon_token: The pseudonymous token stored on ConflictAlert.
        db_session: Active SQLAlchemy async session.

    Returns:
        Dict with keys ``phone``, ``ip``, ``channel`` (values may be ``None``).

    Raises:
        LookupError: If no vault entry matches the token.
    """
    from sqlalchemy import select

    result = await db_session.execute(
        select(ReporterPIIVault).where(ReporterPIIVault.anon_token == anon_token)
    )
    entry: Optional[ReporterPIIVault] = result.scalar_one_or_none()

    if entry is None:
        raise LookupError(f"No PII vault entry found for anon_token={anon_token}")

    phone = decrypt_pii(entry.phone_number_enc) if entry.phone_number_enc else None
    ip = decrypt_pii(entry.ip_address_enc) if entry.ip_address_enc else None

    return {
        "phone": phone,
        "ip": ip,
        "channel": entry.submission_channel,
    }
