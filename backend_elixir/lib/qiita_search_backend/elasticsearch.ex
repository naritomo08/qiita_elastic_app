defmodule QiitaSearchBackend.Elasticsearch do
  @moduledoc false

  def health do
    started_at = System.monotonic_time(:millisecond)

    case Req.get(es_url(), receive_timeout: 3_000, retry: false) do
      {:ok, %{status: 200, body: body}} when is_map(body) ->
        {:ok,
         %{
           "status" => "ok",
           "service" => "elasticsearch",
           "checked_by" => "elixir",
           "latency_ms" => elapsed_ms(started_at),
           "cluster_name" => Map.get(body, "cluster_name", ""),
           "version" => get_in(body, ["version", "number"]) || ""
         }}

      _ ->
        {:error, 503,
         %{
           "status" => "error",
           "service" => "elasticsearch",
           "checked_by" => "elixir",
           "latency_ms" => elapsed_ms(started_at),
           "error" => "Elasticsearch に接続できませんでした。"
         }}
    end
  end

  def recent(size, tag) do
    query =
      if tag == "" do
        %{"match_all" => %{}}
      else
        %{
          "bool" => %{
            "should" => [
              %{"term" => %{"tags.keyword" => tag}},
              %{"match_phrase" => %{"tags" => tag}}
            ],
            "minimum_should_match" => 1
          }
        }
      end

    sort_field = if tag == "", do: "updated_at", else: "created_at"

    search(%{
      "query" => query,
      "sort" => [%{sort_field => %{"order" => "desc", "unmapped_type" => "date"}}],
      "size" => size
    })
    |> parse_results()
  end

  def list(page, size) do
    with {:ok, response} <-
           search(%{
             "query" => %{"match_all" => %{}},
             "sort" => [
               %{"created_at" => %{"order" => "desc", "unmapped_type" => "date"}}
             ],
             "from" => (page - 1) * size,
             "size" => size
           }),
         {:ok, total, results} <- parse_search_response(response) do
      {:ok, %{"total" => total, "page" => page, "size" => size, "results" => results}}
    end
  end

  def search_articles(query, page, size) do
    with {:ok, response} <-
           search(%{
             "query" => %{
               "multi_match" => %{
                 "query" => query,
                 "fields" => ["title^3", "body", "tags^2"]
               }
             },
             "highlight" => %{
               "pre_tags" => ["<mark>"],
               "post_tags" => ["</mark>"],
               "fields" => %{
                 "title" => %{},
                 "body" => %{"fragment_size" => 160, "number_of_fragments" => 3}
               }
             },
             "from" => (page - 1) * size,
             "size" => size
           }),
         {:ok, total, results} <- parse_search_response(response) do
      {:ok, %{"total" => total, "page" => page, "size" => size, "results" => results}}
    end
  end

  def get_article(article_id) do
    url = "#{es_url()}/#{URI.encode(index())}/_doc/#{URI.encode(article_id)}"

    case Req.get(url, receive_timeout: 10_000, retry: false) do
      {:ok, %{status: 200, body: body}} when is_map(body) ->
        case body do
          %{"_id" => id, "_source" => source} when is_map(source) ->
            {:ok, Map.put(source, "id", id)}

          _ ->
            {:error, 502, "Elasticsearch から想定外の記事データが返されました。"}
        end

      {:ok, %{status: 404, body: body}} ->
        if error_type(body) == "index_not_found_exception" do
          {:error, 404, "Elasticsearch インデックス「#{index()}」が見つかりません。"}
        else
          {:error, 404, "指定された記事は見つかりませんでした。"}
        end

      {:ok, %{status: status}} ->
        {:error, map_status(status), "Elasticsearch から記事を取得できませんでした。"}

      {:error, _} ->
        {:error, 503, "Elasticsearch に接続できませんでした。接続先を確認してください。"}
    end
  end

  defp search(body) do
    url = "#{es_url()}/#{URI.encode(index())}/_search"

    case Req.post(url, json: body, receive_timeout: 10_000, retry: false) do
      {:ok, %{status: 200, body: response}} when is_map(response) ->
        {:ok, response}

      {:ok, %{status: 404, body: response}} ->
        if error_type(response) == "index_not_found_exception" do
          {:error, 404, "Elasticsearch インデックス「#{index()}」が見つかりません。"}
        else
          {:error, 404, "Elasticsearch で検索を実行できませんでした。"}
        end

      {:ok, %{status: status}} ->
        {:error, map_status(status), "Elasticsearch で検索を実行できませんでした。"}

      {:error, _} ->
        {:error, 503, "Elasticsearch に接続できませんでした。接続先を確認してください。"}
    end
  end

  defp parse_results({:ok, response}) do
    with {:ok, _total, results} <- parse_search_response(response) do
      {:ok, results}
    end
  end

  defp parse_results(error), do: error

  defp parse_search_response(%{"hits" => %{"total" => total, "hits" => hits}})
       when is_list(hits) do
    total_value = if is_map(total), do: Map.get(total, "value", 0), else: total

    results =
      Enum.map(hits, fn hit ->
        source = Map.get(hit, "_source", %{})

        source
        |> Map.put("id", Map.get(hit, "_id"))
        |> Map.put("_score", Map.get(hit, "_score"))
        |> Map.put("highlight", Map.get(hit, "highlight", %{}))
      end)

    {:ok, total_value, results}
  end

  defp parse_search_response(_),
    do: {:error, 502, "Elasticsearch から想定外の検索結果が返されました。"}

  defp error_type(%{"error" => %{"type" => type}}), do: type
  defp error_type(_), do: nil

  defp map_status(status) when status >= 500, do: 502
  defp map_status(_), do: 500
  defp elapsed_ms(started_at), do: System.monotonic_time(:millisecond) - started_at

  defp es_url, do: System.get_env("ES_URL", "http://elastic1:9200") |> String.trim_trailing("/")
  defp index, do: System.get_env("ES_INDEX", "qiita-articles")
end
