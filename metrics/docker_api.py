import http.client
import json
import socket

from config import DOCKER_SOCKET


class UnixHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(DOCKER_SOCKET)


def docker_get(path):
    status, body = docker_get_raw(path)
    if status != 200:
        raise RuntimeError(f"Docker API returned {status}")
    return json.loads(body)


def docker_get_raw(path):
    connection = UnixHTTPConnection("localhost", timeout=4)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def demux_docker_log_stream(data):
    """Split Docker's multiplexed log stream into plain text lines."""
    lines = []
    offset = 0
    while offset + 8 <= len(data):
        size = int.from_bytes(data[offset + 4:offset + 8], "big")
        chunk_start = offset + 8
        chunk_end = chunk_start + size
        lines.extend(
            data[chunk_start:chunk_end]
            .decode("utf-8", errors="replace")
            .splitlines()
        )
        offset = chunk_end
    return lines
