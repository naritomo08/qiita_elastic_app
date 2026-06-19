require "json"
require "cgi"
require "ipaddr"
require "net/http"
require "resolv"
require "uri"
require "webrick"

class ApiError < StandardError
  attr_reader :status

  def initialize(status, message)
    @status = status
    super(message)
  end
end

class Backend
  MAX_PREVIEW_BYTES = 1_000_000

  def initialize
    @es_url = ENV.fetch("ES_URL", "http://elastic1:9200").sub(%r{/$}, "")
    @index = ENV.fetch("ES_INDEX", "qiita-articles")
    @allowed_origins = ENV.fetch(
      "CORS_ORIGINS",
      "http://localhost:8082,http://127.0.0.1:8082"
    ).split(",").map(&:strip)
  end

  def call(request, response)
    add_cors(request, response)
    if request.request_method == "OPTIONS"
      response.status = 204
      return
    end

    payload, status = route(request)
    json(response, status, payload)
  rescue ApiError => error
    json(response, error.status, { error: error.message })
  rescue StandardError => error
    warn error.full_message
    json(response, 500, { error: "サーバー内部でエラーが発生しました。" })
  end

  private

  def route(request)
    case request.path
    when "/health"
      [{ status: "ok", backend: "ruby" }, 200]
    when "/health/elasticsearch"
      elasticsearch_health
    when "/api/recent"
      recent(request)
    when "/api/search"
      search(request)
    when "/api/articles"
      articles(request)
    when "/api/link-preview"
      [link_preview(request.query["url"].to_s.strip), 200]
    else
      if request.path.start_with?("/api/articles/")
        article(CGI.unescape(request.path.delete_prefix("/api/articles/")))
      else
        [{ error: "Not found" }, 404]
      end
    end
  end

  def recent(request)
    size = positive_int(request.query["size"], 10, 100)
    tag = request.query["tag"].to_s.strip
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
    response = es_search(
      query: query,
      sort: [{ updated_at: { order: "desc", unmapped_type: "date" } }],
      size: size
    )
    _, results = parse_hits(response)
    [{ total: results.length, results: results }, 200]
  end

  def elasticsearch_health
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

  def search(request)
    query = request.query["q"].to_s.strip
    raise ApiError.new(400, "検索キーワード q を指定してください。") if query.empty?

    page = positive_int(request.query["page"], 1)
    size = positive_int(request.query["size"], 10, 100)
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
    [{ total: total, page: page, size: size, results: results }, 200]
  end

  def articles(request)
    page = positive_int(request.query["page"], 1)
    size = positive_int(request.query["size"], 20, 100)
    response = es_search(
      query: { match_all: {} },
      sort: [{ created_at: { order: "desc", unmapped_type: "date" } }],
      from: (page - 1) * size,
      size: size
    )
    total, results = parse_hits(response)
    [{ total: total, page: page, size: size, results: results }, 200]
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

    [source.merge("id" => response["_id"]), 200]
  rescue Errno::ECONNREFUSED, SocketError, Net::OpenTimeout, Net::ReadTimeout
    raise ApiError.new(503, "Elasticsearch に接続できませんでした。接続先を確認してください。")
  end

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

  def link_preview(raw_url)
    current = validate_public_url(raw_url)
    4.times do
      request = Net::HTTP::Get.new(current)
      request["User-Agent"] = "Mozilla/5.0 (compatible; QiitaSearchLinkPreview/1.0)"
      request["Accept"] = "text/html,application/xhtml+xml"
      response = Net::HTTP.start(
        current.host, current.port,
        use_ssl: current.scheme == "https",
        open_timeout: 3,
        read_timeout: 5
      ) { |http| http.request(request) }

      if response.is_a?(Net::HTTPRedirection) && response["location"]
        current = validate_public_url(URI.join(current.to_s, response["location"]).to_s)
        next
      end
      raise ApiError.new(502, "リンク先の情報を取得できませんでした。") unless response.is_a?(Net::HTTPSuccess)

      content_type = response["content-type"].to_s.downcase
      unless content_type.include?("text/html") || content_type.include?("application/xhtml+xml")
        raise ApiError.new(400, "HTMLページではないためプレビューできません。")
      end
      document = response.body.byteslice(0, MAX_PREVIEW_BYTES).to_s
      title = first_non_empty(meta(document, "property", "og:title"), title_tag(document), current.host)
      description = first_non_empty(meta(document, "property", "og:description"), meta(document, "name", "description"))
      image = absolute_http_url(meta(document, "property", "og:image"), current)
      site_name = first_non_empty(meta(document, "property", "og:site_name"), current.host)
      return {
        url: current.to_s,
        title: title.each_char.take(300).join,
        description: description.each_char.take(500).join,
        image: image,
        site_name: site_name.each_char.take(100).join
      }
    end
    raise ApiError.new(502, "リンク先の情報を取得できませんでした。")
  rescue SocketError
    raise ApiError.new(400, "リンク先のホストを解決できません。")
  rescue Net::OpenTimeout, Net::ReadTimeout, Errno::ECONNREFUSED
    raise ApiError.new(502, "リンク先の情報を取得できませんでした。")
  end

  def validate_public_url(raw)
    uri = URI(raw)
    unless %w[http https].include?(uri.scheme) && uri.host
      raise ApiError.new(400, "http または https のURLを指定してください。")
    end
    raise ApiError.new(400, "認証情報を含むURLはプレビューできません。") if uri.user || uri.password

    addresses = Resolv.getaddresses(uri.host)
    raise ApiError.new(400, "リンク先のホストを解決できません。") if addresses.empty?
    addresses.each do |address|
      ip = IPAddr.new(address)
      unless ip.ipv4? || ip.ipv6?
        raise ApiError.new(400, "リンク先のホストを解決できません。")
      end
      if ip.private? || ip.loopback? || ip.link_local? || ip.to_s == "0.0.0.0" || ip.to_s == "::"
        raise ApiError.new(400, "ローカルネットワークのURLはプレビューできません。")
      end
    end
    uri
  rescue URI::InvalidURIError
    raise ApiError.new(400, "http または https のURLを指定してください。")
  end

  def meta(document, attribute, value)
    quoted = Regexp.escape(value)
    patterns = [
      /<meta[^>]+#{attribute}=["']#{quoted}["'][^>]+content=["']([^"']*)["'][^>]*>/im,
      /<meta[^>]+content=["']([^"']*)["'][^>]+#{attribute}=["']#{quoted}["'][^>]*>/im
    ]
    patterns.each do |pattern|
      match = document.match(pattern)
      return CGI.unescapeHTML(match[1]).strip if match
    end
    ""
  end

  def title_tag(document)
    match = document.match(/<title[^>]*>(.*?)<\/title>/im)
    match ? CGI.unescapeHTML(match[1].gsub(/<[^>]+>/, "")).strip : ""
  end

  def absolute_http_url(value, base)
    return "" if value.empty?
    resolved = URI.join(base.to_s, value)
    %w[http https].include?(resolved.scheme) ? resolved.to_s : ""
  rescue URI::InvalidURIError
    ""
  end

  def add_cors(request, response)
    origin = request["Origin"]
    if origin && @allowed_origins.include?(origin)
      response["Access-Control-Allow-Origin"] = origin
      response["Vary"] = "Origin"
    end
    response["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    response["Access-Control-Allow-Headers"] = "Content-Type"
  end

  def json(response, status, payload)
    response.status = status
    response["Content-Type"] = "application/json; charset=utf-8"
    response.body = JSON.generate(payload)
  end

  def positive_int(value, default, maximum = nil)
    parsed = Integer(value || "", exception: false)
    parsed = default unless parsed&.positive?
    maximum ? [parsed, maximum].min : parsed
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

  def first_non_empty(*values)
    values.find { |value| !value.to_s.empty? }.to_s
  end
end

backend = Backend.new
server = WEBrick::HTTPServer.new(
  Port: ENV.fetch("BACKEND_PORT", "5025").to_i,
  BindAddress: ENV.fetch("BACKEND_HOST", "0.0.0.0"),
  AccessLog: [],
  Logger: WEBrick::Log.new($stderr, WEBrick::Log::INFO)
)
server.mount_proc("/") { |request, response| backend.call(request, response) }
trap("INT") { server.shutdown }
trap("TERM") { server.shutdown }
server.start
