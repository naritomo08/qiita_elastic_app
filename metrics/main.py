from config import PORT
from http_server import Handler, Server


def main():
    with Server(("0.0.0.0", PORT), Handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
