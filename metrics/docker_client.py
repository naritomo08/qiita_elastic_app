import http.client
import json
import socket

from config import DOCKER_SOCKET


class UnixHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(DOCKER_SOCKET)


def docker_get(path):
    connection = UnixHTTPConnection("localhost", timeout=4)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        if response.status != 200:
            raise RuntimeError(f"Docker API returned {response.status}")
        return json.loads(body)
    finally:
        connection.close()


def docker_get_raw(path):
    connection = UnixHTTPConnection("localhost", timeout=4)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()
