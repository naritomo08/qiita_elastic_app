defmodule QiitaSearchBackend.LinkPreview do
  @moduledoc false

  def fetch(url) do
    with {:ok, uri} <- validate_url(url),
         {:ok, response} <-
           Req.get(uri,
             receive_timeout: 5_000,
             connect_options: [timeout: 3_000],
             retry: false,
             redirect: false,
             headers: [
               {"user-agent", "Mozilla/5.0 (compatible; QiitaSearchLinkPreview/1.0)"},
               {"accept", "text/html,application/xhtml+xml"}
             ]
           ),
         :ok <- validate_response(response) do
      html = binary_part(response.body, 0, min(byte_size(response.body), 1_000_000))
      final_url = URI.to_string(uri)
      host = uri.host || ""

      {:ok,
       %{
         "url" => final_url,
         "title" => meta(html, "og:title") || title(html) || host,
         "description" => meta(html, "og:description") || meta_name(html, "description") || "",
         "image" => absolute_url(meta(html, "og:image"), uri),
         "site_name" => meta(html, "og:site_name") || host
       }}
    end
  end

  defp validate_url(url) when is_binary(url) do
    uri = URI.parse(String.trim(url))

    cond do
      uri.scheme not in ["http", "https"] or is_nil(uri.host) ->
        {:error, 400, "http または https のURLを指定してください。"}

      uri.userinfo ->
        {:error, 400, "認証情報を含むURLはプレビューできません。"}

      private_host?(uri.host) ->
        {:error, 400, "ローカルネットワークのURLはプレビューできません。"}

      true ->
        {:ok, uri}
    end
  end

  defp validate_response(%{status: 200, body: body, headers: headers}) when is_binary(body) do
    content_type =
      headers
      |> header_value("content-type")

    if String.contains?(content_type, ["text/html", "application/xhtml+xml"]) do
      :ok
    else
      {:error, 400, "HTMLページではないためプレビューできません。"}
    end
  end

  defp validate_response(_), do: {:error, 502, "リンク先の情報を取得できませんでした。"}

  defp header_value(headers, key) when is_map(headers) do
    headers
    |> Map.get(key, [])
    |> List.wrap()
    |> List.first()
    |> to_string()
  end

  defp header_value(headers, key) when is_list(headers) do
    headers
    |> Enum.find_value("", fn
      {header_key, value} ->
        if String.downcase(to_string(header_key)) == key do
          value |> List.wrap() |> List.first() |> to_string()
        end

      _ ->
        nil
    end)
  end

  defp private_host?(host) do
    case :inet.getaddrs(String.to_charlist(host), :inet) do
      {:ok, addresses} -> Enum.any?(addresses, &private_ipv4?/1)
      {:error, _} -> true
    end
  end

  defp private_ipv4?({10, _, _, _}), do: true
  defp private_ipv4?({127, _, _, _}), do: true
  defp private_ipv4?({169, 254, _, _}), do: true
  defp private_ipv4?({172, second, _, _}) when second in 16..31, do: true
  defp private_ipv4?({192, 168, _, _}), do: true
  defp private_ipv4?({0, _, _, _}), do: true
  defp private_ipv4?(_), do: false

  defp meta(html, property) do
    patterns = [
      ~r/<meta[^>]+property=["']#{Regex.escape(property)}["'][^>]+content=["']([^"']*)["'][^>]*>/i,
      ~r/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']#{Regex.escape(property)}["'][^>]*>/i
    ]

    capture_first(html, patterns)
  end

  defp meta_name(html, name) do
    patterns = [
      ~r/<meta[^>]+name=["']#{Regex.escape(name)}["'][^>]+content=["']([^"']*)["'][^>]*>/i,
      ~r/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']#{Regex.escape(name)}["'][^>]*>/i
    ]

    capture_first(html, patterns)
  end

  defp title(html), do: capture_first(html, [~r/<title[^>]*>(.*?)<\/title>/is])

  defp capture_first(html, patterns) do
    Enum.find_value(patterns, fn pattern ->
      case Regex.run(pattern, html, capture: :all_but_first) do
        [value] -> value |> decode_entities() |> String.trim()
        _ -> nil
      end
    end)
  end

  defp absolute_url(nil, _uri), do: ""

  defp absolute_url(value, uri) do
    case URI.parse(value) do
      %URI{scheme: scheme} when scheme in ["http", "https"] -> value
      parsed -> URI.merge(uri, parsed) |> URI.to_string()
    end
  rescue
    _ -> ""
  end

  defp decode_entities(value) do
    value
    |> String.replace("&amp;", "&")
    |> String.replace("&quot;", "\"")
    |> String.replace("&#39;", "'")
    |> String.replace("&lt;", "<")
    |> String.replace("&gt;", ">")
  end
end
