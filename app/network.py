"""
VisionX - Network & Tunnel Client Module
Mengelola pengiriman gambar dan metadata deteksi ke endpoint Cloudflare Tunnel server Flask (HP Termux).
Schema Flask:
- File key: 'image' (multipart/form-data)
- Data key: 'info' (string keterangan/label deteksi)
"""

import os
from typing import Any, Dict, Optional, Union
import cv2
import numpy as np
import requests

from app.config import DEFAULT_ENDPOINT_URL


def prepare_image_payload(
    image: Union[np.ndarray, bytes, str, os.PathLike],
    filename: str = "capture.jpg"
) -> bytes:
    """
    Mengonversi input image (OpenCV numpy array, file path, atau raw bytes)
    menjadi JPEG byte stream siap upload.
    """
    if isinstance(image, np.ndarray):
        success, encoded = cv2.imencode(".jpg", image)
        if not success:
            raise ValueError("Gagal meng-encode frame OpenCV ke format JPEG")
        return encoded.tobytes()

    if isinstance(image, (str, os.PathLike)):
        filepath = str(image)
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"File gambar tidak ditemukan: {filepath}")
        with open(filepath, "rb") as f:
            return f.read()

    if isinstance(image, bytes):
        return image

    raise TypeError(f"Tipe data gambar tidak didukung: {type(image)}")


def upload_image_to_tunnel(
    image: Union[np.ndarray, bytes, str, os.PathLike],
    info: str = "VisionX Frame",
    endpoint_url: Optional[str] = None,
    timeout: float = 10.0,
    headers: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    """
    Mengirimkan gambar dan data info ke server Flask melalui endpoint tunnel.

    Parameters:
        image: Frame numpy array OpenCV, byte stream gambar, atau path ke file gambar.
        info: Keterangan label / data deteksi (dikirim via form field 'info').
        endpoint_url: URL target (default: https://visionx.my.id/api/upload).
        timeout: Waktu tunggu HTTP request dalam detik (default 10s).
        headers: Header HTTP opsional.

    Returns:
        Dict: {
            "success": bool,
            "status_code": int or None,
            "response": dict or str or None,
            "error": str or None
        }
    """
    target_url = endpoint_url or DEFAULT_ENDPOINT_URL

    try:
        image_bytes = prepare_image_payload(image)
    except Exception as exc:
        return {
            "success": False,
            "status_code": None,
            "response": None,
            "error": f"Payload preparation failed: {str(exc)}"
        }

    # Format payload multipart sesuai skema server Flask:
    # - File field: 'image'
    # - Form data field: 'info'
    files = {
        "image": ("image.jpg", image_bytes, "image/jpeg")
    }
    data = {
        "info": str(info)
    }

    req_headers = {
        "User-Agent": "VisionX-Client/1.0"
    }
    if headers:
        req_headers.update(headers)

    try:
        res = requests.post(
            target_url,
            files=files,
            data=data,
            headers=req_headers,
            timeout=timeout
        )

        try:
            body = res.json()
        except ValueError:
            body = res.text

        is_success = 200 <= res.status_code < 300

        return {
            "success": is_success,
            "status_code": res.status_code,
            "response": body,
            "error": None if is_success else f"HTTP Status {res.status_code}: {res.reason}"
        }

    except requests.exceptions.Timeout:
        return {
            "success": False,
            "status_code": None,
            "response": None,
            "error": f"Connection timed out after {timeout} seconds"
        }
    except requests.exceptions.ConnectionError as conn_err:
        return {
            "success": False,
            "status_code": None,
            "response": None,
            "error": f"Connection error: {str(conn_err)}"
        }
    except Exception as exc:
        return {
            "success": False,
            "status_code": None,
            "response": None,
            "error": f"Unexpected error during upload: {str(exc)}"
        }
