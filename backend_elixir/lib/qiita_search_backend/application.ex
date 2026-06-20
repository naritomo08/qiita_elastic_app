defmodule QiitaSearchBackend.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Plug.Cowboy,
       scheme: :http,
       plug: QiitaSearchBackend.Router,
       options: [ip: {0, 0, 0, 0}, port: 5000]}
    ]

    Supervisor.start_link(children,
      strategy: :one_for_one,
      name: QiitaSearchBackend.Supervisor
    )
  end
end
