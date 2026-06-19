defmodule QiitaSearchBackend.Router do
  use Plug.Router

  alias QiitaSearchBackend.Elasticsearch
  alias QiitaSearchBackend.LinkPreview

  plug :match
  plug :cors
  plug Plug.Parsers, parsers: [:urlencoded, :json], json_decoder: Jason
  plug :dispatch

  get "/health" do
    json(conn, 200, %{"status" => "ok", "backend" => "elixir"})
  end

  get "/health/elasticsearch" do
    case Elasticsearch.health() do
      {:ok, result} -> json(conn, 200, result)
      {:error, status, result} -> json(conn, status, result)
    end
  end

  get "/api/recent" do
    size = positive_int(conn.params["size"], 10, 100)
    tag = String.trim(conn.params["tag"] || "")

    case Elasticsearch.recent(size, tag) do
      {:ok, results} -> json(conn, 200, %{"total" => length(results), "results" => results})
      error -> error(conn, error)
    end
  end

  get "/api/search" do
    query = String.trim(conn.params["q"] || "")

    if query == "" do
      json(conn, 400, %{"error" => "検索キーワード q を指定してください。"})
    else
      page = positive_int(conn.params["page"], 1)
      size = positive_int(conn.params["size"], 10, 100)

      case Elasticsearch.search_articles(query, page, size) do
        {:ok, result} -> json(conn, 200, result)
        error -> error(conn, error)
      end
    end
  end

  get "/api/articles" do
    page = positive_int(conn.params["page"], 1)
    size = positive_int(conn.params["size"], 20, 100)

    case Elasticsearch.list(page, size) do
      {:ok, result} -> json(conn, 200, result)
      error -> error(conn, error)
    end
  end

  get "/api/articles/:article_id" do
    case Elasticsearch.get_article(article_id) do
      {:ok, article} -> json(conn, 200, article)
      error -> error(conn, error)
    end
  end

  get "/api/link-preview" do
    case LinkPreview.fetch(conn.params["url"] || "") do
      {:ok, preview} -> json(conn, 200, preview)
      error -> error(conn, error)
    end
  end

  options _ do
    send_resp(conn, 204, "")
  end

  match _ do
    json(conn, 404, %{"error" => "Not found"})
  end

  defp cors(conn, _opts) do
    allowed =
      System.get_env(
        "CORS_ORIGINS",
        "http://localhost:8082,http://127.0.0.1:8082"
      )
      |> String.split(",", trim: true)
      |> Enum.map(&String.trim/1)

    origin = get_req_header(conn, "origin") |> List.first()

    conn
    |> maybe_put_origin(origin, allowed)
    |> put_resp_header("access-control-allow-methods", "GET, OPTIONS")
    |> put_resp_header("access-control-allow-headers", "Content-Type")
  end

  defp maybe_put_origin(conn, origin, allowed) do
    if origin && origin in allowed do
      conn
      |> put_resp_header("access-control-allow-origin", origin)
      |> put_resp_header("vary", "Origin")
    else
      conn
    end
  end

  defp positive_int(value, default, max \\ nil) do
    parsed =
      case Integer.parse(value || "") do
        {number, ""} when number > 0 -> number
        _ -> default
      end

    if max, do: min(parsed, max), else: parsed
  end

  defp error(conn, {:error, status, message}), do: json(conn, status, %{"error" => message})

  defp json(conn, status, payload) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(payload))
  end
end
