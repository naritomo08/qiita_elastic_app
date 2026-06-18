defmodule QiitaSearchBackend.Application do
  use Application

  @impl true
  def start(_type, _args) do
    port =
      System.get_env("BACKEND_PORT", "5021")
      |> String.to_integer()

    children = [
      {Plug.Cowboy,
       scheme: :http,
       plug: QiitaSearchBackend.Router,
       options: [ip: {0, 0, 0, 0}, port: port]}
    ]

    Supervisor.start_link(children,
      strategy: :one_for_one,
      name: QiitaSearchBackend.Supervisor
    )
  end
end
