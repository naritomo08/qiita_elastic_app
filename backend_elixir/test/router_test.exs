defmodule QiitaSearchBackend.RouterTest do
  use ExUnit.Case, async: true
  use Plug.Test

  alias QiitaSearchBackend.Router

  test "health endpoint identifies Elixir backend" do
    conn = conn(:get, "/health") |> Router.call([])
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"status" => "ok", "backend" => "elixir"}
  end

  test "search requires a query" do
    conn = conn(:get, "/api/search") |> Router.call([])
    assert conn.status == 400
  end

  test "local link previews are rejected" do
    conn =
      conn(:get, "/api/link-preview?url=http://127.0.0.1/private")
      |> Router.call([])

    assert conn.status == 400
  end
end
