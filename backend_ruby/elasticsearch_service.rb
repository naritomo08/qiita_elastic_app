require "cgi"
require "json"
require "net/http"
require_relative "api_error"

class ElasticsearchService
  def initialize(es_url, index)
    @es_url = es_url.sub(%r{/$}, "")
    @index = index
  end

  def health
    started_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    status, response = request_json(:get, @es_url)
    latency = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started_at) * 1000).round
    unless status == 200
      return [{ status: "error", service: "elasticsearch", checked_by: "ruby",
                latency_ms: latency, error: "Elasticsearch に接続できませんでした。" }, 503]
    end
    [{
      status: "ok",
      service: "elasticsearch",
      checked_by: "ruby",
      latency_ms: latency,
      cluster_name: response["cluster_name"].to_s,
      version: response.dig("version", "number").to_s
    }, 200]
  rescue Errno::ECONNREFUSED, SocketError, Net::OpenTimeout, Net::ReadTimeout
    latency = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started_at) * 1000).round
    [{ status: "error", service: "elasticsearch", checked_by: "ruby",
       latency_ms: latency, error: "Elasticsearch に接続できませんでした。" }, 503]
  end

  def recent(size, tag)
    query = if tag.empty?
      { match_all: {} }
    else
      {
        bool: {
          should: [
            { term: { "tags.keyword": tag } },
            { match_phrase: { tags: tag } }
          ],
          minimum_should_match: 1
        }
      }
    end
    sort_field = tag.empty? ? :updated_at : :created_at
    response = es_search(
      query: query,
      sort: [{ sort_field => { order: "desc", unmapped_type: "date" } }],
      size: size
    )
    _, results = parse_hits(response)
    { total: results.length, results: results }
  end

  def search(query, page, size)
    response = es_search(
      query: { multi_match: { query: query, fields: ["title^3", "body", "tags^2"] } },
      highlight: {
        pre_tags: ["<mark>"],
        post_tags: ["</mark>"],
        fields: {
          title: {},
          body: { fragment_size: 160, number_of_fragments: 3 }
        }
      },
      from: (page - 1) * size,
      size: size
    )
    total, results = parse_hits(response)
    { total: total, page: page, size: size, results: results }
  end

  def articles(page, size)
    response = es_search(
      query: { match_all: {} },
      sort: [{ created_at: { order: "desc", unmapped_type: "date" } }],
      from: (page - 1) * size,
      size: size
    )
    total, results = parse_hits(response)
    { total: total, page: page, size: size, results: results }
  end

  def article(id)
    status, response = request_json(:get, "#{@es_url}/#{escape(@index)}/_doc/#{escape(id)}")
    if status == 404
      message = error_type(response) == "index_not_found_exception" \
        ? "Elasticsearch インデックス「#{@index}」が見つかりません。" \
        : "指定された記事は見つかりませんでした。"
      raise ApiError.new(404, message)
    end
    raise ApiError.new(map_es_status(status), "Elasticsearch から記事を取得できませんでした。") unless status == 200

    source = response["_source"]
    raise ApiError.new(502, "Elasticsearch から想定外の記事データが返されました。") unless source.is_a?(Hash)

    source.merge("id" => response["_id"])
  rescue Errno::ECONNREFUSED, SocketError, Net::OpenTimeout, Net::ReadTimeout
    raise ApiError.new(503, "Elasticsearch に接続できませんでした。接続先を確認してください。")
  end

  private

  def es_search(body)
    status, response = request_json(:post, "#{@es_url}/#{escape(@index)}/_search", body)
    if status == 404 && error_type(response) == "index_not_found_exception"
      raise ApiError.new(404, "Elasticsearch インデックス「#{@index}」が見つかりません。")
    end
    raise ApiError.new(map_es_status(status), "Elasticsearch で検索を実行できませんでした。") unless status == 200
    response
  rescue Errno::ECONNREFUSED, SocketError, Net::OpenTimeout, Net::ReadTimeout
    raise ApiError.new(503, "Elasticsearch に接続できませんでした。接続先を確認してください。")
  end

  def request_json(method, endpoint, payload = nil)
    uri = URI(endpoint)
    request = method == :post ? Net::HTTP::Post.new(uri) : Net::HTTP::Get.new(uri)
    request["Content-Type"] = "application/json"
    request.body = JSON.generate(payload) if payload
    response = Net::HTTP.start(
      uri.host, uri.port,
      use_ssl: uri.scheme == "https",
      open_timeout: 3,
      read_timeout: 10
    ) { |http| http.request(request) }
    [response.code.to_i, JSON.parse(response.body)]
  rescue JSON::ParserError
    raise ApiError.new(502, "Elasticsearch から想定外のレスポンスが返されました。")
  end

  def parse_hits(response)
    hits = response["hits"]
    raw_hits = hits.is_a?(Hash) ? hits["hits"] : nil
    raise ApiError.new(502, "Elasticsearch から想定外の検索結果が返されました。") unless raw_hits.is_a?(Array)

    total_value = hits["total"]
    total = total_value.is_a?(Hash) ? total_value["value"].to_i : total_value.to_i
    results = raw_hits.map do |hit|
      source = hit["_source"]
      raise ApiError.new(502, "Elasticsearch から想定外の検索結果が返されました。") unless source.is_a?(Hash)
      source.merge(
        "id" => hit["_id"],
        "_score" => hit["_score"],
        "highlight" => hit.fetch("highlight", {})
      )
    end
    [total, results]
  end

  def error_type(response)
    response["error"].is_a?(Hash) ? response.dig("error", "type").to_s : ""
  end

  def map_es_status(status)
    status >= 500 ? 502 : 500
  end

  def escape(value)
    CGI.escape(value).gsub("+", "%20")
  end
end
