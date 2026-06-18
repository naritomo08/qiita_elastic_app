import ipaddress
import re
import socket
import time
from threading import Lock
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup


_cache: dict[str, tuple[float, dict[str, str]]] = {}
_cache_lock = Lock()
_cache_seconds = 60 * 60
_max_bytes = 1_000_000
_max_redirects = 3


def get_link_preview(target_url: str) -> dict[str, str]:
    normalized_url = _validate_public_url(target_url)
    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(normalized_url)
        if cached and now - cached[0] < _cache_seconds:
            return cached[1]

    response = _fetch_public_html(normalized_url)
    soup = BeautifulSoup(response.text, "html.parser")
    final_url = response.url
    title = _meta_content(soup, "property", "og:title")
    if not title and soup.title and soup.title.string:
        title = soup.title.string.strip()
    description = (
        _meta_content(soup, "property", "og:description")
        or _meta_content(soup, "name", "description")
    )
    image = _meta_content(soup, "property", "og:image")
    if image:
        image = urljoin(final_url, image)
        if urlparse(image).scheme not in {"http", "https"}:
            image = ""

    preview = {
        "url": final_url,
        "title": (title or urlparse(final_url).netloc)[:300],
        "description": (description or "")[:500],
        "image": image,
        "site_name": (
            _meta_content(soup, "property", "og:site_name")
            or urlparse(final_url).netloc
        )[:100],
    }
    with _cache_lock:
        _cache[normalized_url] = (now, preview)
    return preview


def _fetch_public_html(target_url: str) -> requests.Response:
    session = requests.Session()
    session.trust_env = False
    current_url = target_url
    for _ in range(_max_redirects + 1):
        current_url = _validate_public_url(current_url)
        response = session.get(
            current_url,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; QiitaSearchLinkPreview/1.0)",
                "Accept": "text/html,application/xhtml+xml",
            },
            timeout=(3, 5),
            allow_redirects=False,
            stream=True,
        )
        if response.is_redirect or response.is_permanent_redirect:
            location = response.headers.get("location")
            response.close()
            if not location:
                raise requests.RequestException("Redirect without Location")
            current_url = urljoin(current_url, location)
            continue

        response.raise_for_status()
        content_type = response.headers.get("content-type", "").lower()
        if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
            response.close()
            raise ValueError("HTMLページではないためプレビューできません。")
        chunks = []
        total = 0
        for chunk in response.iter_content(chunk_size=16_384):
            total += len(chunk)
            if total > _max_bytes:
                break
            chunks.append(chunk)
        response._content = b"".join(chunks)
        response.encoding = response.encoding or "utf-8"
        response.url = current_url
        return response
    raise requests.TooManyRedirects("Too many redirects")


def _validate_public_url(target_url: str) -> str:
    parsed = urlparse(target_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("http または https のURLを指定してください。")
    if parsed.username or parsed.password:
        raise ValueError("認証情報を含むURLはプレビューできません。")
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(
                parsed.hostname,
                parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        }
    except socket.gaierror as exc:
        raise ValueError("リンク先のホストを解決できません。") from exc
    for address in addresses:
        if not ipaddress.ip_address(address).is_global:
            raise ValueError("ローカルネットワークのURLはプレビューできません。")
    return parsed.geturl()


def _meta_content(soup: BeautifulSoup, attribute: str, value: str) -> str:
    tag = soup.find("meta", attrs={attribute: re.compile(f"^{re.escape(value)}$", re.I)})
    if tag:
        content = tag.get("content")
        if isinstance(content, str):
            return content.strip()
    return ""
